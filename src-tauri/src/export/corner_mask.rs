// Pure rounded-rect mask PNG generator (task 060 / 070).
//
// Produces a single-image RGBA PNG whose RGB channels carry the mask value
// (white inside the rounded rect, black outside, antialiased at the arc
// edge) with alpha=255 throughout. The downstream filter chain runs
// `[N:v]format=gray` to extract the luminance and feeds that into
// `alphamerge`, which replaces the video stream's alpha with the mask's
// grayscale.
//
// IMPORTANT: the mask value MUST live in R/G/B, not in the alpha channel —
// FFmpeg's `format=gray` filter computes Y from RGB and drops alpha.
// Encoding the mask into the alpha channel produces a uniformly-opaque
// (luminance=255) gray frame, which alphamerge then applies as "fully
// opaque everywhere" — silently breaking the corner-rounding.
//
// No dependencies beyond the `png` crate. Intentionally synchronous + pure:
// same inputs → byte-identical output, no IO. The on-disk cache that the
// `render_export` command uses lives at the call site, not here.

use std::io::Cursor;

use png::{BitDepth, ColorType, Encoder};

#[derive(Debug, thiserror::Error)]
pub enum CornerMaskError {
    #[error("png encode failed: {0}")]
    Png(#[from] png::EncodingError),
}

/// Build the alpha-mask PNG buffer for a `slot_w × slot_h` rounded rect with
/// `radius_px` corner radius. Returns the PNG file bytes (RGBA, 8-bit).
///
/// `radius_px == 0` produces a fully-opaque rectangle (no rounding); the
/// caller should typically skip mask generation entirely in that case, but
/// this function still produces a well-formed PNG for symmetry.
///
/// `radius_px` is silently clamped to `min(slot_w, slot_h) / 2` — anything
/// larger overlaps two adjacent corner arcs, which the configurator UI (110)
/// is responsible for preventing. We clamp here so the rasterizer never
/// produces a torn shape if a caller forgets.
pub fn build_corner_mask_png(
    slot_w: u32,
    slot_h: u32,
    radius_px: u32,
) -> Result<Vec<u8>, CornerMaskError> {
    assert!(slot_w > 0 && slot_h > 0, "slot dimensions must be positive");

    let max_radius = slot_w.min(slot_h) / 2;
    let r = radius_px.min(max_radius);

    let w = slot_w as i64;
    let h = slot_h as i64;
    let r_i = r as i64;

    let pixel_count = (slot_w as usize) * (slot_h as usize);
    let mut buf = vec![0u8; pixel_count * 4];

    // For each pixel, compute alpha. The shape is a rectangle with corners
    // replaced by quarter-circles of radius `r` centered at:
    //   top-left:     (r, r)
    //   top-right:    (w-r, r)
    //   bottom-left:  (r, h-r)
    //   bottom-right: (w-r, h-r)
    //
    // Pixel center is at (x + 0.5, y + 0.5). Inside-the-rounded-rect test:
    //   - if pixel center is within `r` of the inner rectangle bounded by
    //     [r, w-r] × [r, h-r], it's in the rounded interior. Distance from
    //     the *nearest corner-arc center* drives the antialias band when
    //     the pixel is in a corner region; otherwise it's fully inside.
    //
    // Antialias: 1-pixel band straddling the arc edge.
    //   alpha_unit = clamp(r + 0.5 - distance_to_arc_center, 0, 1)
    // Outside corners (no arc), the rectangle edges themselves are
    // pixel-aligned so `pad`'s default opaque interior is fine — we render
    // alpha=255 for every pixel inside the inner bounding box too.

    for y in 0..h {
        for x in 0..w {
            // Mask value lives in RGB (luminance) so `format=gray`
            // downstream extracts it correctly. Alpha is fully opaque so
            // every pixel of the PNG carries usable luminance data.
            let mask_unit = corner_alpha_unit(x, y, w, h, r_i);
            let mask = (mask_unit * 255.0).round().clamp(0.0, 255.0) as u8;
            let idx = ((y * w + x) as usize) * 4;
            buf[idx] = mask;
            buf[idx + 1] = mask;
            buf[idx + 2] = mask;
            buf[idx + 3] = 255;
        }
    }

    encode_rgba_png(slot_w, slot_h, &buf)
}

/// Return the antialiased alpha (0.0..=1.0) for pixel `(x, y)` inside an
/// `(w, h)` rounded rect with corner radius `r`. Pixel center is
/// `(x + 0.5, y + 0.5)`.
fn corner_alpha_unit(x: i64, y: i64, w: i64, h: i64, r: i64) -> f64 {
    if r <= 0 {
        return 1.0;
    }
    let cx = x as f64 + 0.5;
    let cy = y as f64 + 0.5;
    let r_f = r as f64;
    let w_f = w as f64;
    let h_f = h as f64;

    // Corner-arc center coordinates (closest of the four corners).
    let arc_cx = if cx < r_f {
        r_f
    } else if cx > w_f - r_f {
        w_f - r_f
    } else {
        // Pixel is between corner regions on x axis — no x-side rounding here.
        cx
    };
    let arc_cy = if cy < r_f {
        r_f
    } else if cy > h_f - r_f {
        h_f - r_f
    } else {
        cy
    };

    if arc_cx == cx && arc_cy == cy {
        // Inside the rectangular interior, away from any corner — fully
        // opaque, no antialias.
        return 1.0;
    }

    let dx = cx - arc_cx;
    let dy = cy - arc_cy;
    let dist = (dx * dx + dy * dy).sqrt();
    // 1-pixel antialias band centered on the arc.
    (r_f + 0.5 - dist).clamp(0.0, 1.0)
}

fn encode_rgba_png(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, CornerMaskError> {
    let mut out = Vec::with_capacity(rgba.len() / 2);
    {
        let mut encoder = Encoder::new(Cursor::new(&mut out), w, h);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(rgba)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use png::Decoder;

    fn decode(buf: &[u8]) -> (u32, u32, Vec<u8>) {
        let decoder = Decoder::new(buf);
        let mut reader = decoder.read_info().expect("png header");
        let info = reader.info().clone();
        let mut out = vec![0u8; reader.output_buffer_size()];
        reader.next_frame(&mut out).expect("png frame");
        (info.width, info.height, out)
    }

    fn mask_at(rgba: &[u8], w: u32, x: u32, y: u32) -> u8 {
        // Mask value lives in the R channel (R == G == B by construction);
        // alpha is always 255. The downstream `format=gray` filter reads
        // luminance (Y) from RGB, so the relevant per-pixel value is R.
        rgba[((y * w + x) as usize) * 4]
    }

    fn alpha_at(rgba: &[u8], w: u32, x: u32, y: u32) -> u8 {
        rgba[((y * w + x) as usize) * 4 + 3]
    }

    #[test]
    fn output_dims_match_input_dims() {
        let buf = build_corner_mask_png(64, 32, 8).unwrap();
        let (w, h, _) = decode(&buf);
        assert_eq!(w, 64);
        assert_eq!(h, 32);
    }

    #[test]
    fn center_pixel_fully_opaque() {
        let buf = build_corner_mask_png(100, 60, 12).unwrap();
        let (w, _h, rgba) = decode(&buf);
        // Center is well inside the rounded rect → mask=255 (fully opaque
        // in the alphamerge sense).
        assert_eq!(mask_at(&rgba, w, 50, 30), 255, "center mask should be 255");
    }

    #[test]
    fn outside_corner_is_transparent() {
        let buf = build_corner_mask_png(100, 80, 20).unwrap();
        let (w, _h, rgba) = decode(&buf);
        // (0, 0) is well outside a 20-px rounded corner — distance from
        // arc center (20, 20) is sqrt(20^2 + 20^2) ≈ 28.28 > 20.
        assert_eq!(mask_at(&rgba, w, 0, 0), 0, "outside corner mask should be 0");
        // (99, 79) — opposite corner.
        assert_eq!(
            mask_at(&rgba, w, 99, 79),
            0,
            "outside opposite corner mask should be 0",
        );
    }

    #[test]
    fn antialias_band_has_partial_mask_value() {
        let buf = build_corner_mask_png(100, 100, 20).unwrap();
        let (w, _h, rgba) = decode(&buf);
        let mut found = false;
        for x in 0..20u32 {
            for y in 0..20u32 {
                let m = mask_at(&rgba, w, x, y);
                if m > 30 && m < 225 {
                    found = true;
                    break;
                }
            }
            if found {
                break;
            }
        }
        assert!(found, "expected at least one antialiased pixel near the corner");
    }

    #[test]
    fn pixel_on_arc_mask_in_intermediate_range() {
        // A pixel exactly on the corner arc has mask in [100, 200] (the
        // 1-pixel antialias band straddles luminance 128).
        let buf = build_corner_mask_png(40, 40, 10).unwrap();
        let (w, _h, rgba) = decode(&buf);
        let mut intermediate = None;
        for y in 0..10u32 {
            for x in 0..10u32 {
                let m = mask_at(&rgba, w, x, y);
                if (100..=200).contains(&m) {
                    intermediate = Some((x, y, m));
                    break;
                }
            }
            if intermediate.is_some() {
                break;
            }
        }
        assert!(
            intermediate.is_some(),
            "expected at least one pixel with mask in [100, 200] along the arc",
        );
    }

    #[test]
    fn radius_zero_produces_full_rectangle() {
        let buf = build_corner_mask_png(20, 20, 0).unwrap();
        let (w, h, rgba) = decode(&buf);
        for y in 0..h {
            for x in 0..w {
                assert_eq!(mask_at(&rgba, w, x, y), 255, "mask({},{})", x, y);
                assert_eq!(alpha_at(&rgba, w, x, y), 255, "alpha({},{})", x, y);
            }
        }
    }

    #[test]
    fn alpha_channel_is_fully_opaque() {
        // Alpha is uniformly 255 — the mask value is in RGB so
        // `format=gray` downstream reads it via luminance.
        let buf = build_corner_mask_png(30, 30, 5).unwrap();
        let (w, h, rgba) = decode(&buf);
        for y in 0..h {
            for x in 0..w {
                assert_eq!(alpha_at(&rgba, w, x, y), 255, "alpha({},{})", x, y);
            }
        }
    }

    #[test]
    fn radius_clamped_to_min_dim_div_two() {
        // 20×40 with radius 30 → clamped to 10. Verify no panic and a
        // sensible shape: mid-height row is fully white in the mask.
        let buf = build_corner_mask_png(20, 40, 30).unwrap();
        let (w, _h, rgba) = decode(&buf);
        for x in 0..w {
            assert_eq!(mask_at(&rgba, w, x, 20), 255);
        }
    }

    #[test]
    fn png_round_trips() {
        let buf = build_corner_mask_png(50, 50, 10).unwrap();
        let (w, h, rgba1) = decode(&buf);
        // Re-encode the decoded data and decode again — alpha values
        // should survive a full round-trip.
        let buf2 = encode_rgba_png(w, h, &rgba1).unwrap();
        let (w2, h2, rgba2) = decode(&buf2);
        assert_eq!(w, w2);
        assert_eq!(h, h2);
        assert_eq!(rgba1, rgba2);
    }
}
