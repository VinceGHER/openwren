import { Component, type ReactNode } from "react";

/**
 * Catches an error while drawing part of the window, so that part shows a
 * message instead of the whole window going blank.
 */
export class ErrorBoundary extends Component<{ what: string; resetKey?: unknown; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    console.error(`${this.props.what} failed to draw`, error);
  }

  // Showing something else (another message, another folder) gives it a fresh try.
  componentDidUpdate(previous: { resetKey?: unknown }) {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-[14px] border border-edge bg-card px-6 text-center text-ink2" role="alert">
        <p className="text-ink">{this.props.what} could not be shown.</p>
        <p className="selectable max-w-md text-[13px]">{this.state.error}</p>
        <button type="button" className="rounded-full border border-edge px-3 py-1 hover:bg-hover" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </section>
    );
  }
}
