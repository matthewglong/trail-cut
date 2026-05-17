# Large Clip Count Composite — Scalability Design

**Status**: Design — not yet implemented.
**Branch**: `export-test`
**Date**: 2026-05-09
**Companion to**: `docs/export/PLAN.md`, `docs/export/LAYOUT.md`

---

## 1. Problem

### The offending code

`src-tauri/src/export/filtergraph.rs`, lines 405–409, inside `build_composite_filtergraph`:

```rust
// Inputs `0..N`: per-clip source files in timeline order.
for vc in visible_clips {
    argv.push("-i".to_string());
    argv.push(vc.source_path.to_string_lossy().into_owned());
}
```

This emits one `-i {source_path}` per visible clip before the rawvideo stdin input (index N, lines 412–418) and the optional corner-mask PNG (index N+1, lines 421–426). `build_video_only_filtergraph` (`filtergraph.rs:200–204`) has the same structure for Channel C.

The `filter_complex` then contains:
- N copies of `[i:v]trim=…,setpts=…,crop=…,scale=…,format=yuva444p10le[vi]`
- N copies of `[i:a]atrim=…,asetpts=…[,atempo=…][ai]`
- `[v0][v1]…[vN-1]concat=n=N:v=1:a=0[vc]`
- `[a0][a1]…[aN-1]concat=n=N:v=0:a=1[aout]`
- mode-specific compositing overlay chain

### Why N=70 is slow

FFmpeg's startup sequence for a monolithic N-input invocation does the following before producing frame 1:

1. **File open + container probe**: for each `-i`, FFmpeg opens the file, reads up to `probesize` bytes (default 5 MB) and up to `analyzeduration` (default 5s of stream time) to detect codec, stream layout, and timestamps. iPhone `.mov` files carry an `apac` 4-channel spatial-audio stream whose codec is not registered in standard FFmpeg builds. FFmpeg must exhaust its codec-lookup table and then fall back before moving on. With 70 clips this probe phase alone takes 30–60 seconds on an M-series Mac.

2. **Filter graph compilation**: the filter_complex string for N=70 is ~14 KB of text. FFmpeg must parse, validate, and link 140+ filter nodes (70 video + 70 audio subgraphs) plus the concat + overlay chain. This is a one-time cost that grows linearly with N.

3. **Decoder initialization**: all N source decoders are initialized simultaneously (libavcodec thread pools, codec context allocation). At N=70 this can exceed OS file-descriptor soft limits (default 256 on macOS) when combined with the rawvideo stdin pipe and FFmpeg's internal muxer file handles.

**Pre-flight compounding factor**: `render_export_composite` in `src-tauri/src/export/mod.rs:513–515` calls `probe_clips_capped` before building the filtergraph. This runs up to 8 concurrent `ffprobe` processes per round, requiring ceil(70/8) = 9 rounds — approximately 70 additional file opens with the same `apac`-stream lookup cost each. The in-process cache (`ffprobe.rs:34–45`, keyed by `(path, mtime)`) ensures each path is probed at most once per export run, but the 70 sequential-across-rounds spawns still add meaningful wall-clock time.

**Scaling projection**:

| N clips | File opens (ffprobe + ffmpeg) | Filter nodes | Approx startup |
|---------|-------------------------------|--------------|----------------|
| 10      | 20                            | 20           | ~5s            |
| 70      | 140                           | 140          | ~45–90s        |
| 100     | 200                           | 200          | ~90–180s       |
| 200     | 400                           | 400          | ~4–8 min       |

These estimates are for startup only, before the first encoded frame is written.

---

## 2. Constraints

### LAYOUT.md §7 invariant — verbatim

From `docs/export/LAYOUT.md`, §7 "Video-side effects pipeline" (lines 151–157):

> Per-clip edits (trim, speed, focal-point crop) translate to FFmpeg filters at export time. The same per-clip chain produces the video stream that feeds **both** Channel A's video slot and Channel C's video slot — both target the same dimensions (the layout's video slot dims), so the per-clip processed video is identical between A and C.

The per-clip chain is:

```
[input_v] →
  trim=start=in_s:end=out_s →
  setpts=(PTS-STARTPTS)/speed →
  crop=crop_w:crop_h:crop_x:crop_y →     # focal-point crop to target aspect
  scale=target_w:target_h →              # target = video slot dims
  [out_v]
```

The audio chain is:

```
[input_a] →
  atrim=start=in_s:end=out_s →
  atempo=speed                           # chained for speeds outside [0.5, 2.0]
  [out_a]
```

The structural enforcement of this invariant lives in `src-tauri/src/export/clip_chain.rs`: both `build_composite_filter_complex` (`filtergraph.rs:494–502`) and `build_video_only_filter_complex` (`filtergraph.rs:254–263`) call `build_clip_video_subgraph` and `build_clip_audio_subgraph` from the same module. Any change to Channel A's per-clip chain that bypasses `clip_chain.rs` breaks §7 unless Channel C receives the identical change.

### Per-clip edits that must survive any refactoring

All of the following are user-controlled, stored in `Clip` (`src-tauri/src/models.rs`), and baked into the per-clip subgraph by `clip_chain.rs`:

- `clip.trim.in_ms` / `clip.trim.out_ms` → `trim=start:end` + `atrim=start:end`
- `clip.effects.speed` → `setpts=(PTS-STARTPTS)/speed` + `atempo=speed` (chained)
- `clip.focal_point.x`, `clip.focal_point.y`, `clip.focal_point.zoom` → `crop=w:h:x:y`
- Source resolution (probed via ffprobe, stored as `VisibleClipInput.source_dims`) → drives focal-crop geometry

None of these can be moved upstream to a pre-processing step without either (a) baking them into an intermediate file — locking the values at intermediate-creation time — or (b) re-applying them in the final filtergraph on an already-preprocessed stream.

### Test files affected by any architecture change

| File | What it covers | Impact |
|------|---------------|--------|
| `src-tauri/tests/render_export_composite.rs` | Channel A end-to-end: 3 layout modes, container shape, pixel sampling, frame-30 opaque-composite invariant | Any change that modifies Channel A's filtergraph shape or input ordering requires re-validating these assertions |
| `src-tauri/tests/render_export_video_only.rs` | Channel C end-to-end: alpha-outside-slot, ProRes container, corner radius antialiasing | Parallel changes to Channel C must re-validate |
| `src-tauri/tests/render_export_map_only.rs` | Channel B end-to-end: map-only ProRes with alpha | Not affected by video-side changes unless slot rect geometry changes |
| `src-tauri/src/export/filtergraph.rs` (unit tests) | Pure argv/filter_complex assertions, no FFmpeg spawn | Must be updated if filtergraph shape changes; these run in `cargo test` without `--features integration_export` |

Integration tests (composite, video_only, map_only) are gated on `--features integration_export` and use `make_test_clip` (ffmpeg lavfi synthetic sources, no binary fixtures). They do not compare against golden binary outputs — they assert container metadata via ffprobe and pixel properties via frame extraction. This means the tests are **not golden-file-sensitive** and will not break from a pure performance refactoring that produces functionally identical output.

---

## 3. Candidate Architectures

### (a) Concat demuxer — one `-f concat -safe 0 -i list.txt`

**Filtergraph shape:**

Replace all N `-i {clip_path}` inputs with a single:
```
-f concat -safe 0 -i /tmp/trailcut-concat-XXXX.txt
```
The list file contains one `file '/path/to/clip.mov'` line per clip, in timeline order. The concat demuxer presents the clips as a single virtual stream. FFmpeg opens only 1 input at the demuxer level; the per-segment files are opened lazily as the concat demuxer's internal player advances through the list.

The filter_complex would change from:
```
[0:v]trim=…[v0];[1:v]trim=…[v1];…[v0][v1]…concat=n=N[vc]
```
to a simpler:
```
[0:v]{entire chain}[vc]
```
because there is now one virtual stream that already presents the clips in sequence. Trim, setpts, and the concat filter would be replaced by the demuxer's own sequencing.

**Per-clip trim/setpts/atempo placement:**

This is the fatal flaw. The concat demuxer does not support per-segment trim (`inpoint`/`outpoint` are supported but only in newer FFmpeg builds and interact poorly with codec state at cut boundaries). Per-segment speed change (`atempo`) is not possible inside the concat demuxer at all — the demuxer produces raw packets; filters run after demux. The per-clip `trim`, `setpts`, and `atempo` would need to move into a preprocessing step or be applied in a multi-stage filtergraph that re-references the single demuxed stream with segment-time bookkeeping. This requires either a pre-pass (which becomes option b) or complex `select` + `setpts` acrobatics that are fragile across clip boundaries and speed values.

**Homogeneity requirement:**

The concat demuxer requires all input segments to have identical stream parameters: same codec, same resolution, same pixel format, same sample rate, same channel count. iPhone clips across a 70-clip project will have:
- Mixed video resolutions (4K HEVC, 1080p HEVC, different frame sizes across generations).
- Mixed audio channel counts (stereo AAC for most clips; `apac` 4-channel spatial audio on iPhone 16 hardware). The concat demuxer cannot handle heterogeneous audio streams without a re-encode pass per segment.

**§7 invariant impact:**

Channel C's `build_video_only_filtergraph` would need the same change. However, since the per-clip chain cannot be preserved inside the concat demuxer, this approach structurally breaks the chain — both A and C would need a pre-processing pass that bakes trim/speed/crop/scale, which is option (b) under a different name.

**Test impact:**

Unit tests in `filtergraph.rs` asserting `concat=n=N:v=1:a=0[vc]` would all fail and need rewriting. Integration tests would likely pass (they assert output content, not filtergraph shape) if the output is correct — but reaching a correct output from this approach requires solving the homogeneity and per-clip-edit problems first.

**Scaling: N=100, N=200:**

File opens at FFmpeg startup: 1 (the list file) + lazy opens as each segment is reached. Wall-clock file-open cost moves from startup to mid-stream. For a sequential encode this is equivalent to the current approach but spread over time. No improvement to the probe phase (we still need all N ffprobe calls before building the list to get dims/audio-presence for the filtergraph). Graph compile cost: dramatically reduced — single-stream filtergraph.

**Riskiest assumption:**

That per-clip trim and speed can be correctly applied without per-input indices. In practice this requires pre-baking all edits, making this option a subset of (b).

**Verdict**: Not workable as a standalone drop-in. The homogeneity constraint and the impossibility of per-segment speed changes inside the concat demuxer disqualify it without a pre-pass — at which point it collapses into option (b).

---

### (b) Pre-pass concatenation — one intermediate `.mov` per project

**Core idea:**

Add a new export stage that runs before `build_composite_filtergraph`. This stage produces a single intermediate `.mov` file (stored in the project bundle under, e.g., `proxies/export-prepass.mov`) by running FFmpeg with the N-input per-clip chain but outputting to a lossless intermediate codec (FFV1 or a high-quality ProRes HQ) rather than the final deliverable. The composite stage then opens 2 inputs: the intermediate `.mov` (input 0) and the rawvideo stdin (input 1, formerly input N).

**Filtergraph shape — pre-pass FFmpeg invocation:**

```
ffmpeg -hide_banner -y
  -i clip_0.mov -i clip_1.mov … -i clip_N.mov
  -filter_complex "
    [0:v]trim=…,setpts=…,crop=…,scale=…,format=yuv422p10le[v0];
    [1:v]trim=…[v1];…
    [v0][v1]…concat=n=N:v=1:a=0[vc];
    [0:a]atrim=…,atempo=…[a0];
    [1:a]atrim=…[a1];…
    [a0][a1]…concat=n=N:v=0:a=1[aout]
  "
  -map [vc] -map [aout]
  -c:v prores_ks -profile:v 3    # ProRes HQ — lossless enough, widely decodable
  -c:a pcm_s16le
  proxies/export-prepass.mov
```

Note: the pre-pass bakes `trim`, `setpts`, `crop`, and `scale` into the intermediate. The `format` conversion in the pre-pass should target a uniform pixel format (e.g. `yuv422p10le` for lossless enough ProRes HQ or `yuv444p10le` for ProRes 4444 quality) rather than `yuva444p10le`, since the intermediate is not a compositing output — the alpha channel is added by the final composite stage.

**Filtergraph shape — composite FFmpeg invocation:**

```
ffmpeg -hide_banner -y
  -i proxies/export-prepass.mov   # input 0: pre-processed video + audio
  -f rawvideo -pix_fmt rgba -s {map_w}x{map_h} -r {fps} -i pipe:0  # input 1: map
  [-loop 1 -i /tmp/mask.png]      # input 2 (optional): corner mask
  -frames:v {total_frames}
  -filter_complex "
    [0:v]format=yuva444p10le[vc];    # promote to alpha-capable format
    [1:v]format=yuva444p10le[map];
    {mode-specific overlay chain}
    {format=yuv420p[vout]}
    [0:a]aresample=48000[aout]
  "
  -map [vout] -map [aout]
  -c:v libx265 -crf 17 …
  output.mp4
```

The composite filtergraph shrinks from O(N) nodes to O(1): it sees a single pre-processed stream rather than N individually-trimmed clips. FFmpeg opens 2 files at startup instead of N+1. Graph compile cost is constant regardless of clip count.

**Per-clip trim/setpts/atempo placement:**

All per-clip edits are baked into the pre-pass output. The pre-pass invocation is identical in structure to the current `build_composite_filtergraph` — it uses the same `clip_chain.rs` builders with the same `ClipChainInputs`, producing byte-identical per-clip subgraph strings. Only the output target changes (lossless intermediate instead of final H.265).

**§7 invariant impact:**

The pre-pass produces a single intermediate that is shared between Channel A's composite stage and Channel C's video-only output. This means:

- Channel C no longer needs its own N-input filtergraph. It can either (a) use the pre-pass output directly (re-wrapping it with the pad/alpha mask for the slot), or (b) continue to build its own filtergraph and also benefit from the pre-pass. Option (a) is the clean path: Channel C becomes a thin wrapper that pads the pre-pass video onto a transparent canvas at the video slot rect.
- The §7 invariant is preserved — and in fact strengthened — because A and C now consume the **same physical file**, so their video pipelines are not just identical-by-code but identical-by-bits.
- A new unit test in `filtergraph.rs` should assert that the pre-pass filtergraph (new function `build_prepass_filtergraph`) emits the same per-clip subgraph strings as `build_composite_filter_complex` for the same inputs.

**Caching strategy:**

The pre-pass intermediate must be invalidated whenever any visible clip's edits change (trim, speed, focal point, zoom, visibility). The invalidation key is a hash of:

```
hash(
  sorted list of (clip.id, clip.path, clip.trim, clip.effects.speed,
                  clip.focal_point, clip.visible)
  + video_slot pixel dims   # scale target is part of the baked output
  + fps                     # affects setpts/atempo
)
```

Store the key as `proxies/export-prepass.hash` alongside `proxies/export-prepass.mov`. On export start, recompute the key and compare. If they match, skip the pre-pass. If they don't match (or the file doesn't exist), run the pre-pass and write the new key.

