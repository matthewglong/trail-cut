//! Marker-image library import (schema v11; generalized from the v10
//! single custom POV marker image).
//!
//! Two-step import, split across the process boundary on purpose:
//!
//!  1. [`import_marker_image`] (here) — validate the upload (extension,
//!     magic bytes, size cap), content-hash it, and copy the ORIGINAL into
//!     the bundle's `assets/` directory. The bundle owns the user's asset
//!     from this point; the project never references the outside path again.
//!  2. The frontend then bakes the render asset — decoding the PNG /
//!     rasterizing the SVG through the webview canvas, which is the only
//!     real image decoder + SVG renderer in the stack (the export sidecar
//!     deliberately has no canvas — see `mapVisuals/shapes.ts`), and the
//!     canvas folds ICC profiles into sRGB so preview and export decode
//!     identical pixels — and hands the PNG bytes to [`save_marker_icon`],
//!     which is the AUTHORITY on the baked asset: it re-verifies the PNG
//!     signature, parses the real dimensions with the `png` crate (never
//!     trusting frontend-declared dims), enforces the renderer's
//!     1024-texel addImage cap, and writes atomically.
//!
//! Filenames are content-hashed (`marker-source-<hash>.<ext>` /
//! `marker-icon-<hash>.png`) so re-importing the same file is idempotent
//! and distinct images never collide; the hash is validated as 16 lowercase
//! hex chars wherever it forms a filename so a malformed value can't
//! traverse out of `assets/`. Legacy v10 assets kept their
//! `pov-source-*` / `pov-icon-*` names — refs store full relative paths, so
//! they load fine, and [`delete_marker_image`] accepts both prefixes.
//!
//! Deletion ([`delete_marker_image`]) removes both files for a library
//! entry. It is idempotent on already-missing files (a half-deleted bundle
//! must not wedge the UI's delete flow) — the frontend removes every use of
//! the entry from project state BEFORE invoking it, so a failure here can
//! never leave a dangling reference.

use crate::models::MarkerImage;
use crate::util::fs::{ensure_dir, write_atomic};
use base64::Engine;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;
use std::path::Path;

/// Upload size cap. Generous for marker art (the baked render asset is
/// ≤ 1024×1024); the cap exists to fail fast on a mis-picked video/RAW
/// file, not to police legitimate images.
const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;

/// The export renderer's addImage texture cap (mbgl node binding,
/// 1024 texels per side). Mirrors `MAX_MASTER_TEXELS` in
/// `src/lib/mapVisuals/markerImage.ts` — the baked master must respect it
/// or the asset could never be uploaded at export time.
const MAX_ICON_TEXELS: u32 = 1024;

/// PNG file signature (8 bytes).
const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

#[derive(Debug, Clone, Serialize)]
pub struct MarkerImportInfo {
    /// 16-hex content hash — the library entry's stable id; the frontend
    /// passes it back to `save_marker_icon`.
    pub hash: String,
    /// "png" | "svg" (normalized lowercase).
    pub kind: String,
    /// Bundle-relative path of the copied original.
    pub source_file: String,
    /// Original filename (display only).
    pub source_name: String,
    /// Absolute path of the copied original — for the webview to load and
    /// bake via the asset protocol. Transient; never persisted.
    pub source_abs_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MarkerIconInfo {
    /// Bundle-relative path of the baked render asset.
    pub icon_file: String,
    /// Parsed (authoritative) texel dims of the baked PNG.
    pub width: u32,
    pub height: u32,
}

/// Content hash over the file bytes, same 16-hex format as
/// `util::hash::path_hash` (which hashes the PATH — proxies want a stable
/// name per source file; assets want a stable name per content).
fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    format!("{:016x}", hasher.finish())
}

/// Reject anything that isn't exactly the 16-lowercase-hex shape
/// `content_hash` produces — the hash becomes part of a filename inside the
/// bundle, so this is the path-traversal guard.
fn validate_hash(hash: &str) -> Result<(), String> {
    if hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        Ok(())
    } else {
        Err(format!("Invalid asset hash '{}'", hash))
    }
}

