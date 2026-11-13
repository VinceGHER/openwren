import { IconClock, IconPaperclip, IconSend, IconSignature, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { backend, errorText } from "../backend";
import { RichText } from "../components/RichText";
import { Button, IconButton, Menu } from "../components/ui";
import { signatureHtml } from "../lib/signature";
import { useStore } from "../store";
import type { Contact, Draft } from "../types";

const field = "flex items-center gap-3 border-b border-edge py-2";
const label = "w-16 flex-none text-ink2";
const input = "min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink3";

/** Text after the last comma or semicolon: the recipient being typed. */
export function lastToken(value: string): string {
  return value.split(/[,;]/).pop()!.trim();
}

/** Replace the recipient being typed with a chosen contact. */
export function completeWith(value: string, contact: Contact): string {
  const done = value.slice(0, value.length - value.split(/[,;]/).pop()!.length);
  const entry = contact.name ? `${contact.name.replace(/[,;<>"]/g, " ").trim()} <${contact.address}>` : contact.address;
  return `${done}${done && !done.endsWith(" ") ? " " : ""}${entry}, `;
}

function Recipients({ name, value, onChange, autoFocus }: { name: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [focused, setFocused] = useState(false);
  const token = lastToken(value);
  useEffect(() => {
    if (token.length < 2 || token.includes(">")) return setSuggestions([]);
    let current = true;
    void backend.suggestContacts(token).then((found) => current && setSuggestions(found));
    return () => {
      current = false;
    };
  }, [token]);
  return (
    <label className={`${field} relative`}>
      <span className={label}>{name}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder={name === "To" ? "name@company.com" : undefined}
        className={input}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
      />
      {focused && suggestions.length > 0 && (
        <div className="absolute top-full left-16 z-20 mt-1 min-w-72 rounded-[10px] border border-edge bg-card py-1 shadow-lg" role="listbox" aria-label={`${name} suggestions`}>
          {suggestions.map((c) => (
            <button
              key={c.address}
              type="button"
              role="option"
              aria-selected={false}
              // onMouseDown: act before the input loses focus and the list closes.
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(completeWith(value, c));
                setSuggestions([]);
              }}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-hover"
            >
              <span>{c.name || c.address}</span>
              {c.name && <span className="text-xs text-ink2">{c.address}</span>}
            </button>
          ))}
        </div>
      )}
    </label>
  );
}

/** Unix seconds for the next occurrence of `weekday` (0 = Sunday, or null for tomorrow) at 8:00. */
function morning(weekday: number | null): number {
  const d = new Date();
  d.setHours(8, 0, 0, 0);
  do d.setDate(d.getDate() + 1);
  while (weekday !== null && d.getDay() !== weekday);
  return Math.floor(d.getTime() / 1000);
}