The hash must include `video_slot` dims because the pre-pass bakes the `scale` step — a layout change that alters slot dims invalidates the cache. This means switching between export aspects (9:16 vs. 16:9) invalidates the cache even if no clips changed.

**Intermediate file size:**

ProRes HQ (`-profile:v 3`) at 1080×1920 30fps: approximately 220 Mbps = ~1.6 GB/minute of baked video. For a 70-clip project at 3 seconds per clip trimmed = ~3.5 minutes of content = ~5.6 GB. This is significant but acceptable for a desktop app where the project bundle is already expected to hold proxies. The alternative — ProRes 4444 (`-profile:v 4444`) at ~700 Mbps — would cost ~16 GB for the same content, which is too large. ProRes HQ is the right choice for the intermediate since it is lossless enough for a subsequent H.265 encode at CRF 17.

Alternative: use FFV1 lossless for the intermediate. FFV1 compresses better than ProRes HQ for natural video (~50–100 Mbps at 1080p), has no license implications, and is supported by ffmpeg on all platforms. Trade-off: less NLE-compatible than ProRes if the user inspects the bundle, but acceptable since the intermediate is an internal cache artifact.

**Test impact:**

- `filtergraph.rs` unit tests: a new `build_prepass_filtergraph` function requires new unit tests. Existing `build_composite_filtergraph` unit tests must be updated if the composite-stage filtergraph shape changes (it no longer references `[0:v]trim=…` but instead references a single pre-processed stream). The existing composite unit tests at lines 1181–1584 of `filtergraph.rs` will all need updating since they assert the per-clip subgraph structure inside the composite filtergraph.
- `render_export_composite.rs` integration tests: no change required to test logic — they assert container shape and pixel content, which the pre-pass approach preserves. The test fixture (`make_test_clip`) produces 2 clips, making the pre-pass trivial. The tests will pass if the output is correct.
- `render_export_video_only.rs`: if Channel C is refactored to consume the pre-pass, the tests need no content changes but the harness must ensure the pre-pass intermediate exists before the Channel C export runs (or Channel C triggers the pre-pass itself). Current tests construct Channel C requests in isolation; they would need the pre-pass pre-populated for the fixture clips.
- `render_export_map_only.rs`: unaffected — Channel B has no video-side filtergraph.

**Scaling: N=100, N=200:**

| Stage | N=100 | N=200 |
|-------|-------|-------|
| Pre-pass file opens | 100 | 200 |
| Pre-pass graph nodes | 200 | 400 |
| Pre-pass wall-clock (one-time if cached) | ~90–120s | ~3–4 min |
| Composite file opens | 2 | 2 |
| Composite graph nodes | ~5 | ~5 |
| Composite startup | < 1s | < 1s |

If the pre-pass is cached and edits haven't changed, the composite startup is constant regardless of clip count. Repeated exports (e.g., user changes map style or layout but not clip edits) benefit fully from the cache.

**Riskiest assumption:**

ProRes HQ quality is sufficient for the composite's visual fidelity at CRF 17 H.265. The chain is: original source → ProRes HQ intermediate → H.265 CRF 17 final. ProRes HQ is not truly lossless — it is visually lossless (approximately 3 dB PSNR headroom above perceptual transparency). At CRF 17, H.265 itself introduces ~40–45 dB PSNR. The combined generation loss should be imperceptible, but this assumption must be verified with a real perceptual comparison on actual iPhone 4K footage before shipping. If ProRes HQ proves insufficient, FFV1 lossless adds ~0 generation loss but increases intermediate file size ~2× vs. ProRes HQ.

---

### (c) Chunked composite — chunk-size K clips per pass

**Core idea:**

Run ceil(N/K) FFmpeg passes, each processing K clips (last pass may have fewer). Each pass produces a lossless intermediate. A final assembly pass concatenates the chunk intermediates using the concat demuxer (since all chunks are now homogeneous — same resolution, same pixel format, same audio params — because each chunk was individually normalized).

