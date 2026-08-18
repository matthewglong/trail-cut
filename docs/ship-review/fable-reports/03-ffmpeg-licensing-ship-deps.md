# Ship-review report 03 — FFmpeg / codec licensing and the ship dependency bundle

**Scope:** the GPL/LGPL conflict created when commit `1345ded` made libx265 (GPL) the
primary HEVC encoder for all HEVC delivery, against the "task 130" plan to bundle an
**LGPL** FFmpeg sidecar; plus a licensing pass over the rest of the bundled binaries.
**Deliverable:** a decision, not a filing.

> **This is engineering analysis to inform a decision. It is not legal advice, and I am
> not a lawyer.** Before shipping to thousands of paying users you should have a licensed
> attorney sign off on the copyright-compliance artifacts (Option 1 checklist) and on the
> patent-exposure question (§A.3). Everything below is concrete enough to make that review
> short and cheap. Where the law is genuinely unsettled I say so rather than hedging
> everything.

---

## TL;DR

- **Copyright: the GPL is a solved, low-risk problem for us — but the fix is NOT "LGPL
  FFmpeg."** We invoke ffmpeg strictly as a separate subprocess over stdin/argv (verified
  in code), which is the FSF's own textbook "mere aggregation / arm's-length" case. So we
  may bundle a **full-GPL ffmpeg binary** next to our proprietary Rust app **without our
  code becoming a derivative work** — provided we honor the GPL's obligations *for the
  ffmpeg binary itself* (ship its complete corresponding source + license texts). The
  "task 130 must be an LGPL build" premise is simply wrong; it was never a legal
  requirement, and both libx265 (HEVC) *and* libx264 (our H.264 path) already make an LGPL
  build impossible anyway.
- **Recommendation: Option 1 — bundle a full-GPL ffmpeg, comply with GPLv2 §3.** It keeps
  the chroma-edge gate at libx265 quality (no leveling-down), is one build config change,
  and the compliance work is a source tarball + a licenses directory + a written offer.
- **The real, separate risk is PATENTS, not copyright.** HEVC and H.264 are covered by
  patent pools whose obligations are independent of the GPL. The good news: the HEVC pool
  (now VCL Advance, ex–Access Advance/Via LA) **waives royalties on software-only encoders
  not bundled with hardware**, and H.264/AVC is **royalty-free under 100,000 units/year** —
  and TrailCut ships "thousands." So near-term cash exposure is plausibly ~$0, but a
  license may still need signing and other patent-holders exist outside the pools. This
  needs a lawyer's yes/no, and it does not change with the copyright option we pick.
- **Distribution channel is the one thing that can hard-block us:** the **Mac App Store is
  categorically incompatible with GPL** (the VLC precedent). If TrailCut is direct-download
  (DMG/notarized, and the Windows equivalent), GPL is fine. **If App Store is a target,
  GPL ffmpeg is off the table** and the whole calculus changes (commercial x265 license
  becomes near-mandatory). This is Open Question #1.
- **Rest of the bundle is clean:** ExifTool is Artistic-OR-GPL (we take the permissive
  Artistic option), maplibre-native binding is BSD-2-Clause, our two vendored patches are
  our own copyright over BSD code, the Node renderer pulls only node-builtins + pngjs
  (MIT). Node runtime + Tauri + maplibre-gl JS are all permissive. Only map *tile/imagery*
  ToS (OpenFreeMap, Esri) needs its own commercial-use check (§C).

---

## Architecture ground truth (verified in code, this repo)

The legal analysis rests entirely on *how* we invoke these tools, so I verified it rather
than assuming:

- **Everything is a separate CLI subprocess.** `std::process::Command::new("ffmpeg" |
  "ffprobe" | "exiftool" | "node")` throughout —
  `src-tauri/src/export/ffmpeg_sink.rs:104`, `ffmpeg_runner.rs:65`, `encoder.rs:249/271/508`,
  `ffprobe.rs:120`, `util/exiftool.rs:22`, `commands/ffmpeg.rs` (multiple), and the node
  renderer sidecar at `orchestrator.rs:409`. **No FFmpeg/x264/x265 code is linked into our
  binary.** Resolution is via `PATH` today; task 130 will bundle the binaries and point at
  bundled paths — the invocation model is unchanged.
- **The encode is a single ffmpeg process.** `FFmpegSink::spawn` pipes fixed-size raw RGBA
  frames into one ffmpeg invocation whose argv includes the color filtergraph (zscale) and
  `-c:v libx265`/`libx264` in the *same* process (`export/delivery.rs`
  `delivery_encoder_args`, `ffmpeg_sink.rs`). This matters for Option 2 below: today there
  is no separate "encode step" to peel off.
