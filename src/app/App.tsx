import { useCallback, useEffect, useState } from "react";
import { AddAccount } from "../features/AddAccount";
import { Settings } from "../features/Settings";
import { FolderPane } from "../features/FolderPane";
import { MessageList } from "../features/MessageList";
import { Onboarding } from "../features/Onboarding";
import { ReadingPane } from "../features/ReadingPane";
import { SourceView } from "../features/SourceView";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { fontChoice, fontStack } from "../lib/font";
import { useStore } from "../store";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Invisible drag strip in the gap between two panes. */
function Resizer({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const startX = e.clientX;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => onChange(clamp(value + ev.clientX - startX, min, max));
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    },
    [value, min, max, onChange],
  );
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onChange(clamp(value - 16, min, max));
        if (e.key === "ArrowRight") onChange(clamp(value + 16, min, max));
      }}
      // A hairline between panes; the wider invisible strip around it is what gets dragged.
      className="relative z-[1] w-px flex-none cursor-col-resize bg-edge after:absolute after:inset-y-0 after:-left-1 after:w-2 after:content-[''] hover:bg-line"
    />
  );
}

/** True while the user is typing somewhere, so single-key shortcuts must not fire. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

/** Keyboard shortcuts, following Outlook's (PLAN.md 6.4). */
function onShortcut(e: KeyboardEvent) {
  const s = useStore.getState();
  if (s.dialog || s.welcome) return;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && key === "n") return e.preventDefault(), s.compose();
  if (typing(e.target) || s.draft) return;
  const open = s.detail;
  const ids = s.targets();
  if (e.ctrlKey && e.shiftKey && key === "r") return e.preventDefault(), s.reply("reply-all");
  if (e.ctrlKey && key === "r") return e.preventDefault(), s.reply("reply");
  if (e.ctrlKey && key === "f") return e.preventDefault(), s.reply("forward");
  if (e.ctrlKey && key === "z") return e.preventDefault(), s.toast?.action?.run();
  if (e.ctrlKey && (key === "q" || key === "u")) return e.preventDefault(), ids.forEach((id) => void s.setFlags(id, { unread: key === "u" }));
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === "Delete" && ids.length) return e.preventDefault(), void s.deleteMessages(ids);
  if (e.key === "Backspace" && ids.length) return e.preventDefault(), void s.moveMessages(ids, { role: "archive" });
  if (e.key === "Insert" && open) return e.preventDefault(), void s.setFlags(open.id, { flagged: !open.flagged });
  if (e.key === "ArrowDown") return e.preventDefault(), s.step(1);
  if (e.key === "ArrowUp") return e.preventDefault(), s.step(-1);
}

/** Whole seconds left until `at` (milliseconds), counting down while shown. */
function useSecondsLeft(at: number | undefined): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (at === undefined) return;
    const timer = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [at]);
  return at === undefined ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function ToastBar() {
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);
  const left = useSecondsLeft(toast?.sendsAt);
  // Once the countdown ends the message is on its way and can no longer be taken back.
  useEffect(() => {
    if (left !== 0) return;
    const timer = setTimeout(dismiss, 1500);
    return () => clearTimeout(timer);
  }, [left, dismiss]);
  if (!toast) return null;
  const text = left === null ? toast.text : left === 0 ? "Sending…" : `Sending in ${left} ${left === 1 ? "second" : "seconds"}`;
  const action = left === 0 ? undefined : toast.action;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-4">
      <div role="status" className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-full border border-edge bg-card py-2 pr-2 pl-4 shadow-lg">
        <span className="selectable tabular-nums">{text}</span>
        {action && (
          <button
            type="button"
            className="rounded-full bg-soft px-3 py-1 font-semibold text-on-soft"
            onClick={() => {
              const run = action.run;
              dismiss();
              run();
            }}
          >
            {action.label}
          </button>
        )}
        <button type="button" aria-label="Dismiss" className="rounded-full px-2 py-1 text-ink2 hover:bg-hover" onClick={dismiss}>
          ✕
        </button>
      </div>
    </div>
  );
}

export function App() {
  const dialog = useStore((s) => s.dialog);
  const init = useStore((s) => s.init);
  const messageId = useStore((s) => s.messageId);
  const folderId = useStore((s) => s.folderId);
  const sourceOf = useStore((s) => s.sourceOf);
  const welcome = useStore((s) => s.welcome);

  const theme = useStore((s) => s.settings.theme ?? "system");
  const density = useStore((s) => s.settings.density ?? "cozy");

  useEffect(() => {
    void init();
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [init]);

  const font = useStore((s) => fontChoice(s.settings.font));
  const systemFont = useStore((s) => s.systemFont);
  const textSize = useStore((s) => s.settings.text_size ?? "15");
  // Font and text size are variables the stylesheet reads. Controls sized in rem follow the text size.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-sans", fontStack(font, systemFont.family));
    root.style.setProperty("--body-weight", font === "system" && systemFont.light ? "300" : "400");
    root.style.setProperty("--text-size", `${textSize}px`);
    root.style.fontSize = `${Number(textSize) + 2}px`;
  }, [font, systemFont, textSize]);

  // Theme and density are attributes on <html>; the stylesheet does the rest.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    root.setAttribute("data-density", density);
  }, [theme, density]);

  const [folderWidth, setFolderWidth] = useState(220);
  const [listWidth, setListWidth] = useState(340);
  return (
    <div className="relative flex h-full flex-col">
      <main className="flex min-h-0 flex-1 bg-card">
        <FolderPane width={folderWidth} />
        <Resizer value={folderWidth} min={160} max={360} onChange={setFolderWidth} label="Resize folder pane" />
        <ErrorBoundary what="The message list" resetKey={folderId}>
          <MessageList width={listWidth} />
        </ErrorBoundary>
        <Resizer value={listWidth} min={260} max={560} onChange={setListWidth} label="Resize message list" />
        <ErrorBoundary what="This message" resetKey={messageId}>
          <ReadingPane />
        </ErrorBoundary>
      </main>
      {welcome && <Onboarding />}
      {dialog === "add-account" && <AddAccount />}
      {dialog === "settings" && <Settings />}
      {sourceOf !== null && <SourceView key={sourceOf} id={sourceOf} />}
      <ToastBar />
    </div>
  );
}
