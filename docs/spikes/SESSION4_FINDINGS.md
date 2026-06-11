# Session 4 — composite-intermediate premise overturned (empirical)

**Read after `HANDOFF.md`.** This session validated fix (C)'s linchpin in `port_probe` BEFORE
any codebase change and overturned the approved "16-bit + headroom" mechanism. No core code was
changed (a brief exploratory edit to `color_space.rs` was made and fully reverted — the file is
back to npl 400/1000, no anchor/gain additions). All numbers below are reproducible from
`.spike/port_probe/` with ffmpeg 8.1.1 (zimg + libx265). Inputs: real HLG clip
`/Users/personal/Downloads/trail-vids/IMG_1137.MOV` (first frame), `white.png`, `grad.png`
(1024-step gradient, generated via `gradients` filter), `maskhalf.png` (half-opaque/half-50%).

## The headline reversals

| design said | reality (measured) |
|---|---|
| lift to **16-bit** (`yuva444p16le`/`gbrap16le`) through `overlay` | `overlay` **caps at 10-bit** — `format` enum tops at `yuv444p10`; feeding `yuva444p16le` makes FFmpeg **silently auto-insert a scaler → `yuva444p10le`** before the overlay (verbose-confirmed). `gbrap16le` is accepted but **corrupts** the value (0.15 → 0.0625). True 16-bit composite via `overlay` is impossible. |
| (implicit) some float compositor could avoid the lift | `maskedmerge` and `blend` process `gbrpf32le` but **clamp to [0,1]** — bright HDR pixel crushed to 100 nits. **No float positioned compositor exists.** |
| gain via `geq` (×2.03 "direct") | `geq` **clamps output to [0,1]** — ×2.03 on map white (1.0) → 1.0 (not 2.03); ×16 restore → 1.0. Unusable for any gain >1. |
| `H ≥ peak/100`, "PQ-1000 ⇒ ~10, use 16"; HLG "~12 at npl=100" | Real iPhone HLG peaks at **linear 24.6** at npl=100 (frame max, no swscale clamp). **H=16 would clip real footage.** Use **H=32**. |
| 16-bit needed to avoid map banding; 10-bit+headroom rejected | 1024-step gradient distinct output levels: **608** (no-composite ceiling) / **606** (16-bit+headroom ideal) / **381** (10-bit+headroom, achievable). 381 ≫ visible-banding threshold (~64–128). The rejection was overstated. |
| (not considered) headroom always on | Headroom **must be gated to HDR delivery**. SDR gradient: **209** levels plain lift vs **85** with H=32 headroom → unconditional headroom regresses SDR. Gate: `delivery.transfer.is_hdr()`. |

## The corrected mechanism (validated end-to-end)

Composite = **10-bit `yuva444p10le` + headroom**, gated to HDR delivery:
- Before each `format=yuva444p10le` lift: `÷H` in float (`colorchannelmixer=rr=0.03125:gg=…:bb=…`, H=32 → one stage, 1/32 ≤ 2).
- `overlay … :format=yuv444p10` (unchanged).
- After the post-overlay `format=gbrpf32le`: `×H` in float (`colorchannelmixer=rr=2:…` ×5 = ×32; the chain does NOT clamp crossing 1.0 — verified).
- Gains via a registry helper `linear_gain_filter(factor)` that decomposes any factor into ≤2.0 colorchannelmixer stages. Serves both this and the (B) anchor (×2.03 → stages [2, 1.015]).

**Gain-filter law (empirical):** only arithmetic/colorspace filters preserve float >1.0
(`colorchannelmixer` clamp-free but ±2.0/coeff cap → chain; `exposure` clamp-free but ±3-stop
cap = ×8 max, can't do ÷32/×32; `zscale`/`swscale` clamp-free). `geq`, `gbrap16le`, integer
`format=` conversions, `maskedmerge`, `blend` all clamp/corrupt at [0,1].

### Per-path validation (HLG target, libx265 main10; signal read full-range, ref white 0xC0≈75%)
| path | map white | HDR video | notes |
|---|---|---|---|
| identity ref (video ingest npl=100 → finish, no composite) | — | `c9c4c2` (bright), `60705d` (mid) | the round-trip target |
| unmasked PIP, H=32 | **`c0c0c0`** (0xC0=75%=203nit) | `c7c4c1` / `63735e` (±3, no clamp) | `comp32.mkv` |
| masked alphamerge, H=32 | **`bebebe`** (≈0xC0) | uncovered `5f6e5b` (±2); 50%-edge `d8d8d8` blends between video `e9e9e9` & map `bebebe` | `comp_masked.mkv` — edge coherent inside headroom |
| Split (setparams bg + 2 overlays), H=32 | **`c0c0c0`** | (slot-shift artifact in probe read, not an error) | `comp_split.mkv` |

## Peaks & H sizing (npl=100, working linear where 1.0 = 100 nits)
- HLG real clip frame max: **24.6**. HLG synthetic 100%-white: 10.5 (real content exceeds
  nominal white — HLG OOTF amplifies highlights). PQ 100%-white (10000-nit codeword): **107.6**.
  PQ-1000-nit ≈ linear 10; PQ-4000 ≈ 43.
- `H=32` covers HLG (24.6) + PQ-to-~3200-nit, with ~4100 sixteen-… (10-bit: ~65) levels below
  the anchored map white. PQ above ~3200 nit clips → flagged known bound (PORT_DESIGN §6).
- npl only shifts where power-of-2 H-rounding wastes precision: npl=100→H=32 (waste ×1.30) is
  tighter than npl=1000→H=4 (×1.63). npl=100 stays correct.

## Reproduce
All commands are in this session's shell history under `.spike/port_probe/`; key artifacts:
`ref_id.mkv` (identity), `comp32.mkv` (unmasked), `comp_masked.mkv`, `comp_split.mkv`,
`sdr_plain.mkv`/`sdr_head.mkv` (209 vs 85), `grad_direct.mkv`/`g_h32.mkv`/`g_h16bit.mkv`
(608/381/606). Readers: full-range signal `…,zscale=rin=tv:r=full,format=rgb24,crop=1:1:X:Y`;
working-linear float `…,crop=1:1:X:Y` → `gbrpf32le` → `struct.unpack('<fff')` (planar G,B,R).

## Net for a future implementation session
A/B/C/D are still the plan, with (C) corrected to **10-bit + headroom, H=32, gated to HDR
delivery, gains via `linear_gain_filter` (colorchannelmixer chain)**. Trust THIS file and the
corrected PORT_DESIGN §4(C)/§6/§7 over the original 16-bit text and the handoff evidence row
that listed `geq` as usable / `overlay` as 16-bit-capable.