/// Path-traversal guard for stored marker-asset relative paths: only the
/// exact filename shapes this module (or its v10 predecessor) ever produced
/// are deletable — `assets/(marker|pov)-(icon|source)-<16hex>.(png|svg)`.
/// Anything else (hand-edited project.json, `..` segments, absolute paths)
/// is rejected loudly instead of touching the filesystem.
fn validate_marker_asset_path(rel: &str) -> Result<(), String> {
    let err = || format!("Invalid marker asset path '{}'", rel);
    let name = rel.strip_prefix("assets/").ok_or_else(err)?;
    let rest = name
        .strip_prefix("marker-")
        .or_else(|| name.strip_prefix("pov-"))
        .ok_or_else(err)?;
    let rest = rest
        .strip_prefix("icon-")
        .or_else(|| rest.strip_prefix("source-"))
        .ok_or_else(err)?;
    let (hash, ext) = rest.split_once('.').ok_or_else(err)?;
    validate_hash(hash).map_err(|_| err())?;
    if ext == "png" || ext == "svg" {
        Ok(())
    } else {
        Err(err())
    }
}

/// Copy a user-picked PNG/SVG into the project bundle's `assets/` directory
/// as a marker-library source asset. Validation is loud and specific; the
/// copy is atomic so a crash can never leave a truncated asset that a saved
/// project.json references.
#[tauri::command]
pub fn import_marker_image(
    file_path: String,
    project_dir: String,
) -> Result<MarkerImportInfo, String> {
    let source = Path::new(&file_path);
    if !source.exists() {
        return Err(format!("Source file not found: {}", file_path));
    }
    let meta = std::fs::metadata(source)
        .map_err(|e| format!("Failed to stat marker image: {}", e))?;
    if meta.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "Marker image is {:.1} MB — the limit is {} MB",
            meta.len() as f64 / (1024.0 * 1024.0),
            MAX_SOURCE_BYTES / (1024 * 1024),
        ));
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let bytes =
        std::fs::read(source).map_err(|e| format!("Failed to read marker image: {}", e))?;
    let kind = sniff_kind(&bytes, &ext)?;

    let hash = content_hash(&bytes);
    let assets_rel = format!("assets/marker-source-{}.{}", hash, kind);
    let dir = Path::new(&project_dir);
    ensure_dir(&dir.join("assets"))?;
    let dest = dir.join(&assets_rel);
    write_atomic(&dest, &bytes)?;

    let source_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();

    Ok(MarkerImportInfo {
        hash,
        kind: kind.to_string(),
        source_file: assets_rel,
        source_name,
        source_abs_path: dest.to_string_lossy().into_owned(),
    })
}

/// Sniff the upload's real type from its leading bytes. Extension alone is
/// not trusted: a renamed JPEG must fail HERE with a clear message, not
/// downstream in the webview decoder with a generic one.
fn sniff_kind(bytes: &[u8], ext: &str) -> Result<&'static str, String> {
    match ext {
        "png" => {
            if bytes.len() >= 8 && bytes[..8] == PNG_MAGIC {
                Ok("png")
            } else {
                Err("File has a .png extension but is not a PNG (bad signature)".into())
            }
        }
        "svg" => {
            // SVG is XML text: accept an optional BOM / XML prolog /
            // comments / whitespace, but the document must actually contain
            // an `<svg` root somewhere in the head of the file.
            let head_len = bytes.len().min(4096);
            let head = String::from_utf8_lossy(&bytes[..head_len]);
            if head.contains("<svg") {
                Ok("svg")
            } else {
                Err("File has a .svg extension but no <svg> root element".into())
            }
        }
        other => Err(format!(
            "Unsupported marker image type '.{}' (supported: .png, .svg)",
            other
        )),
    }
}

