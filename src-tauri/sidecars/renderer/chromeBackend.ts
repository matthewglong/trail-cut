// Chrome rendering backend — the shipped pre-strangle renderer, extracted
// verbatim from index.ts in the Phase 5 backend split. Produces map frames
// headlessly via puppeteer-core driving a full Chrome (new headless mode)
// instance running maplibre-gl-js.
//
// Why full Chrome and not chrome-headless-shell: shell has no GPU path on
// macOS, so WebGL falls back to SwiftShader (software). Maplibre's first
// paint stalls badly on software WebGL — readPixels takes seconds, the GPU
// process can crash, the page tears down mid-evaluate. New headless mode
// (`headless: true` in puppeteer ≥22) routes WebGL through ANGLE→Metal on
// Apple Silicon and avoids the entire failure mode.
//
// Status: kept functional until the native-backend cutover (Matthew's
// sign-off + the cross-engine golden-frame gate). Chrome-for-Testing
// redistribution is the ship forcing-function the native backend retires —
// don't invest here beyond keeping it green.
//
// Process model: one Browser per backend, one Page per browser. Recycle
// closes and reopens the Page (cheap: clears per-page allocations,
// preserves browser state). Every M=10 page-recycles, also relaunch the
// Browser (layered defense against accumulated allocator fragmentation).
// Orchestrator never sees the inner browser-restart — same wire format
// either way.

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { PNG } from 'pngjs';

import type {
  FramePayload,
  RenderedFrame,
  RendererBackend,
  SetupCmd,
} from './backend';
import { VERBOSE, verbose } from './backend';
import { buildStaticScene } from './scene';
import type { TileCache } from './tileCache';
import { fetchUrl } from './fetchUrl';
import { bridgeFetchFactory } from './trailcutFetch';
import { buildBootstrapHtml } from './bootstrap.html';

// Pixel-readback transport. Default = `readpixels` (page-side gl.readPixels
// → base64 → Node base64-decode). Set TRAILCUT_RENDERER_TRANSPORT=png to
// fall back to the original Page.captureScreenshot + pngjs decode path
// (kept as an escape hatch / for parity comparisons). The readpixels path
// skips two encode/decode hops (Chrome PNG encode + pngjs decode) and is
// the highest-leverage perf fix from the chromium-renderer perf review.
const TRANSPORT: 'readpixels' | 'png' =
  process.env.TRAILCUT_RENDERER_TRANSPORT === 'png' ? 'png' : 'readpixels';

// `page.evaluate` callbacks run in the browser context, where `window` and
// our injected globals (__init, __applyFrame, trailcutFetch) live. The
// worker's tsconfig is Node-only; this minimal declaration tells tsc not
// to error on cross-context references inside evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const window: any;

/** Recycle the Browser entirely after this many Page recycles. Layered
 *  defense per docs/export/plans/chromium-renderer.md §2.2; the
 *  orchestrator already issues `recycle` on its own cadence (default 60
 *  frames per task 030), so this counts orchestrator-driven recycles.
 *  10 page recycles ≈ 600 frames between browser restarts at default
 *  cadence — plenty for any single export, near-zero overhead. */
const BROWSER_RESTART_EVERY_RECYCLES = 10;

function chromeBinaryPath(): string {
  const p = process.env.TRAILCUT_CHROME_BIN;
  if (!p) {
    throw new Error(
      'TRAILCUT_CHROME_BIN env var not set. The orchestrator is responsible ' +
      'for resolving the bundled Chrome binary and passing it to the worker; ' +
      'in dev, set it manually to a Chrome executable path (e.g. ' +
      '<repo>/src-tauri/binaries/chrome-<triple>/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing).',
    );
  }
  return p;
}

export class ChromeBackend implements RendererBackend {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private setupPayload: SetupCmd | null = null;
  private recycleCountThisBrowser = 0;

  // Signal-based completion handshake for __init. We can't `await` the
  // Promise returned by `page.evaluate((p) => window.__init(p))` directly
  // because puppeteer's evaluate sets `awaitPromise: true` on the CDP
  // `Runtime.callFunctionOn` call, and V8's Inspector can GC the awaited
  // Promise before it observes resolution under heap pressure (the page is
  // allocating freely while maplibre boots its tile cache, decodes glyphs
  // and sprites through trailcutFetch, builds source/layer state). The
  // failure surfaces as `ProtocolError: Promise was collected` *after*
  // __init has logged its final `done` breadcrumb — proof the page-side
  // function ran fine; only the protocol-level Promise tracking lost it.
  // (When Chrome doesn't notice the GC at all, no response is sent and the
  // symptom is `Runtime.callFunctionOn timed out` after protocolTimeout —
  // same root cause, different observation.)
  //
  // Workaround: have the page kick off __init fire-and-forget (the outer
  // evaluate returns `undefined` synchronously, no awaitPromise needed),
  // then call this exposed function on completion. The backend awaits a
  // local Node-side Promise, which has no V8-GC vulnerability.
  private pendingInitSignal:
    | ((status: { ok: boolean; error?: string }) => void)
    | null = null;