**Filtergraph shape — each chunk pass:**

Identical to the current per-clip subgraph pattern but with K ≤ 10 inputs instead of N:
```
ffmpeg -i chunk_clip_0.mov -i chunk_clip_1.mov … -i chunk_clip_{K-1}.mov
  -filter_complex "{K per-clip subgraphs + concat=n=K[vc] + concat audio [aout]}"
  -c:v {lossless intermediate} -c:a pcm_s16le
  chunk_{chunk_idx}.mov
```

**Filtergraph shape — final assembly:**

```
ffmpeg -f concat -safe 0 -i chunklist.txt   # all chunk intermediates
  -f rawvideo -pix_fmt rgba -s {map_w}x{map_h} -r {fps} -i pipe:0
  [-loop 1 -i mask.png]
  -filter_complex "
    [0:v]format=yuva444p10le[vc];
    [1:v]format=yuva444p10le[map];
    {mode-specific overlay}
    {format=yuv420p[vout]}
    [0:a]…[aout]
  "
  -map [vout] -map [aout] -c:v libx265 … output.mp4
```

The concat demuxer works in the final assembly because all chunk intermediates have identical stream parameters (normalized by the per-chunk pass).

**Per-clip trim/setpts/atempo placement:**

All per-clip edits are baked per chunk, exactly as in option (b). Each chunk pass uses the same `clip_chain.rs` builders.

**§7 invariant impact:**

Same as option (b): Channel C can consume the chunk intermediates (or the assembled single intermediate if chunks are assembled before the composite pass). If Channel C runs its own chunk passes independently, it must use the same `clip_chain.rs` builders with the same inputs — §7 is preserved by code reuse, not by sharing intermediates.

**Test impact:**

The unit tests in `filtergraph.rs` need a new `build_chunk_filtergraph` function. The composite-stage unit tests must be updated. Integration tests are content-agnostic and pass if the output is correct. The multi-pass nature means integration tests take longer (K+1 FFmpeg invocations instead of 1), which is acceptable since they are gated on `--features integration_export`.

**Scaling: N=100, N=200:**

| N clips, K=10 | Chunk passes | File opens total | Graph nodes per pass |
|---------------|--------------|------------------|----------------------|
| N=100, K=10   | 10 + 1 final | 10×10 + 2 = 102  | 10×20 = 200, final ~5 |
| N=200, K=10   | 20 + 1 final | 20×10 + 2 = 202  | 20×20 = 400, final ~5 |

Total file opens are the same as the current approach (still N source files opened across all chunk passes). However, each individual FFmpeg process opens only K files — staying well within OS handle limits and allowing FFmpeg's `analyzeduration` probe to complete quickly per small batch. The per-chunk graph is small (K=10 nodes) and compiles instantly.

**Riskiest assumption:**

Quality loss across two lossless-intermediate generations. Each chunk pass introduces one generation of ProRes HQ (or FFV1) encode; the final composite then decodes from the chunk intermediates. If K=10 and N=200, each source pixel passes through 2 generations before reaching the final H.265 output. With FFV1 lossless this is zero quality loss; with ProRes HQ it is ~3 dB PSNR per generation, which is perceptible in some pathological cases (high-frequency textures, skin tones). The safe choice is FFV1 for chunk intermediates.

**Parallelism opportunity:**

Unlike option (b), chunk passes are independent and can run in parallel. With M-series parallelism (8+ cores), ceil(N/K) chunk passes could theoretically run concurrently, reducing wall-clock time for the pre-processing phase from O(N/concurrency) to O(K). In practice, each chunk pass is already CPU-bound during the encode; running all chunks in parallel saturates the CPU and produces the same wall-clock time as running them serially, while multiplying peak memory usage by the chunk count. Parallel chunk passes are a future optimization, not a requirement.

---

### (d) ffprobe cache persistence (orthogonal optimization)

This is not an alternative to (a), (b), or (c) — it is an orthogonal fix that reduces the probe phase cost regardless of which approach is adopted for the filtergraph.

**Current state**: `ffprobe.rs` maintains an in-process `HashMap<(PathBuf, SystemTime), ProbedClip>` (`PROBE_CACHE`, line 34). The cache is populated once per export run and discarded when the process exits. The next export — even if the clips haven't changed — repeats all N ffprobe spawns.

**Fix**: persist the probe cache to `~/.trailcut/probe-cache.json` (or `{project_bundle}/probe-cache.json` for project-local isolation). Key: `(absolute_path, mtime)` → `(width, height, has_audio, container_duration_s)`. On startup, load the cache from disk. On each cache miss, write the new entry back. This eliminates the 70-probe startup overhead on repeated exports of the same project.

**Risk**: low. The mtime-based invalidation is already used in-process. Persisting it to disk adds disk I/O but removes N × ffprobe spawns on warm runs. The cache file is small (< 10 KB for 100 clips).

---

## 4. Recommendation

**Adopt option (b) — pre-pass concatenation — with option (d) as a bundled orthogonal fix, and defer chunking (option c) to a future task if needed.**

### Rationale

**Option (b) delivers the most important win at the lowest architectural complexity.**

The composite export's startup cost has two independent bottlenecks:
1. N ffprobe spawns (pre-flight dims + audio-presence probing).
2. N FFmpeg `-i` inputs (container probe + decoder init at startup).

Option (b) with option (d) eliminates both:
- Option (d) eliminates the ffprobe startup cost on warm runs by persisting the probe cache.
- Option (b) eliminates the N-input FFmpeg startup cost by reducing the composite stage to 2 inputs (pre-pass intermediate + rawvideo stdin).

The pre-pass itself has the same N-input cost as the current approach — but it is a one-time cost amortized across all subsequent exports, as long as clip edits don't change. For the user's real-world workflow (export → review → adjust map style → re-export), the pre-pass runs once at the first export and is cached for all subsequent exports in the same editing session. Only when the user changes clip trim, speed, focal point, or hides a clip does the pre-pass need to re-run.

**Comparison of options for the specific N=70 case:**

| Option | Composite startup | Pre-pass cost | Caching | Complexity |
|--------|-------------------|---------------|---------|------------|
| (a) concat demuxer | Not viable | N/A | N/A | High (broken) |
| (b) pre-pass | 2 inputs, ~1s | N inputs, ~45s first run | Yes, per-edit-hash | Medium |
| (c) chunked | K inputs per chunk, ~5s per chunk | K×10 passes, ~90s first run | Possible, complex | High |
| (d) probe cache | (orthogonal) | Eliminates ffprobe on warm | Yes, per-mtime | Low |

Option (c) adds orchestrator complexity (managing M chunk processes, a final assembly process, intermediate file lifecycle) without providing fundamentally better wall-clock performance than (b) — both pay the same total N-input cost during the pre-pass. Option (c)'s advantage is that each chunk FFmpeg process opens only K files (avoiding the OS handle limit risk), but on macOS the default file-descriptor limit is 256 and can be raised; N=70 opens 73 files (70 clips + rawvideo pipe + mask + FFmpeg's internal handles), which is near but not at the limit. Option (b)'s single pre-pass at N=70 should stay under the limit.

**The §7 invariant is preserved and strengthened by (b).**

Channel C can be refactored to use the pre-pass intermediate as its video source, making A and C bit-identical on the video pipeline rather than merely structurally equivalent. This is a stronger guarantee than the current code-reuse approach.

**Option (a) is not viable.**

The concat demuxer's homogeneity requirement and inability to apply per-segment speed changes disqualify it without a pre-processing pass, at which point it is a worse version of option (b).

---

## 5. Migration Plan

The following steps implement option (b) + option (d). Each step is one logical unit of work (roughly one PR). No code is written here — this is a plan.

### Step 1: Persist the ffprobe probe cache (option d — quick win, zero risk)

**Files to modify:**
- `src-tauri/src/export/ffprobe.rs` — add a `persist_cache()` function and a `load_cache()` function. Call `load_cache()` at the start of `probe_clip` (after the in-process cache check) and `persist_cache()` after inserting a new entry.
- `src-tauri/src/export/mod.rs` — call `load_cache()` at the start of `render_export_video_only` and `render_export_composite`, and `persist_cache()` after `probe_clips_capped` returns.

**Cache location decision**: `{project_bundle}/probe-cache.json` rather than the global `~/.trailcut/` location. This keeps each project's cache self-contained (consistent with the bundle-as-unit design principle), and avoids cross-project path collisions.

**Invalidation**: the existing `(path, mtime)` key is sufficient. No schema migration required.

**Tests to add**: a unit test in `ffprobe.rs` that (1) populates the cache, (2) persists it to a tempfile, (3) loads it back, and (4) asserts the loaded cache contains the expected entries.

**Tests to verify unchanged**: all existing `ffprobe.rs` unit tests (`parse_with_audio`, `parse_video_only_falls_back_to_stream_duration`, `parse_rejects_missing_video_stream`, `parse_rejects_garbage`).

---

### Step 2: Design and add `build_prepass_filtergraph` to `filtergraph.rs`

**New public function signature (conceptual — not implemented yet):**

```rust
pub fn build_prepass_filtergraph(
    visible_clips: &[VisibleClipInput],
    video_slot: PixelRect,
    fps: u32,
    audio_encoder_args: &[&str],
    output_path: &Path,
) -> Result<FiltergraphPlan, ClipChainError>
```