export function Composer({ className }: { className: string }) {
  const draft = useStore((s) => s.draft)!;
  const accounts = useStore((s) => s.accounts);
  const signatures = useStore((s) => s.signatures);
  const defaults = useStore((s) => s.signatureDefaults);
  const closeCompose = useStore((s) => s.closeCompose);
  const send = useStore((s) => s.send);
  const saveDraft = useStore((s) => s.saveDraft);
  const deleteDraft = useStore((s) => s.deleteDraft);

  const [accountId, setAccountId] = useState(draft.accountId);
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [bcc, setBcc] = useState(draft.bcc);
  const [showCopies, setShowCopies] = useState(draft.cc !== "" || draft.bcc !== "");
  const [subject, setSubject] = useState(draft.subject);
  const [files, setFiles] = useState(draft.attachments);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [later, setLater] = useState("");
  const html = useRef(draft.html);

  // The account's default signature for this kind of message; the user can switch.
  const defaultId = useMemo(() => {
    const d = defaults.find((x) => x.accountId === accountId);
    return (draft.isReply ? d?.replyId : d?.newId) ?? null;
  }, [defaults, accountId, draft.isReply]);
  const [signatureId, setSignatureId] = useState<number | null>(defaultId);
  useEffect(() => setSignatureId(defaultId), [defaultId]);
  const signature = signatures.find((s) => s.id === signatureId);

  // ----- saving as a draft, automatically -----
  const draftId = useRef(draft.id);
  /** Changed since the last save. */
  const dirty = useRef(false);
  /** Sent or discarded: nothing more may be saved. */
  const done = useRef(false);
  /** Saves run one after another, so a new draft is never stored twice. */
  const saving = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [saved, setSaved] = useState(draft.id !== undefined);

  const snapshot = (): Draft => ({ ...draft, id: draftId.current, accountId, to, cc, bcc, subject, html: html.current, attachments: files });
  const latest = useRef(snapshot);
  latest.current = snapshot;

  /** Save now, if anything changed. Uses only refs, so it also works while the composer closes. */
  const flush = useRef(() => {
    clearTimeout(timer.current);
    if (!dirty.current || done.current) return;
    dirty.current = false;
    saving.current = saving.current.then(async () => {
      if (done.current) return;
      try {
        draftId.current = await saveDraft(latest.current());
        setSaved(true);
      } catch (e) {
        console.error("save_draft failed", e);
      }
    });
  }).current;

  /** Note a change; the draft is saved shortly after the user stops typing. */
  function touch() {
    dirty.current = true;
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1500);
  }
  const edited =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      touch();
    };

  // Opening another message or folder closes the composer: keep what was written.
  useEffect(() => flush, [flush]);

  /** Stop saving and wait for a save that is under way. */
  async function finish() {
    done.current = true;
    clearTimeout(timer.current);
    await saving.current;
  }

  async function submit(sendAt?: number) {
    if (busy) return;
    if (![to, cc, bcc].some((v) => v.trim())) return setError("Add at least one recipient.");
    setError("");
    setBusy(true);
    try {
      await finish();
      await send(snapshot(), signature, sendAt);
    } catch (e) {
      done.current = false;
      setError(errorText(e));
      setBusy(false);
    }
  }

  async function discard() {
    await finish();
    if (draftId.current !== undefined) await deleteDraft(draftId.current);
    closeCompose();
  }

  async function attach() {
    try {
      const picked = await backend.pickFiles();
      setFiles((f) => [...f, ...picked.filter((p) => !f.includes(p))]);
      touch();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <section
      className={`${className} flex flex-col px-5 py-4`}
      aria-label="New message"
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === "Enter") void submit();
      }}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <Button variant="primary" onClick={() => void submit()}>
          <IconSend size={18} />
          {busy ? "Sending…" : "Send"}
        </Button>
        <Menu
          label="Send later"
          button={
            <span className="flex items-center gap-1 px-1 text-[13px]">
              <IconClock size={18} /> Send later
            </span>
          }
          items={[
            { label: "Tomorrow at 8:00", onSelect: () => void submit(morning(null)) },
            { label: "Monday at 8:00", onSelect: () => void submit(morning(1)) },
          ]}
        />
        <input
          type="datetime-local"
          aria-label="Send at a chosen time"
          value={later}
          onChange={(e) => setLater(e.target.value)}
          className="h-8 rounded-lg border border-edge bg-card px-2 text-[13px] text-ink2"
        />
        {later && (
          <Button
            className="h-8"
            onClick={() => {
              const at = Math.floor(new Date(later).getTime() / 1000);
              if (at * 1000 <= Date.now()) setError("Choose a time in the future.");
              else void submit(at);
            }}
          >
            Schedule
          </Button>
        )}
        <span className="ml-auto text-xs text-ink3" role="status">
          {saved ? "Draft saved" : ""}
        </span>
        <IconButton label="Discard draft" onClick={() => void discard()}>
          <IconTrash size={20} />
        </IconButton>
      </div>

      <label className={field}>
        <span className={label}>From</span>
        <select value={accountId} onChange={(e) => edited(setAccountId)(Number(e.target.value))} className={input}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.address}
            </option>
          ))}
        </select>
        {!showCopies && (
          <button type="button" className="flex-none text-ink2 hover:text-ink" onClick={() => setShowCopies(true)}>
            Cc Bcc
          </button>
        )}
      </label>
      <Recipients name="To" value={to} onChange={edited(setTo)} autoFocus={draft.to === ""} />
      {showCopies && (
        <>
          <Recipients name="Cc" value={cc} onChange={edited(setCc)} />
          <Recipients name="Bcc" value={bcc} onChange={edited(setBcc)} />
        </>
      )}
      <label className={field}>
        <span className={label}>Subject</span>
        <input value={subject} onChange={(e) => edited(setSubject)(e.target.value)} className={input} />
      </label>

      {error && (
        <p className="selectable mt-2 rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}

      <RichText
        className="mt-2.5 min-h-40 flex-1"
        label="Message"
        initial={draft.html}
        autoFocus={draft.to !== ""}
        onChange={(value) => {
          if (value === html.current) return; // the editor also reports its starting text
          html.current = value;
          touch();
        }}
        toolbarEnd={
          <>
            <button type="button" onClick={() => void attach()} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-ink2 hover:bg-hover">
              <IconPaperclip size={16} /> Attach
            </button>
            <label className="flex items-center gap-1 text-[13px] text-ink2">
              <IconSignature size={16} />
              <span className="sr-only">Signature</span>
              <select
                value={signatureId ?? ""}
                onChange={(e) => setSignatureId(e.target.value ? Number(e.target.value) : null)}
                className="bg-transparent text-ink outline-none"
                aria-label="Signature"
              >
                <option value="">No signature</option>
                {signatures.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        }
      />

      {signature && <div className="rich selectable mt-2 flex-none border-t border-dashed border-edge pt-2.5 text-ink2" dangerouslySetInnerHTML={{ __html: signatureHtml(signature) }} />}
      {draft.quote && <p className="mt-2 flex-none text-xs text-ink3">The original message is included below your text.</p>}
      {files.length > 0 && (
        <div className="mt-3 flex flex-none flex-wrap gap-2">
          {files.map((path) => (
            <span key={path} className="inline-flex items-center gap-1.5 rounded-[10px] border border-edge py-1 pr-1 pl-2.5 text-ink2" title={path}>
              <IconPaperclip size={15} />
              {path.split(/[\\/]/).pop()}
              <IconButton label="Remove attachment" className="size-6" onClick={() => {
                  setFiles((f) => f.filter((p) => p !== path));
                  touch();
                }}>
                <IconX size={14} />
              </IconButton>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