  // Same handshake, applied to __applyFrame. The first __applyFrame call
  // after setup/recycle hits the same heap-pressure window as __init; the
  // handshake removes the failure mode entirely at the cost of one extra
  // CDP round-trip per frame (~1 ms; dwarfed by the ~100 ms render cost).
  private pendingApplyFrameSignal:
    | ((status: {
        ok: boolean;
        result?: { rgbaB64: string | null } | null;
        error?: string;
      }) => void)
    | null = null;

  constructor(private tileCache: TileCache) {}

  private async launchBrowser(): Promise<Browser> {
    // ANGLE backend per platform. On macOS (the only supported host today),
    // Metal is the hardware path; ANGLE routes WebGL through it. On other
    // platforms we let Chrome pick the default — task 130 will revisit when
    // Windows/Linux land.
    const angleArg = process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default';

    const browser = await puppeteer.launch({
      executablePath: chromeBinaryPath(),
      // New headless mode (puppeteer ≥22). Unlike `headless: 'shell'`, this
      // runs full Chrome with GPU access available.
      headless: true,
      args: [
        // Determinism / off-screen rendering.
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu-vsync',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        // Hardware GPU via ANGLE. On Apple Silicon this lights up Metal.
        angleArg,
        // Force enable WebGL for headless. Default in new headless mode is
        // already enabled, but explicit costs nothing.
        '--enable-webgl',
      ],
      // Forward Chrome's own stderr (renderer crash logs, GPU process
      // failures, OOM signals from the OS) into the worker's stderr so the
      // orchestrator's stderr ring captures it. Without this, a renderer-
      // process death surfaces only as the opaque "Promise was collected"
      // ProtocolError that puppeteer raises when its CDP target detaches.
      dumpio: true,
      // Don't time out on launch — slow CI hosts can take a while.
      timeout: 60_000,
      // Per-CDP-command timeout. Cold-start first paint can still take
      // double-digit seconds on the GPU path; 600s gives headroom for cold
      // caches on large multi-clip projects where the first __applyFrame
      // fans out tens of concurrent tile fetches through trailcutFetch.
      // The signal-handshake workaround is the actual fix for V8-Inspector
      // GC of awaited Promises; this timeout is defense in depth for
      // genuine slow paths (network-bound tile cold-fetches).
      protocolTimeout: 600_000,
    });

    // Surface tear-down diagnostics. Without these, a renderer-subprocess
    // crash lands as a generic "Promise was collected" with no clue why.
    browser.on('disconnected', () => {
      process.stderr.write('[renderer] browser disconnected\n');
    });
    browser.on('targetdestroyed', (target) => {
      process.stderr.write(`[renderer] target destroyed: ${target.type()} ${target.url()}\n`);
    });

    return browser;
  }