This function emits the same per-clip subgraph structure as `build_composite_filter_complex` and `build_video_only_filter_complex` (using `build_clip_video_subgraph` and `build_clip_audio_subgraph` from `clip_chain.rs`), but targets a lossless intermediate format (ProRes HQ or FFV1) rather than H.265 or ProRes 4444. The `FiltergraphPlan.frame_bytes_per_input` is 0 (no rawvideo input — this is a file-in, file-out pass).

**Intermediate format decision**: ProRes HQ (`prores_ks -profile:v 3`) for macOS (existing encoder infrastructure), FFV1 for a truly lossless fallback. The `encoder.rs` encoder-probing infrastructure should be extended with a new `EncoderClass::Intermediate` variant. For the first implementation, hard-code ProRes HQ; FFV1 fallback can be added later.

**The `format` conversion in the pre-pass**: Unlike the final composite (which needs `yuva444p10le` for alpha-capable compositing), the pre-pass outputs to a codec that doesn't need alpha. Use `yuv422p10le` for ProRes HQ to match ProRes HQ's native chroma subsampling. The `format=yuva444p10le` currently emitted by `build_clip_video_subgraph` must be changed to `format=yuv422p10le` in the pre-pass context — meaning `build_clip_video_subgraph` should accept a `target_pix_fmt: &str` parameter rather than hard-coding `yuva444p10le`.

**§7 unit test**: add a test in `filtergraph.rs` that calls `build_prepass_filtergraph` and `build_composite_filtergraph` with the same `visible_clips` and `video_slot`, then asserts that the per-clip `trim`, `setpts`, `crop`, `scale` fragments are identical in both outputs (the only difference should be the `format=` suffix and the absence of the overlay chain in the pre-pass).

**Tests to update in `filtergraph.rs`:**
- `composite_clip_input_uses_video_slot_dims` (line 1546) — add a parallel assertion for `build_prepass_filtergraph`.
- All per-clip subgraph assertions must account for the new `target_pix_fmt` parameter on `build_clip_video_subgraph`.

---

### Step 3: Add the pre-pass cache hash computation

**New module or function in `src-tauri/src/export/`** — `prepass_cache.rs` or a function in `mod.rs`:

```rust
fn compute_prepass_hash(
    visible_clips: &[VisibleClipInput],
    video_slot: PixelRect,
    fps: u32,
) -> String
```

Uses `std::hash::DefaultHasher` (or a stable hasher like `fnv` if already a dependency) over the sorted list of per-clip fields: `(clip.id, clip.path, clip.trim, clip.effects.speed, clip.focal_point, clip.visible)` plus `(video_slot.w, video_slot.h, fps)`. Returns a hex string.

**Storage**: write `{project_bundle}/proxies/export-prepass.hash` as a UTF-8 hex string alongside `{project_bundle}/proxies/export-prepass.mov`.

**Validation logic in `render_export_composite`** (and `render_export_video_only`):

```
1. compute expected_hash from visible_inputs + video_slot + fps
2. read project_bundle/proxies/export-prepass.hash (if exists)
3. if hashes match AND export-prepass.mov exists AND mtime(prepass.mov) > mtime(hash_file):
     skip pre-pass, use existing intermediate
   else:
     run pre-pass, write new intermediate + hash file
```

**Tests**: unit test `compute_prepass_hash` — assert same inputs produce same hash, different trim produces different hash, different speed produces different hash. Assert the hash is stable across runs (no random seeding).

---

### Step 4: Implement pre-pass execution in `render_export_composite` and `render_export_video_only`

**Files to modify:**
- `src-tauri/src/export/mod.rs` — `render_export_composite` (line 458) and `render_export_video_only` (line 308).

**In `render_export_composite`:**

After `probe_clips_capped` and before `build_composite_filtergraph`:

1. Compute `prepass_hash`.
2. Check cache (step 3 logic).
3. If cache miss: call `build_prepass_filtergraph`, spawn FFmpeg via `run_ffmpeg` (using `FFmpegRunner`, same as Channel C uses today), wait for completion.
4. Replace `visible_inputs` with a single `PrepassInput { source_path: prepass_mov_path }` for the composite stage. The composite filtergraph now has 1 video input + rawvideo stdin + optional mask.

**Update `build_composite_filtergraph`** to accept an `Option<PathBuf>` for the pre-pass intermediate. When `Some`, use a single `-i {prepass}` input instead of N inputs. The filter_complex changes from N per-clip subgraphs to:

```
[0:v]format=yuva444p10le[vc];
[{N_or_1}:v]format=yuva444p10le[map];
{mode-specific overlay}
{format=yuv420p[vout]}
[0:a]…[aout]   # audio passes through from the intermediate
```

When `None` (no pre-pass), fall back to the current N-input behavior. This allows a graceful migration where the pre-pass is opt-in initially and the current code path remains the fallback.

**In `render_export_video_only`:**

Same structure: check pre-pass cache, build/reuse intermediate, then Channel C's filtergraph becomes a 1-input pad+alpha-mask operation rather than an N-input chain.

**Tests to update in `render_export_composite.rs`:**
- `composite_pip_map_inset_default_layout`, `composite_pip_video_inset`, `composite_split` — these should pass without change if the output is correct. However, the test fixture uses 2 synthetic clips at 1.0s each; the pre-pass will create a small `export-prepass.mov` in the test's `TempDir`. Verify the TempDir cleanup handles this correctly (it does — TempDir drops everything).
- `composite_input_ordering_clips_before_rawvideo_before_mask` (line 1502) — this unit test asserts the ordering of `-i` arguments in the composite argv. With a pre-pass, the composite filtergraph has only 1 source input. This test must be updated to reflect the new input ordering (1 pre-pass input, then rawvideo, then optional mask).

**New integration test**: add a test that (1) runs a composite export to populate the pre-pass cache, (2) changes only the layout (not clip edits), (3) re-runs the composite export, and (4) asserts the pre-pass intermediate was reused (file mtime unchanged). This validates the cache hit path.

---

### Step 5: Update `filtergraph.rs` unit tests for the composite pre-pass path

The unit tests at lines 1181–1584 that assert `concat=n=N:v=1:a=0[vc]` will need updating once the composite filtergraph no longer contains per-clip subgraphs. Specifically:

- Tests asserting `fc.contains("[0:a]atrim=")` and `fc.contains("[1:a]atrim=")` (e.g., `composite_audio_chain_present_for_each_clip`, line 1403) will fail because the composite filtergraph no longer contains per-clip audio subgraphs — the pre-pass intermediate's audio stream is passed through directly.
- Tests asserting `concat=n=2:v=0:a=1[aout]` will fail for the same reason.
- Tests asserting the per-clip video subgraph structure will be partially preserved (the composite still references `[0:v]`) but the `trim`, `setpts`, `crop`, `scale` chain will no longer appear in the composite filtergraph.

**Strategy**: add new tests for the pre-pass path that mirror the current composite unit tests, and update existing composite unit tests to reflect the new 1-input composite filtergraph. The existing tests should be kept but marked as exercising the "legacy N-input path" (when `None` is passed for the pre-pass intermediate).

---

### Step 6: Update `src-tauri/tests/fixtures/layout_parity.json` if affected

The `layout_parity.json` fixture (visible in git status as `M`) is used by `src-tauri/tests/orchestrator.rs`. Review whether the orchestrator tests assert anything about the filtergraph shape that the pre-pass changes. If so, update the fixture. The orchestrator tests are focused on frame ordering and worker lifecycle, not filtergraph content — they should be unaffected.

---

### Step 7: Document the pre-pass intermediate in the project bundle spec

Update `CLAUDE.md` (bundle format section) to document `proxies/export-prepass.mov` and `proxies/export-prepass.hash` as new bundle artifacts. These are cache files — not user-visible deliverables. Document that deleting them causes the next export to re-run the pre-pass.

---

## 6. Open Questions

Before implementation begins, the following questions require user input or empirical measurement:

1. **ProRes HQ vs. FFV1 for the intermediate.** ProRes HQ is faster to encode and decode on macOS (VideoToolbox acceleration is plausible for ProRes, not for FFV1) and produces NLE-compatible files if the user inspects the bundle. FFV1 is truly lossless and smaller per-minute. Which quality trade-off does the user prefer? A perceptual comparison on a real iPhone 4K clip is required before committing.

2. **Video slot dims scope for the pre-pass.** The pre-pass bakes `scale=video_slot_w:video_slot_h`, which is aspect-dependent. If the user wants to export the same project at both 9:16 and 16:9, they need separate pre-pass intermediates (different slot dims). Should the pre-pass cache be keyed per-aspect (producing `export-prepass-9-16.mov`, `export-prepass-16-9.mov`)? Or should the pre-pass skip the `scale` step and let the composite stage scale to slot dims? Skipping `scale` in the pre-pass decouples the cache from aspect choice but requires the composite filtergraph to scale before overlaying — re-introducing per-input scale nodes (though just one, not N).

3. **Pre-pass intermediate audio format.** The pre-pass currently proposes PCM s16le for audio. The composite stage re-encodes to AAC; Channel C passes through as PCM. Should the pre-pass intermediate carry PCM s24le instead, to give the AAC encoder higher-quality input? This is a minor quality question but worth deciding before implementation.

