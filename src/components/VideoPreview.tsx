import { useRef, useState, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

interface VideoPreviewProps {
  proxyPath: string | null;
  clipFilename: string;
}

function formatTime(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export default function VideoPreview({ proxyPath, clipFilename }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);

  // Reset state when clip changes
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [proxyPath]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  }

  function handleTimeUpdate() {
    if (!seeking && videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  }

  function handleLoadedMetadata() {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  }

  function handleEnded() {
    setPlaying(false);
  }

  if (!proxyPath) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyIcon}>&#9654;</div>
        <p style={styles.emptyText}>Select a clip to preview</p>
      </div>
    );
  }

  const videoSrc = convertFileSrc(proxyPath);

  return (
    <div style={styles.container}>
      <video
        ref={videoRef}
        src={videoSrc}
        style={styles.video}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onClick={togglePlay}
        playsInline
      />
      <div style={styles.controls}>
        <button onClick={togglePlay} style={styles.playBtn}>
          {playing ? '\u275A\u275A' : '\u25B6'}
        </button>
        <span style={styles.time}>{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={handleSeek}
          onMouseDown={() => setSeeking(true)}
          onMouseUp={() => setSeeking(false)}
          style={styles.seekBar}
        />
        <span style={styles.time}>{formatTime(duration)}</span>
      </div>
      <div style={styles.filename}>{clipFilename}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: '#000',
  },
  video: {
    flex: 1,
    width: '100%',
    objectFit: 'contain',
    cursor: 'pointer',
    minHeight: 0,
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    backgroundColor: '#1a1a1a',
    borderTop: '1px solid #333',
  },
  playBtn: {
    width: '32px',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2a2a2a',
    color: '#fff',
    border: '1px solid #444',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
    flexShrink: 0,
  },
  time: {
    fontSize: '12px',
    color: '#999',
    fontVariantNumeric: 'tabular-nums',
    minWidth: '36px',
    flexShrink: 0,
  },
  seekBar: {
    flex: 1,
    height: '4px',
    cursor: 'pointer',
    accentColor: '#ff6b35',
  },
  filename: {
    padding: '4px 12px',
    fontSize: '11px',
    color: '#666',
    backgroundColor: '#1a1a1a',
    textAlign: 'center',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    backgroundColor: '#0a0a0a',
  },
  emptyIcon: {
    fontSize: '48px',
    color: '#333',
    marginBottom: '8px',
  },
  emptyText: {
    color: '#555',
    fontSize: '14px',
  },
};
