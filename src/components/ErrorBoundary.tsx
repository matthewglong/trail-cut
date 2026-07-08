import { Component, type ErrorInfo, type ReactNode } from 'react';
import { semantic, fonts } from '../theme/tokens';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Top-level render/effect guard. Without it, any uncaught exception during
 *  render or a commit-phase effect unmounts the whole React tree and leaves a
 *  blank window (the schema-v11 `marker_images` crash was one such case). This
 *  degrades that failure into a legible error panel with the stack, so a
 *  single component's throw no longer takes down the app silently. Class
 *  component because error boundaries have no hooks equivalent. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the full context in the devtools/webview console for triage.
    console.error('Uncaught render error:', error, info.componentStack);
  }

  private handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          height: '100vh',
          width: '100vw',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
          padding: 40,
          background: semantic.bg,
          color: semantic.fg,
          fontFamily: fonts.sans,
          overflow: 'auto',
        }}
      >
        <div
          style={{
            maxWidth: 720,
            width: '100%',
            background: semantic.surface,
            border: `1px solid ${semantic.border}`,
            borderRadius: 12,
            padding: 28,
          }}
        >
          <h1
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: semantic.accentWarm,
              marginBottom: 8,
            }}
          >
            Something broke while rendering
          </h1>
          <p style={{ fontSize: 14, color: semantic.fgMuted, marginBottom: 16 }}>
            The app hit an unexpected error. Your project on disk is untouched —
            reload to try again. If it recurs, the details below help pin it down.
          </p>
          <pre
            style={{
              fontFamily: fonts.mono,
              fontSize: 12,
              lineHeight: 1.5,
              color: semantic.fg,
              background: semantic.surfaceDeep,
              border: `1px solid ${semantic.border}`,
              borderRadius: 8,
              padding: 14,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 280,
              overflow: 'auto',
              margin: 0,
            }}
          >
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ''}
          </pre>
          <button
            onClick={this.handleReload}
            style={{
              marginTop: 20,
              padding: '8px 18px',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: fonts.sans,
              color: semantic.bg,
              background: semantic.accent,
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
