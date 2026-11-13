import { IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { backend, errorText } from "../backend";
import { Button, IconButton } from "../components/ui";
import { useStore } from "../store";

/**
 * A message as it arrived: its headers, or the whole raw text. For checking
 * where a message really came from and which servers handled it.
 */
export function SourceView({ id }: { id: number }) {
  const showSource = useStore((s) => s.showSource);
  const showToast = useStore((s) => s.showToast);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [part, setPart] = useState<"headers" | "all">("headers");
  const close = () => showSource(null);

  useEffect(() => {
    let current = true;
    backend
      .messageSource(id)
      .then((text) => current && setSource(text))
      .catch((e) => current && setError(errorText(e)));
    return () => {
      current = false;
    };
  }, [id]);

  // Headers end at the first empty line.
  const end = source?.search(/\r?\n\r?\n/) ?? -1;
  const shown = source === null ? "" : part === "headers" && end > 0 ? source.slice(0, end) : source;
  const tab = (value: typeof part, name: string) => (
    <button type="button" aria-pressed={part === value} onClick={() => setPart(value)} className={`h-7 rounded-full px-3 text-[13px] ${part === value ? "bg-soft text-brand" : "border border-edge text-ink2 hover:bg-hover"}`}>
      {name}
    </button>
  );
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-label="Message source" className="flex h-full max-h-[720px] w-[860px] max-w-full flex-col overflow-hidden rounded-[14px] border border-edge bg-card shadow-xl" onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="flex flex-none items-center gap-2 border-b border-edge px-4 py-3">
          <span className="mr-2 text-base">Message source</span>
          {tab("headers", "Headers")}
          {tab("all", "Full source")}
          <Button
            className="ml-auto h-8"
            onClick={() =>
              void navigator.clipboard
                .writeText(shown)
                .then(() => showToast("Copied"))
                .catch(() => showToast("Could not copy. Select the text and press Ctrl+C."))
            }
          >
            Copy
          </Button>
          <IconButton label="Close" onClick={close}>
            <IconX size={20} />
          </IconButton>
        </div>
        {error ? (
          <p className="selectable p-4 text-danger" role="alert">
            {error}
          </p>
        ) : source === null ? (
          <p className="p-4 text-ink2">Fetching the message from the server…</p>
        ) : (
          <pre className="selectable min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-ink" tabIndex={0}>
            {shown}
          </pre>
        )}
      </div>
    </div>
  );
}