  private async buildPage(b: Browser): Promise<Page> {
    const p = await b.newPage();

    // Forward page console + page errors to worker stderr so failures are
    // diagnosable. In quiet mode, drop console.log/info/debug; always keep
    // warn/error/assert so unexpected page-side output still surfaces.
    p.on('console', (msg) => {
      const t = msg.type();
      if (!VERBOSE && (t === 'log' || t === 'info' || t === 'debug')) return;
      process.stderr.write(`[console:${t}] ${msg.text()}\n`);
    });
    p.on('pageerror', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
      process.stderr.write(`[pageerror] ${msg}${stack}\n`);
    });
    p.on('error', (err: unknown) => {
      // 'error' fires on page crash (Chrome process killed, OOM). Without
      // this listener, page crashes surface only as "Promise was collected".
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[page-crash] ${msg}\n`);
    });

    // Expose the cache bridge before setting content so the page-side
    // addProtocol loader can call window.trailcutFetch synchronously after
    // page-script execution.
    await p.exposeFunction('trailcutFetch', bridgeFetchFactory(this.tileCache, fetchUrl));

    // Completion signal for __init — see `pendingInitSignal` comment above.
    // Registered once per page; applySetup wires up the resolver per call.
    await p.exposeFunction(
      '__signalInitDone',
      (status: { ok: boolean; error?: string }) => {
        const cb = this.pendingInitSignal;
        this.pendingInitSignal = null;
        if (cb) cb(status);
        else process.stderr.write('[renderer] __signalInitDone fired with no pending listener\n');
      },
    );

    // Completion signal for __applyFrame — same shape as the __init
    // handshake. renderFrame wires up the resolver per call.
    await p.exposeFunction(
      '__signalApplyFrameDone',
      (status: {
        ok: boolean;
        result?: { rgbaB64: string | null } | null;
        error?: string;
      }) => {
        const cb = this.pendingApplyFrameSignal;
        this.pendingApplyFrameSignal = null;
        if (cb) cb(status);
        else process.stderr.write('[renderer] __signalApplyFrameDone fired with no pending listener\n');
      },
    );

    await p.setContent(buildBootstrapHtml(), { waitUntil: 'load' });
    return p;
  }

  private async applySetup(p: Page, payload: SetupCmd): Promise<void> {
    const t0 = Date.now();
    const stamp = (msg: string): void => {
      verbose(`[renderer applySetup +${Date.now() - t0}ms] ${msg}\n`);
    };

    // Match the Page's viewport to the requested CSS-viewport dims, with
    // `deviceScaleFactor` set to the export's `pixelRatio`. Together these
    // give MapLibre a framebuffer of `cssViewport * pixelRatio`, which (by
    // construction in build_setup_payload) matches the requested map_slot
    // pixel dims × SSAA factor.
    stamp(
      `before setViewport css=${payload.cssViewport.w}x${payload.cssViewport.h} ` +
      `dpr=${payload.pixelRatio} fb=${payload.framebuffer.w}x${payload.framebuffer.h}`,
    );
    await p.setViewport({
      width: payload.cssViewport.w,
      height: payload.cssViewport.h,
      deviceScaleFactor: payload.pixelRatio,
    });
    stamp('after setViewport');

    const scene = buildStaticScene(payload);
    stamp('static scene built');

    // SDF shape icons are rasterized PAGE-SIDE (in __init), not here — the
    // renderer page is a full Chrome context (same as the preview's), so it
    // rasterizes via the same pure `buildAllShapeIcons` the preview uses
    // and `addImage`s the result; no pixels cross CDP. (Shipping raw RGBA
    // buffers through page.evaluate serialized Uint8Arrays as JSON objects
    // — a ~12× text blowup that tripped Chrome's 100 MB inbound-message
    // cap at 2160p.) We ship only the scalar inputs: `pixelRatio` (already
    // in the payload) and `shapeOutlineThickness`.
    const initPayload = {
      style: scene.style,
      cssViewport: payload.cssViewport,
      framebuffer: payload.framebuffer,
      readback: payload.readback,
      pixelRatio: payload.pixelRatio,
      add3dBuildings: scene.add3dBuildings,
      staticSources: scene.staticSources as Array<[string, unknown]>,
      staticLayers: scene.staticLayers as unknown[],
      staticPaints: scene.staticPaints,
      staticLayouts: scene.staticLayouts,
      // Line-gradient expressions for `route-full-line` / `route-trail-line`.
      // Gradient mode ships an `interpolate` expression; solid mode ships
      // `null` so the page's __init clears any stale `line-gradient` from a
      // prior style.
      staticGradients: scene.staticGradients,
      shapeOutlineThickness: scene.shapeOutlineThickness,
      buildingsLayer: scene.buildingsLayer,
      // Page-side opts. `verbose` gates the page's __init/__applyFrame
      // breadcrumbs; `transport` selects the readback path.
      verbose: VERBOSE,
      transport: TRANSPORT,
    };

    // Surface initPayload size — `page.evaluate` ships the argument through
    // CDP's Runtime.callFunctionOn as serialized JSON. Big LineStrings (a
    // 6000-point GPX route is ~12000 numbers ≈ 200 KB serialized) plus an
    // inlined style spec can push past CDP's argument-size threshold; if
    // this is large, the very next evaluate is the prime suspect for
    // "Promise was collected".
    const initPayloadJson = JSON.stringify(initPayload);
    stamp(
      `initPayload built: total=${initPayloadJson.length}B ` +
      `staticLayers=${scene.staticLayers.length} ` +
      `staticPaints=${scene.staticPaints.length} ` +
      `staticLayouts=${scene.staticLayouts.length} ` +
      `shapeOutlineThickness=${scene.shapeOutlineThickness.toFixed(2)}`,
    );

    // Set up the signal-based handshake BEFORE kicking off __init so we
    // can't miss a fast resolution. See `pendingInitSignal` comment.
    if (this.pendingInitSignal) {
      // Defensive — applySetup is awaited sequentially per worker, so this
      // should never fire. Drop the stale resolver if it does.
      process.stderr.write('[renderer] applySetup: dropping stale pendingInitSignal\n');
      this.pendingInitSignal = null;
    }
    const initSignal = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      this.pendingInitSignal = resolve;
    });

    stamp('before page.evaluate(__init kickoff)');
    // Fire-and-forget. The outer arrow function returns `undefined`
    // synchronously, so CDP's awaitPromise has nothing to track — no
    // long-running Promise for V8 to GC. The page-side __init runs to
    // completion in the background and signals via window.__signalInitDone,
    // which resolves `initSignal` on the Node side.
    await p.evaluate((payload: typeof initPayload) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      void w.__init(payload).then(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => w.__signalInitDone({ ok: true }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => w.__signalInitDone({
          ok: false,
          error: String((e && e.message) ?? e),
        }),
      );
    }, initPayload);
    stamp('kickoff evaluate returned, awaiting __signalInitDone');

    const status = await initSignal;
    stamp(`__init signal received: ${status.ok ? 'ok' : `error=${status.error}`}`);
    if (!status.ok) {
      throw new Error(`__init failed in page: ${status.error ?? 'unknown'}`);
    }
    stamp('after page.evaluate(__init) resolved');
  }

  async setup(payload: SetupCmd): Promise<void> {
    const t0 = Date.now();
    this.setupPayload = payload;
    if (!this.browser) {
      this.browser = await this.launchBrowser();
      verbose(`[renderer] browser launched at ${Date.now() - t0}ms\n`);
    }
    if (this.page) {
      try { await this.page.close(); } catch { /* ignore */ }
      this.page = null;
    }
    this.page = await this.buildPage(this.browser);
    verbose(`[renderer] page ready at ${Date.now() - t0}ms\n`);
    await this.applySetup(this.page, payload);
    // Always emit a single setup-summary line — useful for spotting cold-
    // start cost in the orchestrator log without enabling verbose mode.
    process.stderr.write(
      `[renderer] setup done in ${Date.now() - t0}ms (backend=chrome, transport=${TRANSPORT}, verbose=${VERBOSE})\n`,
    );
  }

  async recycle(): Promise<void> {
    if (!this.setupPayload) {
      process.stderr.write('[renderer] recycle without prior setup, ignoring\n');
      return;
    }
    this.recycleCountThisBrowser += 1;

    // Layered defense — every Nth recycle, also relaunch the browser. The
    // orchestrator never sees the difference; same wire bytes either way.
    const shouldRestartBrowser =
      this.recycleCountThisBrowser >= BROWSER_RESTART_EVERY_RECYCLES;

    if (this.page) {
      try { await this.page.close(); } catch { /* ignore */ }
      this.page = null;
    }
    if (shouldRestartBrowser && this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
      this.recycleCountThisBrowser = 0;
    }
    if (!this.browser) {
      this.browser = await this.launchBrowser();
    }
    this.page = await this.buildPage(this.browser);
    await this.applySetup(this.page, this.setupPayload);
  }

  async renderFrame(frame: FramePayload, frameIndex: number): Promise<RenderedFrame> {
    const tStart = Date.now();
    const fstamp = (msg: string): void => {
      verbose(
        `[renderer renderFrame f=${frameIndex} +${Date.now() - tStart}ms] ${msg}\n`,
      );
    };
    const payload = this.setupPayload;
    const page = this.page;
    if (!payload || !page) {
      throw new Error('chrome backend: renderFrame before setup');
    }

    // ---- 1) page.evaluate(__applyFrame): apply deltas + camera + idle ----
    // In readpixels mode, __applyFrame *also* performs the readback and
    // returns a base64-encoded RGBA buffer. In png mode it returns null and
    // the worker takes a Page.captureScreenshot below.
    //
    // Fire-and-forget + signal handshake (mirrors applySetup's __init
    // pattern) — see `pendingApplyFrameSignal`.
    if (this.pendingApplyFrameSignal) {
      process.stderr.write('[renderer] renderFrame: dropping stale pendingApplyFrameSignal\n');
      this.pendingApplyFrameSignal = null;
    }
    const evalStart = Date.now();
    const applySignal = new Promise<{ rgbaB64: string | null } | null>(
      (resolve, reject) => {
        this.pendingApplyFrameSignal = (status) => {
          if (status.ok) resolve(status.result ?? null);
          else reject(new Error(status.error ?? 'unknown __applyFrame error'));
        };
      },
    );
    await page.evaluate((p: FramePayload) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      void w.__applyFrame(p).then(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => w.__signalApplyFrameDone({ ok: true, result: r ?? null }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => w.__signalApplyFrameDone({
          ok: false,
          error: String((e && e.message) ?? e),
        }),
      );
    }, frame);
    const applyResult = await applySignal;
    const evalMs = Date.now() - evalStart;
    fstamp(`applyFrame returned (${evalMs}ms, transport=${TRANSPORT})`);

    // ---- 2) Pixel readback ----
    let rgba: Buffer;
    let shotMs = 0;
    let decodeMs = 0;
    let pngBytes = 0;
    if (TRANSPORT === 'readpixels') {
      if (!applyResult || !applyResult.rgbaB64) {
        throw new Error('readpixels mode: __applyFrame did not return rgbaB64');
      }
      // Buffer.from(b64, 'base64') is native C++; ~10 MB base64 → 8 MB RGBA
      // in single-digit ms on M-series silicon.
      const decodeStart = Date.now();
      rgba = Buffer.from(applyResult.rgbaB64, 'base64');
      decodeMs = Date.now() - decodeStart;
      // The page downsamples the supersampled framebuffer to `readback`
      // (slot) dims on-GPU before returning, so the buffer is readback-sized.
      const expected = payload.readback.w * payload.readback.h * 4;
      if (rgba.length !== expected) {
        throw new Error(
          `readpixels: got ${rgba.length}B, expected ${expected}B (${payload.readback.w}x${payload.readback.h}*4)`,
        );
      }
      fstamp(`readpixels decode ${rgba.length}B in ${decodeMs}ms`);
    } else {
      // Legacy PNG transport — Page.captureScreenshot then pngjs. The on-GPU
      // SSAA downsample lives only in the readpixels path, so PNG can't
      // produce readback-sized frames when supersampling is active — fail
      // loudly rather than emit wrong dims.
      if (payload.framebuffer.w !== payload.readback.w
        || payload.framebuffer.h !== payload.readback.h) {
        throw new Error(
          'PNG transport does not support SSAA supersampling '
          + `(framebuffer ${payload.framebuffer.w}x${payload.framebuffer.h} != `
          + `readback ${payload.readback.w}x${payload.readback.h}); use the default readpixels transport`,
        );
      }
      const shotStart = Date.now();
      const pngBuf = (await page.screenshot({
        type: 'png',
        captureBeyondViewport: false,
        omitBackground: true,
        fullPage: false,
        clip: { x: 0, y: 0, width: payload.cssViewport.w, height: payload.cssViewport.h },
      })) as Buffer;
      shotMs = Date.now() - shotStart;
      pngBytes = pngBuf.length;
      fstamp(`screenshot ${pngBuf.length}B in ${shotMs}ms`);
      const decodeStart = Date.now();
      rgba = await decodePngToRgba(pngBuf, payload.framebuffer.w, payload.framebuffer.h);
      decodeMs = Date.now() - decodeStart;
      fstamp(`png decoded ${rgba.length}B in ${decodeMs}ms`);
    }

    const tx = TRANSPORT === 'png'
      ? `shot=${shotMs}ms png=${pngBytes}B`
      : 'read=embedded';
    return {
      rgba,
      detail: `eval=${evalMs}ms ${tx} decode=${decodeMs}ms`,
    };
  }

  async shutdown(): Promise<void> {
    if (this.page) {
      try { await this.page.close(); } catch { /* ignore */ }
      this.page = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
  }
}

function decodePngToRgba(png: Buffer, expectedW: number, expectedH: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new PNG().parse(png, (err, parsed) => {
      if (err) return reject(err);
      if (parsed.width !== expectedW || parsed.height !== expectedH) {
        return reject(new Error(
          `PNG decoded size mismatch: got ${parsed.width}x${parsed.height}, expected ${expectedW}x${expectedH}`,
        ));
      }
      // pngjs always normalizes to RGBA8 internally. parsed.data is a
      // Buffer of length width*height*4 in RGBA byte order — exactly the
      // wire format.
      resolve(parsed.data);
    });
  });
}