/// Persist the frontend-baked marker render asset (always PNG) into the
/// bundle. This command is the authority on the baked asset's validity:
/// signature + full header parse via the `png` crate, dims from the parse
/// (never from the caller), renderer texture cap enforced here so an
/// oversized bake can't be persisted and then explode at export time.
/// Returns the parsed dims for the frontend to store on the library entry.
#[tauri::command]
pub fn save_marker_icon(
    project_dir: String,
    hash: String,
    png_base64: String,
) -> Result<MarkerIconInfo, String> {
    validate_hash(&hash)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| format!("Baked marker icon is not valid base64: {}", e))?;
    if bytes.len() < 8 || bytes[..8] != PNG_MAGIC {
        return Err("Baked marker icon is not a PNG (bad signature)".into());
    }
    let decoder = png::Decoder::new(std::io::Cursor::new(&bytes));
    let reader = decoder
        .read_info()
        .map_err(|e| format!("Baked marker icon failed to parse as PNG: {}", e))?;
    let info = reader.info();
    let (width, height) = (info.width, info.height);
    if width == 0 || height == 0 {
        return Err(format!(
            "Baked marker icon has degenerate dims {}x{}",
            width, height
        ));
    }
    if width > MAX_ICON_TEXELS || height > MAX_ICON_TEXELS {
        return Err(format!(
            "Baked marker icon is {}x{} — the render asset must be ≤ {} texels per side \
             (the export renderer's texture cap); the frontend bake should have downscaled it",
            width, height, MAX_ICON_TEXELS,
        ));
    }

    let assets_rel = format!("assets/marker-icon-{}.png", hash);
    let dir = Path::new(&project_dir);
    ensure_dir(&dir.join("assets"))?;
    write_atomic(&dir.join(&assets_rel), &bytes)?;

    Ok(MarkerIconInfo {
        icon_file: assets_rel,
        width,
        height,
    })
}

/// Delete a marker-library entry's asset files from the bundle. The
/// frontend calls this AFTER removing every reference to the entry from
/// project state (project selections, per-clip overrides, per-waypoint
/// overrides) — the confirm dialog is the safety gate; content-hash naming
/// means a re-import restores identical files. Idempotent on
/// already-missing files.
#[tauri::command]
pub fn delete_marker_image(
    project_dir: String,
    icon_file: String,
    source_file: String,
) -> Result<(), String> {
    validate_marker_asset_path(&icon_file)?;
    validate_marker_asset_path(&source_file)?;
    let dir = Path::new(&project_dir);
    for rel in [&icon_file, &source_file] {
        let path = dir.join(rel);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to delete marker asset {}: {}", rel, e)),
        }
    }
    Ok(())
}

