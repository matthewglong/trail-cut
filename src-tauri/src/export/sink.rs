// Drain target for ordered RGBA frames out of the orchestrator.
//
// The trait is the seam task 060 plugs an FFmpeg sink into. v1 ships only
// `VecSink` (test-only collector). Real `FFmpegSink` lands in 060 with no
// orchestrator-side changes.

use std::sync::{Arc, Mutex};

pub type SinkError = Box<dyn std::error::Error + Send + Sync>;

pub trait FrameSink: Send {
    /// Called in strict frame-index order: 0, 1, 2, ..., total_frames-1.
    fn write_frame(&mut self, frame_index: u32, rgba: &[u8]) -> Result<(), SinkError>;

    /// Called once after all frames have been written. Consumes the sink so
    /// implementations like `FFmpegSink` can close stdin and wait for the
    /// encoder to flush + exit.
    fn finish(self: Box<Self>) -> Result<(), SinkError>;
}

type FrameStore = Arc<Mutex<Vec<(u32, Vec<u8>)>>>;

/// Test sink that collects frames in memory. Cloning shares the underlying
/// store via `Arc<Mutex<...>>` so a test can inspect the collected frames
/// after handing ownership of `Box<dyn FrameSink>` to the orchestrator.
#[derive(Default, Clone)]
pub struct VecSink {
    inner: FrameStore,
}

impl VecSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn frames(&self) -> Vec<(u32, Vec<u8>)> {
        self.inner.lock().unwrap().clone()
    }

    pub fn frame_count(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

impl FrameSink for VecSink {
    fn write_frame(&mut self, frame_index: u32, rgba: &[u8]) -> Result<(), SinkError> {
        self.inner.lock().unwrap().push((frame_index, rgba.to_vec()));
        Ok(())
    }

    fn finish(self: Box<Self>) -> Result<(), SinkError> {
        Ok(())
    }
}