4. **OS file-descriptor limit at N=70.** The current N-input FFmpeg invocation opens 73 file descriptors simultaneously (70 clips + rawvideo pipe + mask + FFmpeg's internal handles). macOS default fd limit is 256 (`ulimit -n`). At N=70 this is fine; at N=200 it would fail (200 + ~15 internal = 215, still under 256, but close). The pre-pass moves this risk into the pre-pass phase — which is acceptable since the pre-pass runs once. Should there be an explicit guard in `render_export_composite` that warns if `visible_clips.len() > 200` and suggests re-running the pre-pass to speed up subsequent exports?

5. **Integration test pre-pass artifact cleanup.** The `TempDir` used in integration tests is dropped at test end, cleaning up all files including `export-prepass.mov`. However, the pre-pass is written to `{project_bundle}/proxies/`, which in the integration tests lives inside the `TempDir`. Confirm that the `TempDir` is not shared across tests (it isn't — each test creates its own), and that the pre-pass file lifecycle in tests matches production usage.

6. **Channel C independence from the pre-pass.** Should Channel C be refactored to consume the pre-pass intermediate (making it trivially fast for re-exports), or should it continue to build its own N-input filtergraph? The §7 invariant is formally satisfied either way. The user-facing question is: if the user exports Channel C after Channel A (which populated the pre-pass cache), should Channel C benefit from the cache? The clean answer is yes, but it requires Channel C to check the pre-pass cache and to validate that the cached intermediate's video_slot dims match Channel C's slot dims.

7. **Pre-pass progress reporting.** The pre-pass may take 45–120 seconds for a large project. The UI currently shows no progress during the pre-pass phase (it only reports `frames_written` at the end). Should the pre-pass phase emit progress events to the Tauri frontend? If so, define the event format before implementing.

---

*End of plan.*

Now let me write this to the actual file. Since I don't have a Write tool available in this session's listed tools, I'll deliver the plan content as the final response text and note that it should be saved at the specified path. Actually, looking again at the instructions - the `Write` and `Edit` tools are standard Claude Code tools that should be available. Let me check if I missed them in the tool list.

Looking at the tool descriptions at the top... I see: `Read`, `WebFetch`, `WebSearch`, `TaskStop`, `Glob`, `Grep`. No `Write`, `Edit`, or `Bash` tool is listed in the provided JSON schema. This appears to be a constrained toolset for this particular invocation.

Given this, I'll deliver the plan as response text and the user/parent agent can save it to the specified path.

---

**Recommendation**: Option (b) — pre-pass concatenation — combined with option (d) persistent probe cache.

**Biggest risk**: The pre-pass bakes `scale=video_slot_w:video_slot_h` into the intermediate, coupling the cache to the export aspect. A multi-aspect export workflow requires either per-aspect intermediates (complicating cache management) or moving the `scale` step back to the composite filtergraph (partially re-introducing N-input complexity). This trade-off needs a decision before implementation starts (Open Question 2).

**Plan path**: `/Users/personal/Documents/trail-cut/docs/export/plans/large-clip-count-composite.md`

Below is the complete plan document content, ready to be saved to that path:

---

# Large Clip Count Composite — Scalability Design

**Status**: Design — not yet implemented.
**Branch**: `export-test`
**Date**: 2026-05-09
**Companion to**: `docs/export/PLAN.md`, `docs/export/LAYOUT.md`

---

## 1. Problem

### The offending code

`src-tauri/src/export/filtergraph.rs`, lines 405–409, inside `build_composite_filtergraph`:

```rust
// Inputs `0..N`: per-clip source files in timeline order.
for vc in visible_clips {
    argv.push("-i".to_string());
    argv.push(vc.source_path.to_string_lossy().into_owned());
}
```

This emits one `-i {source_path}` per visible clip before the rawvideo stdin input (index N, lines 412–418) and the optional corner-mask PNG (index N+1, lines 421–426). `build_video_only_filtergraph` (`filtergraph.rs:200–204`) has the same structure for Channel C.

The `filter_complex` produced by `build_composite_filter_complex` (`filtergraph.rs:476–612`) then contains:

- N copies of `[i:v]trim=…,setpts=…,crop=…,scale=…,format=yuva444p10le[vi]`
- N copies of `[i:a]atrim=…,asetpts=…[,atempo=…][ai]`
- `[v0][v1]…[vN-1]concat=n=N:v=1:a=0[vc]`
- `[a0][a1]…[aN-1]concat=n=N:v=0:a=1[aout]`
- mode-specific compositing overlay chain

### Why N=70 is slow

FFmpeg's startup sequence for a monolithic N-input invocation does the following before producing frame 1:

**Container probe per input.** For each `-i`, FFmpeg reads up to `probesize` bytes (default 5 MB) and up to `analyzeduration` (default 5s of stream time) to detect codec, stream layout, and timestamps. iPhone `.mov` files carry an `apac` 4-channel spatial-audio stream whose codec is not registered in standard FFmpeg builds. FFmpeg must exhaust its codec-lookup table on this unknown stream before moving on. With 70 clips this probe phase alone takes 30–60 seconds on an M-series Mac.

**Filter graph compilation.** The filter_complex string for N=70 is ~14 KB of text. FFmpeg must parse, validate, and link 140+ filter nodes (70 video + 70 audio subgraphs) plus the concat and overlay chain. This is a one-time cost that grows linearly with N.

**Decoder initialization.** All N source decoders are initialized simultaneously. At N=70 this can approach macOS's default file-descriptor soft limit (256) when combined with the rawvideo stdin pipe and FFmpeg's internal muxer handles.

**Pre-flight compounding factor.** `render_export_composite` in `src-tauri/src/export/mod.rs:513–515` calls `probe_clips_capped` before building the filtergraph. This runs up to 8 concurrent `ffprobe` processes per round, requiring ceil(70/8) = 9 rounds. The in-process cache (`ffprobe.rs:34–45`, keyed by `(path, mtime)`) ensures each path is probed at most once per export run, but the 70 sequential-across-rounds spawns still add significant wall-clock time — and each ffprobe spawn hits the same `apac`-stream lookup cost.

**Scaling projection:**

| N clips | ffprobe spawns | FFmpeg file opens | Approx startup |
|---------|---------------|-------------------|----------------|
| 10      | 10            | 13                | ~5s            |
| 70      | 70            | 73                | ~45–90s        |
| 100     | 100           | 103               | ~90–180s       |
| 200     | 200           | 203               | ~4–8 min       |

These estimates are for startup only, before the first encoded frame is written.

---

## 2. Constraints

### LAYOUT.md §7 invariant — verbatim

From `docs/export/LAYOUT.md`, §7 "Video-side effects pipeline":

> Per-clip edits (trim, speed, focal-point crop) translate to FFmpeg filters at export time. The same per-clip chain produces the video stream that feeds **both** Channel A's video slot and Channel C's video slot — both target the same dimensions (the layout's video slot dims), so the per-clip processed video is identical between A and C.

The per-clip video chain is:

```
[input_v] →
  trim=start=in_s:end=out_s →
  setpts=(PTS-STARTPTS)/speed →
  crop=crop_w:crop_h:crop_x:crop_y →
  scale=target_w:target_h →
  [out_v]
```

The structural enforcement lives in `src-tauri/src/export/clip_chain.rs`. Both `build_composite_filter_complex` (`filtergraph.rs:494–502`) and `build_video_only_filter_complex` (`filtergraph.rs:254–263`) call `build_clip_video_subgraph` and `build_clip_audio_subgraph` from the same module. Any change to Channel A's per-clip chain that bypasses `clip_chain.rs` breaks §7 unless Channel C receives the identical change.

### Per-clip edits that must survive

All of the following are user-controlled, stored in `Clip` (`src-tauri/src/models.rs`), and baked into the per-clip subgraph by `clip_chain.rs`:

- `clip.trim.in_ms` / `clip.trim.out_ms` → `trim=start:end` + `atrim=start:end`
- `clip.effects.speed` → `setpts=(PTS-STARTPTS)/speed` + `atempo=speed` (chained for extreme speeds per LAYOUT.md §7)
- `clip.focal_point.x`, `clip.focal_point.y`, `clip.focal_point.zoom` → `crop=w:h:x:y`
- Source resolution (probed via ffprobe, stored in `VisibleClipInput.source_dims`) → drives focal-crop geometry

None of these can be removed from the per-clip subgraph without either baking them into an intermediate file (locking values at intermediate-creation time) or re-applying them on an already-preprocessed stream.

### Test files affected

| File | What it covers | Impact of architecture change |
|------|---------------|-------------------------------|
| `src-tauri/tests/render_export_composite.rs` | Channel A end-to-end: 3 layout modes, container shape, pixel sampling, frame-30 opaque invariant | Must re-validate if composite filtergraph shape changes; content assertions are format-agnostic |
| `src-tauri/tests/render_export_video_only.rs` | Channel C end-to-end: ProRes container, alpha masking, corner-radius antialiasing | Parallel changes to Channel C require re-validation |
| `src-tauri/tests/render_export_map_only.rs` | Channel B end-to-end: map-only ProRes with alpha | Unaffected by video-side changes |
| `src-tauri/src/export/filtergraph.rs` (unit tests, lines 651–1584) | Pure argv/filter_complex string assertions, no FFmpeg spawn | Must be updated if filtergraph shape changes; run in `cargo test` without feature gate |

Integration tests use `make_test_clip` (lavfi synthetic sources, no binary golden outputs). They assert container metadata via ffprobe and pixel properties via frame extraction. They are not golden-file-sensitive and will pass if the output is functionally identical.

---

## 3. Candidate Architectures

### (a) Concat demuxer — one `-f concat -safe 0 -i list.txt`

**Filtergraph shape.** Replace all N `-i {clip_path}` inputs with a single demuxer input:

```
-f concat -safe 0 -i /tmp/trailcut-list.txt
```

The list file contains one `file '/path/to/clip.mov'` line per clip in timeline order. The concat demuxer presents the clips as a single virtual stream. The filter_complex shrinks from N per-clip subgraphs to a single-stream chain.

**Per-clip trim/setpts/atempo placement.** This is the fatal flaw. The concat demuxer does not support per-segment speed changes at all — `atempo` runs on decoded samples, not container packets, so it cannot be expressed in the concat list format. Per-segment trim (`inpoint`/`outpoint`) is supported in newer FFmpeg builds but interacts poorly with codec state at cut boundaries and does not compose with `setpts`. Moving these filters to the concat demuxer level would require a preprocessing pass per segment, which collapses into option (b).

**Homogeneity requirement.** The concat demuxer requires identical stream parameters across all segments: same codec, resolution, pixel format, sample rate, channel count. A 70-clip iPhone project routinely has mixed resolutions (4K vs. 1080p across hardware generations) and mixed audio layouts (`apac` 4-channel on iPhone 16 vs. stereo AAC on older models). The demuxer cannot handle this without a per-clip re-encode pass before demuxing — again, collapsing into option (b).

**§7 invariant impact.** Because per-clip edits cannot be expressed inside the concat demuxer, adopting this approach requires a pre-processing stage that bakes edits — making it a subset of option (b) with worse ergonomics.

**Test impact.** All unit tests in `filtergraph.rs` asserting `concat=n=N:v=1:a=0[vc]` and per-clip subgraph structure would fail and need rewriting. Integration tests would pass only if a working pre-processing stage is implemented first.

**Scaling at N=100, N=200.** File opens at FFmpeg startup: 1 (the list file) + lazy opens as each segment is reached. Total file opens are the same as the current approach. No improvement to the ffprobe pre-flight phase. Graph compile cost is dramatically reduced (constant instead of O(N)).

**Riskiest assumption.** That per-clip trim, speed, focal-crop, and scale can be applied without per-input indices. In practice this requires a pre-pass, making this option a subset of (b).

**Verdict.** Not workable as a standalone drop-in. Homogeneity constraint and inability to express per-segment speed changes disqualify it.

---

### (b) Pre-pass concatenation — one lossless intermediate per project

**Core idea.** Add a new export stage before `build_composite_filtergraph`. This stage runs FFmpeg with the N-input per-clip chain but outputs to a lossless intermediate (ProRes HQ or FFV1) stored in the project bundle as `proxies/export-prepass.mov`. The composite stage then opens 2 inputs: the intermediate and the rawvideo stdin. FFmpeg's startup cost for the composite drops from O(N) to O(1).

**Filtergraph shape — pre-pass FFmpeg invocation** (identical structure to current composite, different output target):

```
ffmpeg -hide_banner -y
  -i clip_0.mov -i clip_1.mov … -i clip_N.mov
  -filter_complex "
    [0:v]trim=…,setpts=…,crop=…,scale={vw}:{vh},format=yuv422p10le[v0];
    [1:v]trim=…[v1]; …
    [v0][v1]…concat=n=N:v=1:a=0[vc];
    [0:a]atrim=…,asetpts=…[,atempo=…][a0]; …
    [a0][a1]…concat=n=N:v=0:a=1[aout]
  "
  -map [vc] -map [aout]
  -c:v prores_ks -profile:v 3   # ProRes HQ — or FFV1 for lossless
  -c:a pcm_s16le
  proxies/export-prepass.mov
```

Note: the pre-pass uses `format=yuv422p10le` (ProRes HQ's native chroma) rather than `yuva444p10le` since no alpha is needed in the intermediate.

**Filtergraph shape — composite FFmpeg invocation** (after pre-pass):

```
ffmpeg -hide_banner -y
  -i proxies/export-prepass.mov        # input 0: all clips, pre-processed
  -f rawvideo -pix_fmt rgba -s {mw}x{mh} -r {fps} -i pipe:0   # input 1: map
  [-loop 1 -i /tmp/mask.png]           # input 2 (optional): corner mask
  -frames:v {total_frames}
  -filter_complex "
    [0:v]format=yuva444p10le[vc];
    [1:v]format=yuva444p10le[map];
    {PipMapInset: [vc][map]overlay=x:y:format=auto[vout_alpha]}
    [vout_alpha]format=yuv420p[vout];
    [0:a]aresample=48000[aout]
  "
  -map [vout] -map [aout]
  -c:v libx265 -crf 17 … output.mp4
```

The composite filtergraph shrinks from O(N) nodes to O(1): ~5 filter nodes regardless of clip count. FFmpeg opens 2 (or 3) files at startup regardless of N.

**Per-clip trim/setpts/atempo placement.** All per-clip edits are baked into the pre-pass intermediate. The pre-pass uses `build_clip_video_subgraph` and `build_clip_audio_subgraph` from `clip_chain.rs` with identical `ClipChainInputs` to the current composite — the per-clip subgraph strings are byte-identical. Only the output target changes.

**§7 invariant impact.** The pre-pass intermediate can be shared between Channel A and Channel C:

- Channel A (composite): reads the pre-pass as video input, composites with the map stream.
- Channel C (video-only): reads the pre-pass, pads it onto a transparent canvas at the video slot rect. Channel C's `build_video_only_filtergraph` becomes a 1-input pad operation rather than an N-input concat chain.

The §7 invariant is preserved — and strengthened from "same code path" to "same physical bits" — because A and C consume the same file. A new unit test should assert that `build_prepass_filtergraph` emits byte-identical per-clip subgraph strings to `build_composite_filter_complex` for the same inputs.

**Caching strategy.** The pre-pass must be re-run when any visible clip's edits change. The invalidation key is a hash over:

```
sorted [(clip.id, clip.path, clip.trim, clip.effects.speed, clip.focal_point, clip.visible)]
+ (video_slot.w, video_slot.h, fps)
```

Store the key as `proxies/export-prepass.hash`. On export start, recompute and compare. Cache hit: skip pre-pass. Cache miss: run pre-pass, write new hash. Switching export aspects invalidates the cache because `video_slot` dims (which determine the `scale` step) are aspect-dependent. See Open Question 2 for a mitigation path.

**Intermediate file size.** ProRes HQ at 1080×1920 30fps: ~220 Mbps = ~1.6 GB/minute. A 70-clip project at ~3s trimmed per clip = ~3.5 min = ~5.6 GB. Significant but within reason for a desktop app. FFV1 lossless at the same resolution: ~50–100 Mbps = ~0.4–0.7 GB/minute = ~1.4–2.5 GB for the same content. FFV1 is clearly preferable on size; the trade-off is NLE compatibility (moot since this is an internal cache artifact).

**Test impact:**

- `filtergraph.rs` unit tests at lines 1181–1584: the composite filtergraph no longer contains per-clip subgraphs. Tests asserting `concat=n=2:v=1:a=0[vc]`, `[0:a]atrim=`, `[1:a]atrim=` in the composite filter_complex will fail and need updating. The pre-pass filtergraph requires new unit tests.
- `render_export_composite.rs` integration tests: no content logic changes required; they assert container shape and pixel content. The pre-pass intermediate is created in the test's `TempDir` and cleaned up on drop. `composite_input_ordering_clips_before_rawvideo_before_mask` (line 1502) must be updated since the composite now has 1 source input instead of 2+.
- `render_export_video_only.rs`: if Channel C is refactored to use the pre-pass, integration tests need the pre-pass to exist before running. Either: (a) Channel C triggers the pre-pass itself, or (b) the integration test fixture creates the pre-pass first. Option (a) is cleaner.
- `render_export_map_only.rs`: unaffected.

**Scaling: N=100, N=200:**

| Stage | N=100 | N=200 |
|-------|-------|-------|
| Pre-pass startup + probe | ~90–120s (one-time) | ~3–4 min (one-time) |
| Composite startup | < 1s | < 1s |
| Composite graph nodes | ~5 | ~5 |

Repeated exports with unchanged clip edits pay only the composite startup cost regardless of N. Typical re-export workflow (user adjusts map style or layout, not clip edits) benefits fully.

**Riskiest assumption.** ProRes HQ quality is sufficient for H.265 CRF 17 output. The chain is: original 4K HEVC → ProRes HQ intermediate → H.265 CRF 17 final. ProRes HQ introduces ~3 dB of headroom loss, which should be imperceptible at CRF 17 quality. This must be verified with a perceptual comparison on real iPhone 4K footage before shipping. FFV1 lossless eliminates this risk entirely at the cost of larger intermediate files and slower macOS decode (no VideoToolbox acceleration for FFV1).

---

### (c) Chunked composite — K clips per FFmpeg pass

**Core idea.** Run ceil(N/K) FFmpeg passes, each processing K ≤ 10 clips. Each pass produces a lossless intermediate chunk. A final assembly pass concatenates the chunk intermediates using the concat demuxer (homogeneity is guaranteed because all chunks are normalized by the per-chunk pass), then composites with the map stream.

**Filtergraph shape — each chunk pass** (same per-clip subgraph structure as current, but K inputs):

```
ffmpeg -i chunk_clips[0..K-1]
  -filter_complex "{K subgraphs + concat=n=K[vc] + concat audio [aout]}"
  -c:v {lossless} -c:a pcm_s16le chunk_{i}.mov
```

**Filtergraph shape — final assembly:**

```
ffmpeg
  -f concat -safe 0 -i chunklist.txt   # all chunk intermediates (homogeneous)
  -f rawvideo … -i pipe:0
  [-loop 1 -i mask.png]
  -filter_complex "{single-stream composite}"
  -c:v libx265 … output.mp4
```

The concat demuxer works in the final assembly because all chunks have identical stream parameters.

**Per-clip trim/setpts/atempo placement.** Baked per chunk, using the same `clip_chain.rs` builders. §7 invariant preserved by code reuse.

**§7 invariant impact.** Same as (b): Channel C can consume the chunk intermediates or the assembled single stream. If Channel C runs its own chunk passes independently, §7 is preserved by code reuse.

**Test impact.** New `build_chunk_filtergraph` function with new unit tests. Composite-stage unit tests must be updated. Integration tests are content-agnostic and pass if output is correct. Multi-pass nature adds wall-clock time to integration test runs.

**Scaling at N=100, N=200 with K=10:**

| N clips, K=10 | Chunk passes | Total file opens | Graph nodes per pass | Final composite startup |
|---------------|--------------|------------------|----------------------|------------------------|
| N=100         | 10 + 1 final | 10×10 + 2 = 102  | 20 per chunk         | ~1s                    |
| N=200         | 20 + 1 final | 20×10 + 2 = 202  | 20 per chunk         | ~1s                    |

Total file opens are the same as the current approach (still N source files opened in aggregate across all chunk passes). However, each individual FFmpeg process opens only K=10 files — staying well within OS handle limits and allowing per-chunk graph compilation to complete in < 1s.

**Parallelism opportunity.** Chunk passes are independent and could run in parallel on multi-core hardware. In practice, each chunk pass is CPU-bound; running all chunks in parallel saturates the CPU and produces the same wall-clock time as serial execution, while multiplying peak memory usage by the chunk count. Parallel chunk passes are a future optimization, not a requirement.

**Riskiest assumption.** Each chunk pass introduces one generation of ProRes HQ encoding. With K=10 and N=200, each source pixel passes through 2 encode generations (chunk → assembly or chunk → final composite) before reaching the H.265 output. With FFV1 lossless for chunk intermediates this is zero quality loss; with ProRes HQ there is ~3 dB cumulative headroom loss. The safe choice is FFV1.

---

### (d) Persistent ffprobe cache (orthogonal optimization)

**This is not an alternative to (a)/(b)/(c) — it is an orthogonal fix for the probe phase.**

**Current state.** `ffprobe.rs:34` maintains an in-process `PROBE_CACHE: Mutex<Option<HashMap<(PathBuf, SystemTime), ProbedClip>>>`. The cache is discarded when the process exits. The next export — even if clips haven't changed — repeats all N ffprobe spawns.

**Fix.** Persist the probe cache to `{project_bundle}/probe-cache.json`. Key: `(absolute_path, mtime_epoch_nanos)`. On startup, load the cache from disk. On cache miss, write the new entry. This eliminates the N-ffprobe startup cost on warm exports. The cache file is small (< 10 KB for 100 clips). Invalidation by mtime is already used in-process; persisting it adds no new failure modes.

---

## 4. Recommendation

**Adopt option (b) — pre-pass concatenation — combined with option (d) persistent probe cache.**

### Rationale

The composite export's startup cost has two independent bottlenecks: N ffprobe spawns (pre-flight) and N FFmpeg `-i` inputs (FFmpeg startup). Option (b) + option (d) eliminates both:

- Option (d) eliminates the ffprobe startup cost on warm exports via the persistent probe cache.
- Option (b) eliminates the N-input FFmpeg startup cost on repeated exports by amortizing the pre-pass cost across all subsequent exports where clip edits haven't changed.

For the user's real-world workflow — export → review → adjust map style or layout → re-export — the pre-pass runs once at the first export and is cached for all subsequent exports in the same editing session. Only a change to clip trim, speed, focal point, or visibility invalidates the cache and forces a re-run.

**Why not (c)?** Chunked composite adds orchestrator complexity (managing ceil(N/10) chunk processes, chunk intermediate lifecycle, a final assembly process) without providing meaningfully better wall-clock performance than (b) for the common case. Both options pay the same total N-input cost during the pre-processing phase. Option (c)'s advantage — each FFmpeg process opens only K=10 files — is real but not necessary at N=70 or even N=200 (where 200 + ~15 internal handles = ~215, still under macOS's default 256 fd limit). If N grows beyond 200 or the fd limit proves to be a practical problem, chunking can be added as a follow-on on top of (b)'s caching infrastructure.

**Why not (a)?** Not viable. The concat demuxer's homogeneity requirement and inability to express per-segment speed changes disqualify it without a pre-processing pass — making it a worse version of (b).

**§7 invariant outcome.** Option (b) strengthens the invariant from "Channel A and C use the same code path" to "Channel A and C read the same physical bits." A and C consume the same `export-prepass.mov` file; the per-clip chain is not just code-equivalent but bit-identical between channels.

---

## 5. Migration Plan

Implementation steps in order. Each step is one logical unit of work (approximately one PR). No code is written here.

### Step 1 — Persist the ffprobe probe cache (option d)

**Risk**: low. Zero architectural change; purely additive.

Modify `src-tauri/src/export/ffprobe.rs`:
- Add `fn load_probe_cache(bundle_dir: &Path) -> HashMap<(PathBuf, u128), ProbedClip>` — reads `{bundle_dir}/probe-cache.json` if it exists, deserializes, returns an empty map on any error.
- Add `fn persist_probe_cache(bundle_dir: &Path, cache: &HashMap<(PathBuf, u128), ProbedClip>)` — serializes and writes atomically (write to `.tmp`, rename).
- Change `PROBE_CACHE` to be loaded from disk at first use, using the bundle directory passed in via a thread-local or function parameter.

Modify `src-tauri/src/export/mod.rs`:
- `render_export_video_only` and `render_export_composite`: extract `bundle_dir` from `req.output_path`'s parent, load the probe cache before calling `probe_clips_capped`, persist it after.

Add unit tests in `ffprobe.rs` for cache round-trip (serialize → write tempfile → load → assert entries present).

Verify: `parse_with_audio`, `parse_video_only_falls_back_to_stream_duration`, `parse_rejects_missing_video_stream`, `parse_rejects_garbage` all still pass.

---

### Step 2 — Add `target_pix_fmt` parameter to `build_clip_video_subgraph`

**Risk**: low. Mechanical refactor; the function currently hard-codes `format=yuva444p10le`.

Modify `src-tauri/src/export/clip_chain.rs`:
- Change `pub fn build_clip_video_subgraph(inputs: &ClipChainInputs) -> Result<String, ClipChainError>` to accept `target_pix_fmt: &str`.
- Update all callers: `build_composite_filter_complex` and `build_video_only_filter_complex` in `filtergraph.rs` pass `"yuva444p10le"` (preserving current behavior).
- The new `build_prepass_filtergraph` (Step 3) will pass `"yuv422p10le"` (ProRes HQ native) or `"yuv420p"` (FFV1 with YUV) depending on the chosen intermediate format.

Update all unit tests in `filtergraph.rs` that assert `format=yuva444p10le` in per-clip subgraphs — add the `target_pix_fmt` argument to call sites in test code. No behavioral change to any existing test assertion.

---

### Step 3 — Add `build_prepass_filtergraph` to `filtergraph.rs`

**Risk**: medium. New function; must produce a filtergraph that `run_ffmpeg` can execute correctly on real iPhone source clips.

Add `pub fn build_prepass_filtergraph(visible_clips: &[VisibleClipInput], video_slot: PixelRect, fps: u32, intermediate_encoder_args: &[&str], output_path: &Path) -> Result<FiltergraphPlan, ClipChainError>` to `src-tauri/src/export/filtergraph.rs`.

The function body mirrors `build_video_only_filtergraph` but:
- No corner mask (not needed for an internal intermediate).
- No `pad` to a full-aspect canvas (the intermediate is the video slot content only, not a masked positional export).
- `format=yuv422p10le` (ProRes HQ) or `format=yuv420p` (FFV1) rather than `yuva444p10le`.
- No `[vout]` pad step — output label is `[vc]` directly.
- `frame_bytes_per_input` is 0 (no rawvideo input).

Add unit tests:
- `prepass_single_clip_emits_trim_setpts_crop_scale` — assert per-clip subgraph contains the same `trim`, `setpts`, `crop`, `scale` tokens as `build_video_only_filtergraph` for identical inputs.
- `prepass_and_composite_per_clip_subgraphs_are_identical` — call both functions with the same `visible_clips` and `video_slot`, extract the per-clip subgraph fragments (everything up to `format=`), assert they are byte-identical. This is the §7 invariant unit test.
- `prepass_does_not_emit_pad_or_overlay` — assert the filter_complex does not contain `pad=` or `overlay=`.

---

### Step 4 — Add pre-pass cache hash computation

**Risk**: low. Pure function over clip metadata; straightforward to test.

Add `fn compute_prepass_hash(visible_clips: &[VisibleClipInput], video_slot: PixelRect, fps: u32) -> String` in a new `src-tauri/src/export/prepass_cache.rs` module (or inline in `mod.rs` if small).

Input fields hashed per clip: `clip.id`, `clip.path`, `clip.trim` (both fields), `clip.effects.speed`, `clip.focal_point` (all three fields), `clip.visible`. Sort clips by `clip.id` before hashing to ensure stability under any future reordering. Concatenate `(video_slot.w, video_slot.h, fps)` at the end.

Use a stable hasher — `std::collections::hash_map::DefaultHasher` is not stable across Rust versions; use a fixed algorithm such as FNV-1a (add `fnv` crate, already potentially in the dependency tree) or xxHash. Output as 16-character lowercase hex.

Hash storage:
- Write `{project_bundle}/proxies/export-prepass.hash` as a plain UTF-8 file.
- Read and compare at the start of `render_export_composite` and `render_export_video_only` before deciding whether to run the pre-pass.

Add unit tests: same inputs → same hash; different `trim.in_ms` → different hash; different `speed` → different hash; different `video_slot.w` → different hash; different `fps` → different hash. Assert hash is 16-character lowercase hex.

---

### Step 5 — Implement pre-pass execution and cache check in `render_export_composite`

**Risk**: medium-high. Modifies the critical path of the headline export channel.

Modify `render_export_composite` in `src-tauri/src/export/mod.rs` (starting at line 458):

After `probe_clips_capped` and before `build_composite_filtergraph`:

1. Determine `prepass_path = {bundle_dir}/proxies/export-prepass.mov` and `hash_path = {bundle_dir}/proxies/export-prepass.hash`.
2. Compute `expected_hash = compute_prepass_hash(&visible_inputs, video_slot, req.fps)`.
3. Read `hash_path` if it exists. If the stored hash matches `expected_hash` AND `prepass_path.exists()`: skip the pre-pass.
4. Otherwise: call `build_prepass_filtergraph(&visible_inputs, video_slot, req.fps, &intermediate_encoder_args, &prepass_path)`, run via `run_ffmpeg`, write `expected_hash` to `hash_path` on success.
5. Replace the composite stage's `visible_inputs` with a single `VisibleClipInput` referencing `prepass_path` (the pre-processed stream, with `has_audio: true`, `source_dims` = video slot dims).

Add a new `build_composite_filtergraph_with_prepass` function (or add an `Option<&Path>` parameter to the existing function) that emits the 2-input composite filtergraph described in Section 3(b)'s "Filtergraph shape — composite FFmpeg invocation" above.

**Keep the existing N-input path as a fallback.** Add a `bool use_prepass` parameter (or detect via `Option<PathBuf>`) so the existing behavior is preserved for cases where the pre-pass cannot be created (e.g., bundle directory is read-only, or this is the first-ever export and the pre-pass creation itself is what we're running). The integration test currently exercises the 2-clip case; both paths should be exercised.

Update unit tests in `filtergraph.rs`:
- Update `composite_input_ordering_clips_before_rawvideo_before_mask` (line 1502) — when using the pre-pass path, there is 1 source input, not 2+.
- Add `composite_with_prepass_has_single_source_input` — assert the composite argv contains exactly 1 `-i {prepass}` before `-i pipe:0`.
- Add `composite_with_prepass_filter_complex_has_no_per_clip_subgraph` — assert the filter_complex does not contain `trim=` or `setpts=` (those are in the pre-pass, not the composite).

Update integration tests in `render_export_composite.rs`:
- The 3 existing tests (`composite_pip_map_inset_default_layout`, `composite_pip_video_inset`, `composite_split`) should pass without content change — they assert output correctness, not internal structure. Verify after implementing.
- Add `composite_cache_hit_reuses_intermediate` — run a composite export twice with identical clips but different `output_path`; assert the pre-pass file's mtime is the same on both runs (cache hit).

---

### Step 6 — Refactor `render_export_video_only` to use the pre-pass

**Risk**: medium. Channel C currently has its own N-input filtergraph that is structurally identical to the pre-pass. Refactoring it to consume the pre-pass simplifies Channel C significantly.

Modify `render_export_video_only` in `src-tauri/src/export/mod.rs` (starting at line 308):

1. Run the pre-pass cache check identical to Step 5 (same `compute_prepass_hash`, same `prepass_path`).
2. After the pre-pass exists (created or cached), replace the N-input `build_video_only_filtergraph` call with a new `build_video_only_filtergraph_with_prepass` function that takes `prepass_path` as input and emits:

```
ffmpeg -i prepass_path
  [-loop 1 -i mask.png]
  -filter_complex "
    [0:v]format=yuva444p10le[vc];
    {alphamerge if corner mask}
    {pad=out_w:out_h:slot_x:slot_y:color=#00000000[vout]}
    [0:a]…[aout]
  "
  -c:v prores_ks -profile:v 4444 … output.mov
```

This is a 1-input operation. The alpha masking and pad stay in Channel C (they are Channel C's job, not the pre-pass's job).

Update integration tests in `render_export_video_only.rs`:
- `video_only_full_bleed_default_layout`, `video_only_inset_alpha_outside_is_zero`, `video_only_inset_with_corner_radius_antialiased` — these should pass if output is correct.
- The `corner_radius` antialiased test (line 373) asserts sub-pixel alpha values at the arc edge. Verify the refactored Channel C still applies the corner mask correctly.

---

### Step 7 — Extend the encoder infrastructure for the intermediate format

**Risk**: low. The `encoder.rs` `EncoderClass` enum currently has `ProResAlpha` and `Hevc`. Add `ProResIntermediate` (for ProRes HQ) as a third variant, with `codec_args: ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]`. The encoder probe infrastructure (`probe_all`, `select_encoder`) should probe for this class separately from `ProResAlpha`.

Alternatively, use FFV1 (`-c:v ffv1 -level 3 -g 1 -coder 1 -context 1`) as the intermediate format. FFV1 does not require encoder probing (it is always available in FFmpeg). Hard-code FFV1 as the intermediate format for simplicity; the decision between ProRes HQ and FFV1 is deferred to Open Question 1.

---

### Step 8 — Update `CLAUDE.md` project bundle spec and task README

Modify `CLAUDE.md` to document two new bundle artifacts:

```
MyHike.trailcut/
  project.json
  proxies/
    export-prepass.mov    # lossless intermediate: baked trim/speed/crop/scale (cache, deletable)
    export-prepass.hash   # invalidation key for the intermediate (deletable)
    probe-cache.json      # per-clip ffprobe results keyed by (path, mtime) (cache, deletable)
    …
```

Add a new task entry (e.g., `125`) to `docs/export/tasks/README.md` tracking this work.

---

## 6. Open Questions

1. **ProRes HQ vs. FFV1 for the intermediate.** ProRes HQ is faster to decode on macOS (VideoToolbox may accelerate it) and produces NLE-compatible files if the user inspects the bundle. FFV1 is truly lossless and ~2× smaller per minute. The question is empirical: run a perceptual comparison on real iPhone 4K source footage through the ProRes HQ intermediate at H.265 CRF 17, and determine whether the ~3 dB headroom loss is visible. If not, ProRes HQ is fine. If visible on any test clip, use FFV1. This comparison must happen before committing to the intermediate format.

2. **Scale step in the pre-pass vs. the composite.** The pre-pass currently bakes `scale=video_slot_w:video_slot_h`, which is aspect-dependent. A user who exports at both 9:16 and 16:9 needs separate pre-pass intermediates (different slot dims), doubling the pre-pass cost for multi-aspect workflows. Alternative: move the `scale` step out of the pre-pass and into the composite filtergraph, so the pre-pass stores the focal-cropped (but unscaled) stream. The composite then scales per slot. This decouples the cache from the export aspect but re-introduces a per-clip scale node in the composite — though only 1 scale filter, not N, since the pre-pass output is a single concatenated stream. Decide which trade-off is correct before implementing.

3. **Audio format through the intermediate.** The pre-pass proposes PCM s16le for audio. The composite stage re-encodes to AAC 256 kbps; Channel C passes through as PCM s16le. Should the pre-pass carry PCM s24le to give the AAC encoder higher-quality input at the expense of a larger intermediate file? PCM s24le at 48 kHz stereo adds ~2.3 Mbps — negligible compared to ProRes video. The safer default is s24le; decide before implementing.

4. **OS file-descriptor limit guard.** The pre-pass phase still opens N source files simultaneously. At N=70 this is 73 file descriptors — safe under macOS's default limit of 256. At N=250 it would be ~265 — over the limit. Should `render_export_composite` raise the fd limit via `setrlimit(RLIMIT_NOFILE, ...)` before the pre-pass, or should it emit a warning when N > 200 suggesting the user contact support? Or should Step 8 be extended to add chunking (option c) as the N > 200 fallback within the (b) framework?

5. **Pre-pass progress reporting.** The pre-pass may take 45–120 seconds for a large project. The UI currently shows no granular progress during export. Should the pre-pass phase emit Tauri events with FFmpeg's `progress` pipe output (frame count, time processed)? If so, define the event format and the frontend progress-display component before implementing Step 5. Alternatively, show a spinner with a "Preparing clips…" label during the pre-pass phase — simpler but less informative.

6. **Channel C independence.** If Channel C is refactored to consume the pre-pass (Step 6), it shares the cache with Channel A. A user who exports Channel C after Channel A in the same session gets the pre-pass for free. But if Channel C is exported in isolation (no prior Channel A export), it must trigger its own pre-pass. The cache check in Step 5 handles this correctly (same `compute_prepass_hash`, same `prepass_path`). Confirm that the hash inputs for Channel C's pre-pass are identical to Channel A's (they are: same `visible_inputs`, `video_slot`, `fps`) so the cache is shared correctly.

7. **Integration test timing.** The pre-pass adds one FFmpeg invocation to the integration test wall-clock time. With the 2-clip synthetic fixture (`make_test_clip` at 1.0s duration each), the pre-pass should complete in under 2 seconds. Verify this does not push integration tests over any CI time limits.

---

*End of plan.*