/// Convenience assembler used by tests (and available to future callers):
/// combine the two command results into the persisted `MarkerImage` model.
pub fn marker_image_from_parts(import: &MarkerImportInfo, icon: &MarkerIconInfo) -> MarkerImage {
    MarkerImage {
        id: import.hash.clone(),
        icon_file: icon.icon_file.clone(),
        source_file: import.source_file.clone(),
        source_name: import.source_name.clone(),
        width: icon.width,
        height: icon.height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "trailcut-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            tag,
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Minimal valid 1×1 RGBA PNG (pre-encoded).
    fn tiny_png() -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[10, 20, 30, 255]).unwrap();
        }
        out
    }

    fn png_of_dims(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, w, h);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&vec![0u8; (w * h * 4) as usize])
                .unwrap();
        }
        out
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn import_copies_png_into_assets_with_content_hash_name() {
        let bundle = temp_dir("import-png");
        let src_dir = temp_dir("src-png");
        let src = src_dir.join("will.png");
        std::fs::write(&src, tiny_png()).unwrap();

        let info = import_marker_image(
            src.to_string_lossy().into_owned(),
            bundle.to_string_lossy().into_owned(),
        )
        .expect("png import must succeed");

        assert_eq!(info.kind, "png");
        assert_eq!(info.source_name, "will.png");
        assert_eq!(info.hash.len(), 16);
        assert_eq!(
            info.source_file,
            format!("assets/marker-source-{}.png", info.hash)
        );
        let copied = bundle.join(&info.source_file);
        assert!(copied.exists(), "original must be copied into assets/");
        assert_eq!(std::fs::read(copied).unwrap(), tiny_png());

        // Idempotent: re-importing identical content lands on the same name.
        let again = import_marker_image(
            src.to_string_lossy().into_owned(),
            bundle.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(again.hash, info.hash);

        let _ = std::fs::remove_dir_all(&bundle);
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    #[test]
    fn import_accepts_svg_with_prolog_and_rejects_fake_svg() {
        let bundle = temp_dir("import-svg");
        let src_dir = temp_dir("src-svg");
        let good = src_dir.join("marker.svg");
        std::fs::write(
            &good,
            "<?xml version=\"1.0\"?>\n<!-- hi -->\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        let info = import_marker_image(
            good.to_string_lossy().into_owned(),
            bundle.to_string_lossy().into_owned(),
        )
        .expect("svg import must succeed");
        assert_eq!(info.kind, "svg");

        let fake = src_dir.join("fake.svg");
        std::fs::write(&fake, "just some text").unwrap();
        let err = import_marker_image(
            fake.to_string_lossy().into_owned(),
            bundle.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(err.contains("no <svg> root"), "got: {}", err);

        let _ = std::fs::remove_dir_all(&bundle);
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    #[test]
    fn import_rejects_renamed_non_png_missing_file_and_bad_extension() {
        let bundle = temp_dir("import-rejects");
        let src_dir = temp_dir("src-rejects");

        let renamed = src_dir.join("actually-a-jpeg.png");
        std::fs::write(&renamed, [0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]).unwrap();
        let err = import_marker_image(
            renamed.to_string_lossy().into_owned(),
            bundle.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(err.contains("bad signature"), "got: {}", err);

        let err = import_marker_image(
            src_dir.join("missing.png").to_string_lossy().into_owned(),
            bundle.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(err.contains("not found"), "got: {}", err);

        let gif = src_dir.join("nope.gif");
        std::fs::write(&gif, b"GIF89a").unwrap();
        let err = import_marker_image(
            gif.to_string_lossy().into_owned(),
            bundle.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(err.contains("Unsupported marker image type"), "got: {}", err);

        let _ = std::fs::remove_dir_all(&bundle);
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    #[test]
    fn save_marker_icon_parses_authoritative_dims_and_writes_atomically() {
        let bundle = temp_dir("save-icon");
        let png = png_of_dims(300, 376);
        let info = save_marker_icon(
            bundle.to_string_lossy().into_owned(),
            "0123456789abcdef".into(),
            b64(&png),
        )
        .expect("save must succeed");
        assert_eq!(info.icon_file, "assets/marker-icon-0123456789abcdef.png");
        assert_eq!((info.width, info.height), (300, 376));
        assert_eq!(std::fs::read(bundle.join(&info.icon_file)).unwrap(), png);
        assert!(!bundle
            .join("assets/.marker-icon-0123456789abcdef.png.tmp")
            .exists());
        let _ = std::fs::remove_dir_all(&bundle);
    }

    #[test]
    fn save_marker_icon_rejects_oversized_garbage_and_traversal_hash() {
        let bundle = temp_dir("save-rejects");
        let dir = bundle.to_string_lossy().into_owned();

        // Over the renderer texture cap.
        let err = save_marker_icon(
            dir.clone(),
            "0123456789abcdef".into(),
            b64(&png_of_dims(1025, 8)),
        )
        .unwrap_err();
        assert!(err.contains("texture cap"), "got: {}", err);

        // Not a PNG.
        let err = save_marker_icon(dir.clone(), "0123456789abcdef".into(), b64(b"hello"))
            .unwrap_err();
        assert!(err.contains("bad signature"), "got: {}", err);

        // Not base64.
        let err = save_marker_icon(dir.clone(), "0123456789abcdef".into(), "!!!".into())
            .unwrap_err();
        assert!(err.contains("base64"), "got: {}", err);

        // Path-traversal shaped "hash".
        let err =
            save_marker_icon(dir.clone(), "../../evil".into(), b64(&tiny_png())).unwrap_err();
        assert!(err.contains("Invalid asset hash"), "got: {}", err);
        let err = save_marker_icon(dir, "0123456789ABCDEF".into(), b64(&tiny_png())).unwrap_err();
        assert!(err.contains("Invalid asset hash"), "got: {}", err);

        let _ = std::fs::remove_dir_all(&bundle);
    }

    #[test]
    fn delete_removes_both_assets_and_is_idempotent() {
        let bundle = temp_dir("delete-marker");
        let assets = bundle.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        let icon_rel = "assets/marker-icon-0123456789abcdef.png";
        let source_rel = "assets/marker-source-0123456789abcdef.svg";
        std::fs::write(bundle.join(icon_rel), tiny_png()).unwrap();
        std::fs::write(bundle.join(source_rel), "<svg/>").unwrap();

        delete_marker_image(
            bundle.to_string_lossy().into_owned(),
            icon_rel.into(),
            source_rel.into(),
        )
        .expect("delete must succeed");
        assert!(!bundle.join(icon_rel).exists());
        assert!(!bundle.join(source_rel).exists());

        // Idempotent: deleting the same (now missing) files succeeds.
        delete_marker_image(
            bundle.to_string_lossy().into_owned(),
            icon_rel.into(),
            source_rel.into(),
        )
        .expect("repeat delete must succeed");

        let _ = std::fs::remove_dir_all(&bundle);
    }

    #[test]
    fn delete_accepts_legacy_pov_names_and_rejects_traversal() {
        let bundle = temp_dir("delete-guard");
        let assets = bundle.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        // Legacy v10 asset names are deletable.
        let icon_rel = "assets/pov-icon-0123456789abcdef.png";
        let source_rel = "assets/pov-source-0123456789abcdef.svg";
        std::fs::write(bundle.join(icon_rel), tiny_png()).unwrap();
        std::fs::write(bundle.join(source_rel), "<svg/>").unwrap();
        delete_marker_image(
            bundle.to_string_lossy().into_owned(),
            icon_rel.into(),
            source_rel.into(),
        )
        .expect("legacy-name delete must succeed");
        assert!(!bundle.join(icon_rel).exists());

        // Anything outside the strict shape is rejected before touching disk.
        let victim = bundle.join("project.json");
        std::fs::write(&victim, "{}").unwrap();
        for bad in [
            "project.json",
            "assets/../project.json",
            "/etc/passwd",
            "assets/marker-icon-0123456789abcdef.exe",
            "assets/marker-icon-../../evil.png",
            "assets/other-icon-0123456789abcdef.png",
        ] {
            let err = delete_marker_image(
                bundle.to_string_lossy().into_owned(),
                bad.into(),
                "assets/marker-source-0123456789abcdef.svg".into(),
            )
            .unwrap_err();
            assert!(err.contains("Invalid marker asset path"), "{} → {}", bad, err);
        }
        assert!(victim.exists(), "guard must reject before deleting anything");

        let _ = std::fs::remove_dir_all(&bundle);
    }

    #[test]
    fn marker_image_assembles_from_parts_with_hash_id() {
        let import = MarkerImportInfo {
            hash: "0123456789abcdef".into(),
            kind: "svg".into(),
            source_file: "assets/marker-source-0123456789abcdef.svg".into(),
            source_name: "hiker.svg".into(),
            source_abs_path: "/tmp/x".into(),
        };
        let icon = MarkerIconInfo {
            icon_file: "assets/marker-icon-0123456789abcdef.png".into(),
            width: 1024,
            height: 812,
        };
        let img = marker_image_from_parts(&import, &icon);
        assert_eq!(img.id, "0123456789abcdef");
        assert_eq!(img.source_name, "hiker.svg");
        assert_eq!(img.icon_file, icon.icon_file);
        assert_eq!((img.width, img.height), (1024, 812));
    }
}
