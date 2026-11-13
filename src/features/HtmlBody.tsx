import interFile from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import nunitoFile from "@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2?url";
import { useMemo, useRef, useState } from "react";
import { backend } from "../backend";
import { Button } from "../components/ui";
import { fontChoice, fontStack } from "../lib/font";
import { useStore } from "../store";

/** Senders whose pictures are always shown, as kept in the "image_senders" setting. */
export function imageSenders(setting: string | undefined): string[] {
  try {
    const list: unknown = JSON.parse(setting ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Mail HTML in a locked-down frame.
 *
 * The HTML is already sanitised by the Rust core. On top of that the frame
 * runs no scripts (sandbox), and its own policy blocks every network request;
 * remote images load only after the reader asks for them, and only over
 * HTTPS. The app's own policy (tauri.conf.json) must allow `img-src https:`
 * for that; the frame's stricter policy is what keeps them blocked by default.
 */
export function HtmlBody({ html, note, sender }: { html: string; note?: string; sender: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // Select the stored text and parse it here: a selector must not build a new list on every call.
  const font = useStore((s) => fontChoice(s.settings.font));
  const systemFont = useStore((s) => s.systemFont);
  const textSize = useStore((s) => s.settings.text_size ?? "15");
  const stored = useStore((s) => s.settings.image_senders);
  const trusted = useMemo(() => imageSenders(stored), [stored]);
  const setSetting = useStore((s) => s.setSetting);
  const address = sender.trim().toLowerCase();
  const always = address !== "" && trusted.includes(address);
  const [once, setOnce] = useState(false);
  const images = once || always;
  const setAlways = (on: boolean) => void setSetting("image_senders", JSON.stringify(on ? [...trusted, address] : trusted.filter((a) => a !== address)));
  const [height, setHeight] = useState(120);
  const hasRemoteImages = /<img[^>]+src=["']?https:/i.test(html);

  const doc = useMemo(() => {
    const img = images ? "data: cid: https:" : "data: cid:";
    const fontUrl = new URL(font === "nunito" ? nunitoFile : interFile, window.location.href).href;
    const fontOrigin = new URL(fontUrl).origin;
    // Mail text uses the same font, weight and size as the rest of the window.
    const family = font === "system" ? fontStack("system", systemFont.family) : '"OpenWren Sans", system-ui, sans-serif';
    const weight = font === "system" && systemFont.light ? 300 : 400;
    // Mail is always shown dark on white. In the light theme it sits straight on the page;
    // in the dark theme it becomes a white sheet, which needs its own margin.
    const theme = document.documentElement.dataset.theme;
    const dark = theme === "dark" || (!theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const padding = dark ? "12px 14px" : "2px 0";
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src ${fontOrigin}">
<style>
  /* The app's own font, so mail text matches the rest of the window. It is the only thing the frame may load. */
  @font-face { font-family: "OpenWren Sans"; src: url("${fontUrl}") format("woff2"); font-weight: 200 1000; }
  html, body { margin: 0; padding: 0; }
  body { font: ${weight} ${textSize}px/1.6 ${family}; color: #1f2328; background: #fff; padding: ${padding}; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  a { color: #1a64b0; }
  blockquote { margin: 0 0 0 8px; padding-left: 10px; border-left: 3px solid #e3e6ea; color: #5f6772; }
</style></head><body>${html}</body></html>`;
  }, [html, images, font, systemFont, textSize]);

  function onLoad() {
    const inner = frame.current?.contentDocument;
    if (!inner) return;
    const measure = () => setHeight(inner.documentElement.scrollHeight);
    measure();
    inner.querySelectorAll("img").forEach((i) => i.addEventListener("load", measure));
    // Links never navigate the frame; they open in the system browser.
    inner.addEventListener("click", (e) => {
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (!link) return;
      e.preventDefault();
      const href = link.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) void backend.openLink(href);
    });
  }

  return (
    <div>
      {hasRemoteImages && !images && (
        <div className="mb-2 flex items-center gap-3 rounded-[10px] bg-canvas px-3 py-1.5 text-[13px] text-ink2">
          Images from the internet are hidden to protect your privacy.
          <Button className="ml-auto h-7 flex-none" onClick={() => setOnce(true)}>
            Show images
          </Button>
          {address && (
            <Button className="h-7 flex-none" onClick={() => setAlways(true)}>
              Always from this sender
            </Button>
          )}
        </div>
      )}
      {hasRemoteImages && always && (
        <p className="mb-2 px-1 text-xs text-ink3">
          Images from {address} are always shown.{" "}
          <button type="button" className="text-brand underline" onClick={() => setAlways(false)}>
            Stop
          </button>
        </p>
      )}
      {note && <p className="mb-2 px-1 text-xs text-ink3">{note}</p>}
      <iframe
        ref={frame}
        title="Message"
        sandbox="allow-same-origin"
        srcDoc={doc}
        onLoad={onLoad}
        style={{ height }}
        className="w-full rounded-[10px] bg-white"
      />
    </div>
  );
}
