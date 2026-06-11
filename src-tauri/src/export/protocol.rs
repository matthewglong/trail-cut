// Wire types and stdio reader for the renderer-worker protocol.
//
// Source of truth for the wire format is task 020 + the worker source at
// src-tauri/sidecars/renderer/index.ts. This module only encodes/decodes
// what 020 defines; it does not reimplement worker-side logic.
//
// Wire format on stdin (orchestrator → worker): line-delimited JSON commands.
// Wire format on stdout (worker → orchestrator): two payload kinds, in a
// state-machine order driven by which command was last sent.
//   - Ready replies:   `{"ready":true}\n`        (after setup, after recycle)
//   - Frame buffers:   `[4-byte BE length N][N bytes RGBA]`  (after render)

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Viewport {
    pub w: u32,
    pub h: u32,
}

/// Setup payload sent to a worker. The `project_state` field carries the
/// `timeline`, `route`, `clips`, and `mapSettings` keys as opaque JSON — the
/// orchestrator does not parse these. Defining a Rust mirror of
/// `CompiledTimeline` (the TS-only output of `compileTimeline`) would force
/// a second source of truth that drifts whenever camera intent evolves.
/// Pass-through is correct: Rust enforces only the wrapping shape.
///
/// `css_viewport` is the CSS-pixel viewport size the renderer page is laid
/// out at (matches `canonicalMapCssWidth(aspect)` on the W axis). `framebuffer`
/// is the WebGL drawing-buffer the renderer paints into — the map slot dims ×
/// the SSAA supersample factor. `readback` is the dims the renderer
/// downsamples that buffer to (on-GPU) and writes back — equal to the map
/// slot pixel dims, which is what `frame_bytes_per_input` validates against.
/// `pixel_ratio = framebuffer.w / css_viewport.w` (a float; carries the
/// supersample factor, so > 1 for every supersampled export).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupPayload {
    #[serde(rename = "cssViewport")]
    pub css_viewport: Viewport,
    #[serde(rename = "framebuffer")]
    pub framebuffer: Viewport,
    #[serde(rename = "readback")]
    pub readback: Viewport,
    #[serde(rename = "pixelRatio")]
    pub pixel_ratio: f64,
    pub fps: u32,
    #[serde(flatten)]
    pub project_state: Value,
}

#[derive(Serialize)]
struct SetupWire<'a> {
    cmd: &'static str,
    #[serde(rename = "cssViewport")]
    css_viewport: Viewport,
    #[serde(rename = "framebuffer")]
    framebuffer: Viewport,
    #[serde(rename = "readback")]
    readback: Viewport,
    #[serde(rename = "pixelRatio")]
    pixel_ratio: f64,
    fps: u32,
    #[serde(flatten)]
    project_state: &'a Value,
}

#[derive(Serialize)]
struct RenderWire {
    cmd: &'static str,
    frame_index: u32,
    project_time_ms: u64,
}

/// Build the setup-command line (terminated with `\n`) that boots a worker.
pub fn setup_line(payload: &SetupPayload) -> serde_json::Result<String> {
    let mut s = serde_json::to_string(&SetupWire {
        cmd: "setup",
        css_viewport: payload.css_viewport,
        framebuffer: payload.framebuffer,
        readback: payload.readback,
        pixel_ratio: payload.pixel_ratio,
        fps: payload.fps,
        project_state: &payload.project_state,
    })?;
    s.push('\n');
    Ok(s)
}

/// Build a per-frame render command line (terminated with `\n`).
pub fn render_line(frame_index: u32, project_time_ms: u64) -> serde_json::Result<String> {
    let mut s = serde_json::to_string(&RenderWire {
        cmd: "render",
        frame_index,
        project_time_ms,
    })?;
    s.push('\n');
    Ok(s)
}

pub fn recycle_line() -> &'static str {
    "{\"cmd\":\"recycle\"}\n"
}

pub fn shutdown_line() -> &'static str {
    "{\"cmd\":\"shutdown\"}\n"
}

#[derive(Debug, Deserialize)]
pub struct ReadyReply {
    pub ready: bool,
}

/// Read a single ready-reply line from the worker. Errors if the stream
/// closes before a newline arrives, or the line isn't a valid `{"ready":...}`.
pub async fn read_ready<R: AsyncBufRead + Unpin>(reader: &mut R) -> std::io::Result<ReadyReply> {
    let mut line = String::new();
    let n = reader.read_line(&mut line).await?;
    if n == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "stream closed before ready reply",
        ));
    }
    let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
    let parsed: ReadyReply = serde_json::from_str(trimmed).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid ready reply '{}': {}", trimmed, e),
        )
    })?;
    if !parsed.ready {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("worker reported ready=false in '{}'", trimmed),
        ));
    }
    Ok(parsed)
}