- **Two GPL encoders are in play, not one.** `delivery.rs`: `SdrH264` → `-c:v libx264`
  (GPL); `SdrH265` + both HDR targets → `-c:v libx265` (GPL); `Prores` → `prores_ks`
  (FFmpeg-native, LGPL, no GPL). So **H.264 already pulls in GPL** via libx264 — dropping
  HEVC does *not* by itself get us to an LGPL build.
- **The quality gate that pins libx265** is
  `delivery_encode_preserves_decoration_chroma_edges` in
  `src-tauri/tests/color_fixtures.rs` (≥0.80 Cb/Cr edge retention + a libx265-selection pin
  + a loud panic if ffmpeg lacks libx265). Commit `1345ded`; policy in
  `export/encoder.rs` (`ENCODER_POLICY_VERSION = 2`, libx265-first). The hardware HEVC
  encoder (`hevc_videotoolbox`) structurally crushes chroma-only decoration edges and no
  bitrate recovered it — reverting to it is leveling-down and stays off the table
  (CANON §3.3, memory `decoration-crispness-levers`).
- **Prior sensitivity signal:** the Chrome-for-Testing backend was killed partly over a
  redistribution problem (CANON §2.5/§6.2). That backend is gone (renderer is now the
  BSD maplibre-native binding), so CfT is moot — but it shows the project already treats
  redistributability as a ship gate.

---

## A. The legal position, precisely

### A.1 Does bundling a GPL ffmpeg binary and calling it via CLI make TrailCut a derivative work? — **No.**

This is the single most important finding and it is well-settled in the FSF's own
guidance.

The GPL's copyleft reaches "derivative works" / "modified versions" and works "based on"
the Program. The FSF's line between a combined work (copyleft propagates) and a **mere
aggregation** (it does not) turns on **both the mechanism and the semantics of
communication**. From the GNU GPL FAQ, *"What is the difference between an aggregate and
other kinds of modified versions?"*:

> "…pipes, sockets and command-line arguments are communication mechanisms normally used
> between two separate programs. So when they are used for communication, the modules
> normally are separate programs." — with the caveat: "…if the semantics of the
> communication are intimate enough, exchanging complex internal data structures, that too
> could be a basis to consider the two parts as combined into a larger program."
> ([gnu.org GPL FAQ #MereAggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation))

And the directly-on-point answer, *"I'd like to incorporate GPL-covered software in my
proprietary system"* (#GPLInProprietarySystem): the FSF says you may distribute a
GPL-covered program alongside a proprietary one **provided they communicate "at arm's
length" and are not combined so as to become "effectively a single program."** Two
programs that remain well-separated "like an editor and a shell" may be treated as
separate works.
([gnu.org GPL FAQ #GPLInProprietarySystem](https://www.gnu.org/licenses/gpl-faq.html#GPLInProprietarySystem))

**Applied to TrailCut:** we `fork/exec` ffmpeg as its own OS process; we exchange (a) an
argv string and (b) a byte stream of raw video frames over a pipe. That is exactly the
"pipes + command-line arguments between separate programs" mechanism the FAQ names as
*normally* aggregation. Our code links **zero** ffmpeg/x264/x265 code and shares no address
space.

**The "our Rust generates the argv" worry — does intimate command-line orchestration
change this?** This is the fair counter-question, and the honest answer: it does not, on
these facts. The FSF's "intimate semantics" caveat is aimed at pipes carrying *complex
internal data structures* that only make sense as two halves of one program (the classic
example is passing internal object graphs). Generating a **command-line invocation of a
general-purpose tool** and feeding it **standard raw video frames** is the ordinary,
documented use of ffmpeg-the-CLI by thousands of unrelated programs. We are not exchanging
ffmpeg's internal data structures; we are using its public command-line interface exactly
as a shell script would. The frames we pipe are a standard interchange format (rawvideo
rgba / yuv), not an ffmpeg-private structure. This is the "editor and a shell" side of the
line, not the "two halves of one program" side.

**Residual honesty:** the FSF itself stresses this is ultimately "a legal question, which
… judges will decide," and there is no controlling U.S. appellate case squarely on
exec-only aggregation. But (a) this is the FSF's *stated* position, i.e. the copyright
holders of the GPL and of much GPL code do not consider exec-at-arm's-length to
combine works; (b) x264/x265's own authors (VideoLAN / MulticoreWare) sell commercial
licenses precisely for people who want to *link* the libraries into proprietary code —
implying the CLI-subprocess-plus-separate-binary case is the mundane compliant path, not
the thing they police; and (c) our facts are about as clean an aggregation as exists. I
rate the derivative-work risk to *TrailCut's own source* as **very low**. What we *do*
owe is compliance for the ffmpeg binary itself — §A.2.

### A.2 Distribution obligations for the GPL ffmpeg binary itself

If we bundle a `--enable-gpl` ffmpeg, **the binary is GPLv2+ and we are "distributing"
it**, so GPLv2 §3 attaches to *that binary* (not to TrailCut). Concretely we must:

1. **Ship the complete corresponding source** for the exact ffmpeg we bundle — *and* for
   its GPL/LGPL components: FFmpeg itself, **x264**, **x265**, plus any other
   copyleft libraries the build links (e.g. libzimg/zscale is not GPL — it's a permissive
   library — but include whatever the build actually pulls). "Corresponds exactly to the
   binary you are distributing" is FFmpeg's explicit instruction.
   ([ffmpeg.org/legal.html](https://www.ffmpeg.org/legal.html)) The cleanest form: a
   versioned source tarball (or a git tag + the exact `./configure` line and toolchain
   notes) archived on the **same server** as the app download — FFmpeg's legal page says
   to host source on the same webserver as the binary.
2. **Provide the license texts** in the shipped bundle: GPLv2 (and LGPLv2.1, since
   base FFmpeg is LGPL), plus the COPYING/AUTHORS from FFmpeg, x264, x265. Include an
   in-app "Third-party licenses / Open-source notices" screen or a bundled `LICENSES/`
   directory.
3. **A written offer of source** valid ≥3 years is the belt-and-suspenders form if you
   ever ship the binary *without* co-located source (GPLv2 §3(b)); if you always co-host
   source (§3(a)), the offer is optional but cheap to include anyway.
4. **`--enable-gpl` implication:** enabling it means the *entire ffmpeg binary* is GPL
   (not just x264/x265). That's fine — it does not touch TrailCut — but it forecloses ever
   describing that binary as "LGPL," and it forecloses the App Store (§A.5).
5. **No `--enable-nonfree`.** That flag produces an **undistributable** binary (it allows
   combining with license-incompatible bits such as certain non-free AAC/FDK builds). We
   must never ship a `--enable-nonfree` build. `--enable-gpl` alone is distributable;
   `--enable-nonfree` is not.

**Note we do not modify ffmpeg's source**, which keeps this simple — no patch set to
publish for ffmpeg, just the pristine corresponding source at the pinned version.

### A.3 Patents — a SEPARATE axis from copyright (this is the part that actually costs money)

Copyright license (GPL) and patent license (HEVC/AVC pools) are **orthogonal**. Complying
with the GPL gives you **zero** patent rights. Distributing an H.264/H.265 encoder to
thousands of users is, in principle, a patent-triggering act regardless of the copyright
license. FFmpeg's own legal page punts on exactly this ("we are not lawyers… once you
start trying to make money from patented technologies, the owners of the patents will come
after their licensing fees" — [ffmpeg.org/legal.html](https://www.ffmpeg.org/legal.html)).

What the pools actually say:

- **HEVC / H.265 — software-only encoder exemption.** The HEVC Advance pool (administered
  by Access Advance; as of **Dec 15 2025** the former Via LA HEVC/VVC program was folded
  into Access Advance's **VCL Advance / Video Codec Licensing LLC**) **waives royalties on
  software-only implementations — encoders and decoders — that are not bundled with
  hardware.** TrailCut is pure software shipped to end users, so it fits the exemption.
  **Caveat the pool itself states:** exempted software is "not free from the licensing
  obligations of other patent holders" outside that pool.
  ([en.wikipedia.org/wiki/High_Efficiency_Video_Coding](https://en.wikipedia.org/wiki/High_Efficiency_Video_Coding),
  [accessadvance.com](https://accessadvance.com/licensing-programs/hevc-advance/),
  [ipfray.com on the Via LA acquisition](https://ipfray.com/breaking-access-advance-acquires-via-licensing-alliances-hevc-vvc-patent-pools/))
  HEVC patents are also split across **multiple pools + unpooled holders**, so "one pool
  exempts us" ≠ "no HEVC patent risk." This is a real, if industry-wide, uncertainty.
- **H.264 / AVC — royalty-free under 100,000 units/year.** The AVC pool (MPEG LA, now
  Via LA) charges **$0 for the first 100,000 units per legal entity per year**, then
  $0.20/unit, dropping to $0.10 above 5M/year, with an annual enterprise cap.
  ([via-la.com AVC/H.264](https://www.via-la.com/licensing-programs/avc-h-264/),
  [MPEG LA AVC briefing PDF](https://www.mpegla.com/wp-content/uploads/avcweb.pdf))
  "Thousands of users" is comfortably under the 100,000/yr free tier, so **near-term AVC
  cash royalty is plausibly $0** — but a licensee still technically *signs* the AVC license
  to be covered; the $0 is a rate, not an absence of a license. (Note: the widely-reported
  2025 H.264 *streaming/content* fee hikes concern **distributing video content/services**,
  a different license category from **distributing an encoder product** — not our exposure
  as an app vendor.)
- **What comparable indie apps do in practice:** most small/indie shipping apps
  (a) rely on the OS's already-licensed codecs (Apple/Microsoft have paid platform
  licenses — but that's for *their* VideoToolbox/Media Foundation encoders, which we can't
  use for HEVC because of the chroma gate), or (b) ship x264/x265 and lean on the
  software-encoder exemption + the AVC free tier and simply accept the residual, generally
  un-enforced risk against small volumes, or (c) for HEVC specifically, many indies **avoid
  shipping an HEVC encoder at all** and export H.264 + (increasingly) AV1, sidestepping the
  messiest pool. This last point is why "is HEVC product-required?" is a live question
  (§D).

**Bottom line on patents:** likely low *cash* exposure at our scale today, but it is a
genuine, non-zero, industry-wide risk that (i) is independent of which copyright option we
choose, and (ii) deserves an explicit lawyer yes/no before ship, especially because we are
a *paid* product shipping an encoder to thousands.

### A.4 x265 commercial license (MulticoreWare) — the GPL escape hatch, at a price

x265 is dual-licensed: GPLv2 **or** a commercial license from MulticoreWare that lets you
"integrate x265 into proprietary products without releasing your product as GPL."
Commercial licensees still (a) must contribute back any changes to x265 source files, and
(b) **must separately obtain HEVC patent licenses** (the commercial copyright license is
*not* a patent license — same orthogonality as §A.3).
([x265.readthedocs.io introduction](https://x265.readthedocs.io/en/stable/introduction.html),
[x265.org](https://www.x265.org/), [videolan.org/developers/x265.html](https://www.videolan.org/developers/x265.html))
**Cost class: undisclosed / quote-only** — MulticoreWare (and VideoLAN/OSS's x264
equivalent) price per business model via `license@x265.com`; there is no public number.
Industry reputation puts these in the "four-to-five-figure annual, negotiable" band for a
small vendor, but **treat the number as unknown until you get a quote**
([opensalessolutions.net licensing](https://opensalessolutions.net/licensing/)). Note a
commercial x265 license only removes the *copyright* GPL constraint on **HEVC**; you'd
still need to handle **libx264** (H.264) the same way (commercial x264 license, or a
non-GPL H.264 path) if you want a fully GPL-free product.

### A.5 Mac App Store vs direct distribution — the potential hard blocker

**GPL is categorically incompatible with the Apple App Store.** The App Store imposes
Usage Rules and DRM (device-count limits, ToS-to-use) that are exactly the "further
restrictions" GPLv2/§6 forbids a distributor from adding — this is the well-documented
**VLC** removal (2010–2011): Apple pulled GPL VLC rather than change its terms; the only
resolutions were relicensing away from GPL (VLC's mobile ports were eventually re-licensed
under more permissive terms) or leaving the store.
([fsf.org VLC enforcement](https://www.fsf.org/blogs/licensing/vlc-enforcement),
[fsf.org more-about-app-store-gpl](https://www.fsf.org/blogs/licensing/more-about-the-app-store-gpl-enforcement),
[9to5mac](https://9to5mac.com/2011/01/07/vlc-for-ios-removed-from-the-app-store/))

**Consequence for TrailCut:**
- **Direct download (notarized DMG on macOS; Inno/MSI or similar on Windows):** GPL is
  fine. Option 1 works. This is the assumed channel and it fits Tauri's normal
  distribution model.
- **Mac App Store (or Microsoft Store with equivalent terms):** **GPL ffmpeg is
  impossible.** You would be forced to a fully GPL-free product — meaning **commercial x265
  license + commercial/permissive H.264 path** — i.e. Option 3, at cost.

I could **not** determine the intended channel from the repo (`tauri.conf.json` has
`createUpdaterArtifacts`/bundle config but no App Store target, and no MAS provisioning). It
is **Open Question #1** and it gates everything. My recommendation assumes **direct
download** (the overwhelmingly common Tauri channel and the one consistent with bundling
FFmpeg at all).

---

## B. The options matrix

Ranking constraints: (i) **never degrade** the chroma-edge gate below 0.80 / never revert
to `hevc_videotoolbox`; (ii) Windows must work too; (iii) scope stated as scope/risk/
unknowns, no time estimates.

### Option 1 — Bundle a full-GPL ffmpeg, comply with GPLv2 §3  ★ RECOMMENDED (direct-download channel)

- **What:** build one `--enable-gpl` (no `--enable-nonfree`) ffmpeg with libx264 + libx265
  + libzimg/zscale, per platform; bundle as the Tauri sidecar; ship the compliance
  artifacts (§A.2).
- **Legal risk (copyright):** **very low.** Our code is aggregation (§A.1); we satisfy the
  GPL for the binary by publishing corresponding source + licenses. The only residual is
  the always-present "no appellate ruling on exec-aggregation" theoretical, which the FSF's
  own position and universal industry practice make negligible.
- **Legal risk (patent):** the §A.3 industry-wide HEVC/AVC exposure — **identical under
  every option that ships an HEVC/H.264 encoder**, so not a differentiator here.
- **Quality:** **unchanged** — libx265 stays the encoder, gate stays ≥0.80. No
  leveling-down.
- **Windows:** same story — build a GPL ffmpeg.exe for Windows, bundle it, ship the same
  corresponding-source + licenses. No extra legal wrinkle (Windows has no App-Store-style
  GPL conflict for direct download).
- **Engineering scope:** **small.** Change the CI/own-build ffmpeg config from the planned
  LGPL flags to `--enable-gpl`; wire task 130's sidecar bundling to the bundled path
  (already the plan); add a `LICENSES/` dir + an in-app open-source-notices view + a
  same-server source tarball at each release. **Risk:** low; it's packaging + docs, no
  pipeline change. **Unknowns:** exact set of copyleft libs your chosen build pulls (audit
  the final `configure` line); whether your release hosting can co-locate a ~tens-of-MB
  source tarball per version (trivial).
- **Compliance checklist:** see the dedicated checklist at the end.

### Option 2 — Two-binary split: LGPL ffmpeg for filtergraph + separate encoder

- **Idea:** keep an LGPL ffmpeg for decode/filtergraph/color, pipe its output to a
  *separate* standalone x265/x264 CLI (GPL, but shipped as its own program → still needs
  GPL compliance for that binary) or a commercial encoder.
- **Reality check against our pipeline:** today the filtergraph and `-c:v libx265` are the
  **same ffmpeg process** (`ffmpeg_sink.rs`, `delivery.rs`). Splitting means: LGPL ffmpeg
  emits raw/lossless YUV to a pipe, a standalone `x265`/`x264` CLI reads it and encodes.
  Architecturally feasible (x265 CLI takes raw YUV; we already own the frame-piping
  discipline), but it **adds a pipeline stage, a second process to bundle/version, and a
  raw-YUV interchange contract** (color metadata, range, pix_fmt, HDR signaling) that the
  fused ffmpeg currently handles internally — exactly the color plumbing that has been
  the project's hardest area.
- **Legal payoff:** **near zero.** If the standalone x265 is GPL, you *still* ship a GPL
  binary and owe the same §3 compliance as Option 1 — you've added engineering for no
  copyright relief. It only helps if the separate encoder is *commercial/permissive*, at
  which point it's just Option 3 with extra pipe stages.
- **Quality:** neutral-to-worse (extra raw-YUV handoff is a chance to lose HDR/color
  fidelity if the interchange contract is imperfect — a leveling-down *risk* we'd be
  introducing for no legal gain).
- **Verdict:** **do not pursue.** More moving parts, more color risk, no compliance
  benefit over Option 1. Only revisit if forced GPL-free (then it collapses into Option 3).

### Option 3 — Commercial x265 (+ commercial/permissive H.264) license

- **What:** buy a MulticoreWare x265 commercial license → ship x265 in a proprietary,
  non-GPL build; do the same for H.264 (commercial x264 from VideoLAN/OSS, **or** move
  H.264 to a non-GPL encoder — see Option 4's h264_videotoolbox note).
- **Legal risk (copyright):** **lowest of all** — no GPL obligations at all; compatible
  with **App Store**.
- **Patent:** unchanged industry exposure; commercial copyright license still isn't a
  patent license (§A.4).
- **Quality:** **unchanged** (same x265 code). Gate stays green.
- **Windows:** clean.
- **Scope:** **small engineering** (build flags), but **commercial + procedural** overhead:
  negotiate + pay an **undisclosed, quote-only** annual fee (§A.4), track the
  "contribute-back x265 source changes" obligation (we don't currently modify x265, so
  low), and repeat for H.264. **Risk:** budget/renewal dependency; vendor relationship.
  **Unknown:** the actual price (must request a quote).
- **When this becomes the answer:** **if App Store is a distribution target** (Option 1
  impossible there), or if a lawyer is uncomfortable with even the low copyright-aggregation
  residual for a paid product. Otherwise it's paying cash for compliance we can get free.

### Option 4 — Non-GPL encoders (drop or replace the GPL codecs)

- **SVT-AV1 (BSD-2-Clause-Patent) / libaom (BSD):** permissive, LGPL-compatible, **excellent
  quality** — but **AV1, not HEVC**. Viable *only if HEVC is not product-required* (§D,
  Open Question #2). AV1 hardware-decode support on the *viewers'* phones/social platforms
  is now broad but not universal; HEVC is the safe iPhone/social interop codec today. This
  is a **product** decision, not a legal one.
- **kvazaar (LGPLv2.1) — the one non-GPL *software HEVC* encoder:** could be enabled in an
  *LGPL* ffmpeg and would keep HEVC without GPL. **But:** kvazaar trails x265 in
  real-world quality/feature maturity (its strengths are intra/real-time; chroma-fidelity
  behavior under our decoration-edge gate is **unvalidated** and, given x265 was itself the
  hard-won fix over hardware, kvazaar passing ≥0.80 is doubtful). Treat as **"test against
  the gate before believing it"**; I would not bet the ship codec on it.
  ([kvazaar LGPL + x265 comparison](https://link.springer.com/article/10.1007/s11554-024-01429-5))
- **VideoToolbox with the failed settings:** **OFF THE TABLE** per the brief and CANON §3.3
  — `hevc_videotoolbox` crushes chroma edges; not proposed. (Narrow, *untested* sub-note
  for the H.264 path only: `h264_videotoolbox` is a non-GPL H.264 encoder; whether it
  passes the chroma gate for the *H.264* target is unknown — the gate/quality finding was
  specifically about **HEVC** hardware. If validated, it could de-GPL the H.264 path
  without touching HEVC. Flagging as an unknown, not a recommendation.)
- **Verdict:** Option 4 is a **product pivot** (HEVC→AV1) dressed as a legal option. Keep
  it in view only if §D Open Question #2 resolves "HEVC not required."

### Option 5 — Download-the-GPL-binary-on-first-run

- **Idea:** ship TrailCut without ffmpeg; fetch a GPL ffmpeg from our server or a public
  mirror on first launch, to "avoid distributing GPL."
- **Honest legal analysis:** **if we host it, we are distributing it** — arm's-length
  download does **not** remove GPL obligations; we'd owe the same §3 source/license
  compliance as Option 1, just deferred to a download endpoint. Pointing at a *third-party*
  public mirror we don't control shifts the *distribution* act to them but (a) is fragile
  (mirror rot / version drift breaks exports for a paid app), (b) arguably makes us an
  inducer/party to an incomplete distribution if that mirror lacks corresponding source,
  and (c) is a **terrible UX for a consumer app** — a multi-hundred-MB gated first-run
  download before the user can export, with failure modes on flaky networks, corporate
  proxies, and offline use. It also complicates notarization/AV-scanning of an app that
  pulls executables at runtime.
- **Verdict:** **reject.** It doesn't remove obligations, it *adds* fragility and a bad
  first-run, and Option 1 (co-host source next to the app) achieves compliance without any
  of it.

### Options summary

| Option | Copyright risk | Patent (all equal) | Quality/gate | App Store OK? | Windows | Eng scope | Cash |
|---|---|---|---|---|---|---|---|
| **1. GPL ffmpeg + comply** ★ | very low | industry baseline | unchanged (x265) | ❌ | clean | small (packaging/docs) | $0 |
| 2. Two-binary split | same as its encoder | baseline | neutral→worse risk | depends | +complexity | med, color risk | — |
| 3. Commercial x265(+x264) | lowest | baseline | unchanged | ✅ | clean | small eng + procurement | $$ quote |
| 4. Non-GPL codecs (AV1/kvazaar) | none/low | AV1 differs | AV1 fine; kvazaar unproven | ✅ | clean | product pivot | $0 |
| 5. Download-on-run | **same as 1, +fragility** | baseline | unchanged | ❌ | worse | med + bad UX | $0 |

**Primary recommendation: Option 1**, on the assumption of direct-download distribution.
It is the only option that is simultaneously $0-cash, quality-preserving (keeps libx265,
honors the gate, zero leveling-down), and small-scope. **Fallback: Option 3** the moment
App Store enters scope or counsel wants the copyright residual gone.

---

## C. The rest of the bundle (quick pass)

- **ExifTool — clean.** Dual-licensed **Artistic-1.0-Perl OR GPL-1.0-or-later** ("same
  terms as Perl"). We simply **take the Artistic option** (permissive) and the GPL side
  never binds. Subprocess-invoked (`util/exiftool.rs:22`), so the §A.1 aggregation logic
  applies regardless. **Windows packaging:** the modern ExifTool Windows distribution is a
  folder (`exiftool.exe` + `exiftool_files/`) that **bundles Strawberry Perl** — Perl is
  Artistic/GPL dual too, redistributable; keep the `exiftool_files` folder alongside the
  exe and include its license texts. No blocker.
  ([exiftool.org](https://exiftool.org/), [Wikipedia: ExifTool](https://en.wikipedia.org/wiki/ExifTool))
- **maplibre-native binding — clean.** `@maplibre/maplibre-gl-native` **v6.4.1,
  BSD-2-Clause** (verified in the bundled `package.json`). Its runtime deps
  (node-pre-gyp fork, minimatch, npm-run-all) are build-time/permissive. **Our two vendored
  patches** are our own modifications to BSD code → we may redistribute freely; BSD only
  asks we preserve the upstream copyright/license notice. Include maplibre-native's
  LICENSE.md in the notices. If we ever *upstream* the patches that's a courtesy, not an
  obligation.
- **maplibre-gl (JS) preview patch — clean.** maplibre-gl JS is **BSD-3-Clause**; our
  `patches/maplibre-gl+5.22.0.patch` is our modification over BSD — same as above.
- **Node renderer sidecar — clean.** Imports only **node builtins** (`node:fs`, `node:http`,
  `node:zlib`, …) + **`pngjs` (MIT)**. No copyleft, nothing viral. Bundling the **Node
  runtime** itself is fine (Node core is MIT; it embeds V8/BSD, libuv/MIT, OpenSSL/Apache-2.0
  — all redistributable; include their notices in the aggregated licenses file).
- **Tauri / Rust crates — clean.** Tauri is MIT/Apache-2.0; the Rust deps in `Cargo.toml`
  are overwhelmingly MIT/Apache-2.0. Worth a one-time `cargo-about`/`cargo-deny` license
  sweep to auto-generate the notices file and catch any stray copyleft crate — cheap
  insurance, not a known problem.
- **⚠️ Map tiles & satellite imagery — needs its own ToS review (flag, not deep-dive).**
  This is **content/service licensing, not code licensing**, and it's the one item here I'd
  escalate:
  - **OpenFreeMap** — check its usage terms for a **commercial, shipped-to-thousands** app
    (rate limits, attribution, whether self-hosting tiles is expected at scale). Attribution
    to OpenStreetMap (ODbL) is almost certainly required on-map.
  - **Esri satellite imagery** — Esri's World Imagery has **explicit ToS and attribution
    requirements**, and commercial redistribution/one-off-video use may need an Esri plan.
    If TrailCut bakes Esri imagery into exported videos users then post publicly, that is a
    **commercial-use question that should get its own review** before ship. Do not assume
    the dev-time tile access terms carry to a shipped commercial product.
  These don't affect the FFmpeg/GPL decision but belong on the pre-ship legal list.

---

## D. Open questions for Matthew (each with my recommendation)

1. **Distribution channel — direct download vs. App Store?** *(gates everything)*
   **Recommendation: commit to direct-download (notarized DMG + Windows installer).** It is
   the standard Tauri channel, it makes **Option 1** valid and free, and it avoids the
   GPL-vs-App-Store wall entirely. Only if App Store is a hard product requirement do we
   switch to Option 3 and pay for commercial codec licenses.

2. **Is HEVC actually product-required, or do H.264 + AV1 suffice for the social-media
   targets?** **Recommendation: keep HEVC.** iPhone-native footage is HEVC, and HEVC is the
   safe interop codec for Apple/social pipelines and HDR delivery (our HdrHlg/HdrPq targets
   are first-class per CANON). Dropping HEVC to escape GPL is leveling-down of reach. Add
   AV1 later as an *additional* target if desired, but don't drop HEVC to solve a licensing
   problem that Option 1 already solves for free.

3. **Commercial-license appetite / budget?** **Recommendation: don't spend now.** Under
   direct-download + Option 1 there is no need to buy an x265 (or x264) commercial license
   for **copyright** reasons. Hold budget for the **patent** question instead (get a lawyer
   to confirm the HEVC software-exemption + AVC-free-tier posture) — that's the exposure
   that actually scales with user count, and it's independent of the copyright path.

4. **Who signs off on patents before ship?** **Recommendation: get a short written opinion
   from an IP attorney** on (a) reliance on the HEVC software-only-encoder exemption for a
   paid app, and (b) whether to sign the AVC license even at the $0 tier. This is the one
   place I'd not ship on engineering judgment alone.

5. **Own-CI build flags — update the plan.** **Recommendation:** change the task-130
   own-build recipe from "LGPL FFmpeg" to **`--enable-gpl --enable-libx264 --enable-libx265
   --enable-libzimg` (and NOT `--enable-nonfree`)**, and update CANON §6.2 + the PROGRESS
   licensing flag to record that the LGPL premise was retired in favor of GPL-aggregation
   compliance. *(I did not edit those files — this report is the only file I touched.)*

---

## Compliance checklist for the recommended path (Option 1, direct-download)

- [ ] Build ffmpeg with `--enable-gpl` (libx264 + libx265 + libzimg/zscale), **no**
      `--enable-nonfree`, per platform (macOS arm64/x64, Windows x64).
- [ ] Record the exact `./configure` line + component versions (ffmpeg, x264, x265,
      libzimg) per release.
- [ ] Publish **complete corresponding source** (tarball or pinned git refs + build notes)
      for ffmpeg + x264 + x265 at the pinned versions, **co-hosted on the same server as the
      app download** (GPLv2 §3(a)). Keep per-version.
- [ ] Include a **written offer of source** valid ≥3 years (GPLv2 §3(b)) in the app's
      license notice as belt-and-suspenders.
- [ ] Bundle a `LICENSES/` directory: GPLv2, LGPLv2.1, and the COPYING/AUTHORS from
      ffmpeg, x264, x265; plus notices for maplibre-native (BSD-2), maplibre-gl (BSD-3),
      pngjs (MIT), Node/V8/libuv/OpenSSL, Tauri, and the Rust crate set (auto-generate via
      `cargo-about`).
- [ ] Add an in-app **"Open-source notices"** screen surfacing the above.
- [ ] Take the **Artistic** option for ExifTool; bundle `exiftool_files/` + its Perl
      license on Windows.
- [ ] **Never** ship a `--enable-nonfree` build.
- [ ] Keep the invocation model as-is (separate subprocess, no linking) — do not statically
      or dynamically link x264/x265/ffmpeg into the TrailCut binary; the aggregation
      argument depends on it.
- [ ] **Separately:** legal sign-off on HEVC/AVC **patent** posture (independent of the
      above) + map-tile/Esri-imagery commercial ToS review.
- [ ] If **App Store** is later chosen → this checklist is void; switch to Option 3
      (commercial x265 + non-GPL H.264 path).

---

### Sources

- FSF GNU GPL FAQ — [#MereAggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation),
  [#GPLInProprietarySystem](https://www.gnu.org/licenses/gpl-faq.html#GPLInProprietarySystem)
- FFmpeg — [License and Legal Considerations](https://www.ffmpeg.org/legal.html)
- x265 — [readthedocs introduction](https://x265.readthedocs.io/en/stable/introduction.html),
  [x265.org](https://www.x265.org/), [videolan.org/developers/x265.html](https://www.videolan.org/developers/x265.html);
  x264/x265 commercial licensing via [opensalessolutions.net](https://opensalessolutions.net/licensing/)
- kvazaar (LGPLv2.1) quality vs x265 — [Springer, J. Real-Time Image Proc. 2024](https://link.springer.com/article/10.1007/s11554-024-01429-5)
- HEVC patents — [Wikipedia: HEVC](https://en.wikipedia.org/wiki/High_Efficiency_Video_Coding),
  [Access Advance HEVC](https://accessadvance.com/licensing-programs/hevc-advance/),
  [ip fray: Access Advance acquires Via LA HEVC/VVC pools](https://ipfray.com/breaking-access-advance-acquires-via-licensing-alliances-hevc-vvc-patent-pools/)
- H.264/AVC patents — [Via LA AVC/H.264](https://www.via-la.com/licensing-programs/avc-h-264/),
  [MPEG LA AVC briefing (PDF)](https://www.mpegla.com/wp-content/uploads/avcweb.pdf)
- App Store vs GPL (VLC) — [FSF: VLC enforcement](https://www.fsf.org/blogs/licensing/vlc-enforcement),
  [FSF: more about App Store GPL enforcement](https://www.fsf.org/blogs/licensing/more-about-the-app-store-gpl-enforcement),
  [9to5Mac](https://9to5mac.com/2011/01/07/vlc-for-ios-removed-from-the-app-store/)
- ExifTool license — [exiftool.org](https://exiftool.org/), [Wikipedia: ExifTool](https://en.wikipedia.org/wiki/ExifTool)

*Prepared for the TrailCut ship review. Analysis to inform a decision — not legal advice.*
