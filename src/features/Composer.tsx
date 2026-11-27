import { IconClock, IconPaperclip, IconSend, IconSignature, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { backend, errorText } from "../backend";
import { RichText } from "../components/RichText";
import { Button, IconButton, Menu } from "../components/ui";
import { fileSize } from "../lib/search";
import { signatureHtml } from "../lib/signature";
import { useStore } from "../store";
import type { Contact, Draft } from "../types";
import { mod } from "../lib/keys";

const field = "flex items-center gap-3 border-b border-edge py-2";
const label = "w-16 flex-none text-ink2";
const input = "min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink3";

/** Where the recipient around the cursor starts and ends in the field, and its text. */
export function tokenAt(value: string, caret: number): { start: number; end: number; text: string } {
  let start = Math.min(caret, value.length);
  let end = start;
  while (start > 0 && !/[,;]/.test(value[start - 1])) start--;
  while (end < value.length && !/[,;]/.test(value[end])) end++;
  return { start, end, text: value.slice(start, end).trim() };
}

/** Text after the last comma or semicolon: the recipient being typed. */
export function lastToken(value: string): string {
  return tokenAt(value, value.length).text;
}

/** Replace the recipient around the cursor with a chosen contact; also returns where the cursor goes. */
export function completeAt(value: string, caret: number, contact: Contact): { value: string; caret: number } {
  const { start, end } = tokenAt(value, caret);
  const before = value.slice(0, start);
  const after = value.slice(end).replace(/^[,;]\s*/, "");
  const entry = contact.name ? `${contact.name.replace(/[,;<>"]/g, " ").trim()} <${contact.address}>` : contact.address;
  const head = `${before}${before && !before.endsWith(" ") ? " " : ""}${entry}`;
  // At the end, ready for the next address; in the middle, just after the one completed.
  return after ? { value: `${head}, ${after}`, caret: head.length } : { value: `${head}, `, caret: head.length + 2 };
}

/** Replace the recipient being typed with a chosen contact. */
export function completeWith(value: string, contact: Contact): string {
  return completeAt(value, value.length, contact).value;
}

/** A whole address has been typed (name@domain.tld), so Tab should move on rather than complete it. */
export function looksComplete(text: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>.]{2,}$/.test(text);
}

function Recipients({ name, value, onChange, autoFocus }: { name: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  // The suggestions and the text they were found for: while a newer search is on its way they
  // may still be shown, but the keyboard must not put an old match in place of what was typed.
  const [found, setFound] = useState<{ for: string; contacts: Contact[] }>({ for: "", contacts: [] });
  const suggestions = found.contacts;
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(value.length);
  // The highlighted suggestion (-1: none), whether it was chosen with the arrow keys, and whether Escape hid the list.
  const [active, setActive] = useState(-1);
  const [moved, setMoved] = useState(false);
  const [hidden, setHidden] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const token = tokenAt(value, caret).text;
  useEffect(() => {
    setHidden(false);
    setMoved(false);
    if (token.length < 2 || token.includes(">")) return setFound({ for: token, contacts: [] });
    let current = true;
    void backend.suggestContacts(token).then((contacts) => {
      if (!current) return;
      setFound({ for: token, contacts });
      // A finished address gets no highlight, so Tab moves on; the list stays to pick from.
      setActive(contacts.length > 0 && !looksComplete(token) ? 0 : -1);
    });
    return () => {
      current = false;
    };
  }, [token]);
  const open = focused && !hidden && suggestions.length > 0;
  const fresh = found.for === token;

  function choose(contact: Contact) {
    const done = completeAt(value, caret, contact);
    onChange(done.value);
    setCaret(done.caret);
    setFound({ for: "", contacts: [] });
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(done.caret, done.caret));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || e.nativeEvent.isComposing) return;
    const n = suggestions.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setMoved(true);
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
    } else if ((e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Only suggestions found for the text now in the field; otherwise Tab and Enter work as usual.
      if (!fresh || active < 0 || active >= n || (!moved && looksComplete(token))) return;
      e.preventDefault();
      choose(suggestions[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setHidden(true);
    }
  }

  return (
    <label className={`${field} relative`}>
      <span className={label}>{name}</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setCaret(e.target.selectionStart ?? e.target.value.length);
          onChange(e.target.value);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? value.length)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder={name === "To" ? "name@company.com" : undefined}
        className={input}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && fresh && active >= 0 ? `${listId}-${active}` : undefined}
      />
      {open && (
        <div id={listId} className="absolute top-full left-16 z-20 mt-1 min-w-72 rounded-[10px] border border-edge bg-card py-1 shadow-lg" role="listbox" aria-label={`${name} suggestions`}>
          {suggestions.map((c, i) => (
            <button
              key={c.address}
              id={`${listId}-${i}`}
              type="button"
              role="option"
              aria-selected={fresh && i === active}
              // Not a Tab stop: Tab from the field goes to the next field, not into this list.
              tabIndex={-1}
              // onMouseDown: act before the input loses focus and the list closes.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${fresh && i === active ? "bg-hover" : "hover:bg-hover"}`}
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
  // Attachments of the message being forwarded; they travel along unless removed here.
  const [forwarded, setForwarded] = useState(draft.forwarded?.items ?? []);
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

  const snapshot = (): Draft => ({ ...draft, id: draftId.current, accountId, to, cc, bcc, subject, html: html.current, attachments: files, forwarded: draft.forwarded ? { ...draft.forwarded, items: forwarded } : undefined });
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
        if (mod(e) && e.key === "Enter") void submit();
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
      {(files.length > 0 || forwarded.length > 0) && (
        <div className="mt-3 flex flex-none flex-wrap gap-2">
          {forwarded.map((item) => (
            <span key={`fw-${item.index}`} className="inline-flex items-center gap-1.5 rounded-[10px] border border-edge py-1 pr-1 pl-2.5 text-ink2" title="From the forwarded message">
              <IconPaperclip size={15} />
              {item.name}
              <span className="text-xs text-ink3">{fileSize(item.size)}</span>
              <IconButton
                label={`Remove ${item.name}`}
                className="size-6"
                onClick={() => {
                  setForwarded((all) => all.filter((x) => x.index !== item.index));
                  touch();
                }}
              >
                <IconX size={14} />
              </IconButton>
            </span>
          ))}
          {files.map((path) => (
            <span key={path} className="inline-flex items-center gap-1.5 rounded-[10px] border border-edge py-1 pr-1 pl-2.5 text-ink2" title={path}>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 hover:text-ink hover:underline"
                title={`Open ${path}`}
                onClick={() => void backend.openPickedFile(path).catch((e) => setError(errorText(e)))}
              >
                <IconPaperclip size={15} />
                {path.split(/[\\/]/).pop()}
              </button>
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