/// Read a length-prefixed RGBA frame from the worker.
/// Wire format: `[4-byte big-endian length N][N bytes]`.
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> std::io::Result<Vec<u8>> {
    let mut prefix = [0u8; 4];
    reader.read_exact(&mut prefix).await?;
    let len = u32::from_be_bytes(prefix) as usize;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tokio::io::BufReader;

    /// Mirrors the JS StdoutReader in `__tests__/protocol.test.ts`: alternates
    /// between reading a ready line and a length-prefixed frame, in the order
    /// the orchestrator's state machine expects.
    #[tokio::test]
    async fn reads_ready_then_frame_alternation() {
        let mut bytes = Vec::new();
        // Setup → ready
        bytes.extend_from_slice(b"{\"ready\":true}\n");
        // Render → frame (4 bytes)
        bytes.extend_from_slice(&4u32.to_be_bytes());
        bytes.extend_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]);
        // Recycle → ready
        bytes.extend_from_slice(b"{\"ready\":true}\n");
        // Render → frame (3 bytes; demonstrates non-aligned lengths)
        bytes.extend_from_slice(&3u32.to_be_bytes());
        bytes.extend_from_slice(&[0x01, 0x02, 0x03]);

        let cursor = Cursor::new(bytes);
        let mut reader = BufReader::new(cursor);

        let r1 = read_ready(&mut reader).await.expect("ready 1");
        assert!(r1.ready);

        let f1 = read_frame(&mut reader).await.expect("frame 1");
        assert_eq!(f1, vec![0xAA, 0xBB, 0xCC, 0xDD]);

        let r2 = read_ready(&mut reader).await.expect("ready 2");
        assert!(r2.ready);

        let f2 = read_frame(&mut reader).await.expect("frame 2");
        assert_eq!(f2, vec![0x01, 0x02, 0x03]);
    }

    #[tokio::test]
    async fn read_ready_rejects_eof() {
        let cursor = Cursor::new(Vec::<u8>::new());
        let mut reader = BufReader::new(cursor);
        let err = read_ready(&mut reader).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn read_ready_rejects_malformed_json() {
        let cursor = Cursor::new(b"not json\n".to_vec());
        let mut reader = BufReader::new(cursor);
        let err = read_ready(&mut reader).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn read_ready_rejects_ready_false() {
        let cursor = Cursor::new(b"{\"ready\":false}\n".to_vec());
        let mut reader = BufReader::new(cursor);
        let err = read_ready(&mut reader).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn read_frame_truncated_stream_errors() {
        // Length prefix says 10 bytes but only 5 follow.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&10u32.to_be_bytes());
        bytes.extend_from_slice(&[1, 2, 3, 4, 5]);
        let cursor = Cursor::new(bytes);
        let mut reader = BufReader::new(cursor);
        let err = read_frame(&mut reader).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn setup_line_includes_cmd_and_flattens_state() {
        let payload = SetupPayload {
            css_viewport: Viewport { w: 200, h: 400 },
            framebuffer: Viewport { w: 100, h: 200 },
            readback: Viewport { w: 50, h: 100 },
            pixel_ratio: 0.5,
            fps: 30,
            project_state: serde_json::json!({
                "timeline": { "clipSpans": [] },
                "route": null,
                "clips": [],
                "mapSettings": { "map_style": "default" },
            }),
        };
        let line = setup_line(&payload).unwrap();
        assert!(line.ends_with('\n'));
        let parsed: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(parsed["cmd"], "setup");
        // New shape: cssViewport, framebuffer, pixelRatio. Old `viewport` key
        // must be entirely absent so a stale page-side reader fails loudly.
        assert!(parsed.get("viewport").is_none(), "stale 'viewport' key in wire output");
        assert_eq!(parsed["cssViewport"]["w"], 200);
        assert_eq!(parsed["cssViewport"]["h"], 400);
        assert_eq!(parsed["framebuffer"]["w"], 100);
        assert_eq!(parsed["framebuffer"]["h"], 200);
        assert_eq!(parsed["readback"]["w"], 50);
        assert_eq!(parsed["readback"]["h"], 100);
        assert_eq!(parsed["pixelRatio"], 0.5);
        assert_eq!(parsed["fps"], 30);
        assert_eq!(parsed["mapSettings"]["map_style"], "default");
        assert!(parsed["timeline"].is_object());
    }

    #[test]
    fn render_line_format() {
        let line = render_line(5, 166).unwrap();
        assert!(line.ends_with('\n'));
        let parsed: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(parsed["cmd"], "render");
        assert_eq!(parsed["frame_index"], 5);
        assert_eq!(parsed["project_time_ms"], 166);
    }

    #[test]
    fn recycle_and_shutdown_lines_are_canonical() {
        assert_eq!(recycle_line(), "{\"cmd\":\"recycle\"}\n");
        assert_eq!(shutdown_line(), "{\"cmd\":\"shutdown\"}\n");
    }
}
