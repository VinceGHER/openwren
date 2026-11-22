import { IconBell, IconCloudDownload, IconCode, IconFilter, IconHeart, IconInfoCircle, IconPalette, IconShieldLock, IconSignature, IconTrash, IconUserCircle, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import logo from "../../src-tauri/icons/128x128.png";
import { backend, errorText } from "../backend";
import type { AppInfo } from "../backend";
import { RichText, editorHtml } from "../components/RichText";
import { Button, Chip, IconButton, categories, fieldBox, fieldCaption } from "../components/ui";
import { TEXT_SIZES, fontChoice } from "../lib/font";
import { REPOSITORY, SPONSOR_PAGE, WEBSITE } from "../lib/links";
import { pictureFromFile, signatureHtml } from "../lib/signature";
import { useStore } from "../store";
import type { SettingsPage } from "../store";
import type { Rule, SavedSignature } from "../types";
import { statusText } from "./FolderPane";
import { imageSenders } from "./HtmlBody";

const pages: [SettingsPage, string, typeof IconBell][] = [
  ["accounts", "Accounts", IconUserCircle],
  ["signatures", "Signatures", IconSignature],
  ["sync", "Sync and storage", IconCloudDownload],
  ["appearance", "Appearance", IconPalette],
  ["privacy", "Privacy", IconShieldLock],
  ["rules", "Rules", IconFilter],
  ["notifications", "Notifications", IconBell],
  ["about", "About", IconInfoCircle],
  ["sponsor", "Sponsor", IconHeart],
];

function Problem({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="selectable mt-3 rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-danger" role="alert">
      {text}
    </p>
  );
}

function Options<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="mb-4">
      <div className={fieldCaption}>{label}</div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <Chip key={v} on={value === v} onClick={() => onChange(v)}>
            {text}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Accounts() {
  const accounts = useStore((s) => s.accounts);
  const progress = useStore((s) => s.progress);
  const settings = useStore((s) => s.settings);
  const { setSetting, setDialog, refresh } = useStore.getState();
  const [confirm, setConfirm] = useState<number | null>(null);
  const [error, setError] = useState("");

  // A large mailbox takes a while to delete: say so instead of looking stuck.
  const [removing, setRemoving] = useState<number | null>(null);

  async function remove(id: number) {
    setError("");
    setRemoving(id);
    try {
      await backend.removeAccount(id);
      setConfirm(null);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRemoving(null);
    }
  }

  // Reordering: drag a row by its handle, or focus the handle and press the up or down arrow.
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  async function move(id: number, to: number) {
    const from = accounts.findIndex((a) => a.id === id);
    if (from < 0 || to < 0 || to >= accounts.length || to === from) return;
    const next = [...accounts];
    next.splice(to, 0, ...next.splice(from, 1));
    useStore.setState({ accounts: next }); // show it at once; the engine follows
    setError("");
    try {
      await backend.reorderAccounts(next.map((a) => a.id));
    } catch (e) {
      setError(errorText(e));
    }
    await refresh();
  }

  return (
    <>
      {accounts.map((a, index) => (
        <div
          key={a.id}
          className={`mb-2 flex items-center gap-2 rounded-[10px] border py-2 pr-3 pl-1.5 ${over === a.id && dragged !== a.id ? "border-brand bg-soft" : "border-edge"} ${dragged === a.id ? "opacity-50" : ""}`}
          onDragOver={(e) => {
            if (dragged === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOver(a.id);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragged !== null) void move(dragged, index);
            setDragged(null);
            setOver(null);
          }}
        >
          {accounts.length > 1 && (
            <button
              type="button"
              draggable
              aria-label={`Move ${a.address}. Drag it, or press the up or down arrow.`}
              title="Drag to reorder"
              className="flex-none cursor-grab rounded-md p-1.5 text-ink3 hover:bg-hover hover:text-ink active:cursor-grabbing"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", a.address);
                setDragged(a.id);
              }}
              onDragEnd={() => {
                setDragged(null);
                setOver(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                e.preventDefault();
                void move(a.id, index + (e.key === "ArrowUp" ? -1 : 1));
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <circle cx="4" cy="4" r="1.6" />
                <circle cx="10" cy="4" r="1.6" />
                <circle cx="4" cy="10" r="1.6" />
                <circle cx="10" cy="10" r="1.6" />
              </svg>
            </button>
          )}
          <div className={`min-w-0 flex-1 ${accounts.length > 1 ? "" : "pl-1.5"}`}>
            <div className="selectable truncate">{a.address}</div>
            <div className="truncate text-xs text-ink2">
              {a.kind === "gmail" ? "Google" : "IMAP"}
              {progress[a.id] && ` · ${statusText(progress[a.id])}`}
            </div>
            <div className="truncate text-xs text-ink2" title="Senders are confirmed only by this server's checks. It is learned from nearly all of the account's mail, or known for Gmail.">
              {a.authServer ? `Sender checks by ${a.authServer}` : "Sender checks: still learning which server makes them"}
            </div>
          </div>
          {removing === a.id ? (
            <span className="text-[13px] text-ink2" role="status">
              Removing…
            </span>
          ) : confirm === a.id ? (
            <>
              <span className="text-[13px] text-ink2">Remove from this computer?</span>
              <Button className="h-8 text-danger" onClick={() => void remove(a.id)}>
                Remove
              </Button>
              <Button className="h-8" onClick={() => setConfirm(null)}>
                Keep
              </Button>
            </>
          ) : (
            <IconButton label={`Remove ${a.address}`} onClick={() => setConfirm(a.id)}>
              <IconTrash size={18} />
            </IconButton>
          )}
        </div>
      ))}
      {accounts.length === 0 && <p className="mb-2 text-ink2">No accounts yet.</p>}
      <Button variant="primary" onClick={() => setDialog("add-account")}>
        Add account
      </Button>
      <p className="mt-2 text-xs text-ink3">
        {accounts.length > 1 && `Drag an account by its dots to change the order here and in the folder list. In "All inboxes", new mail is written from the first account. `}
        Removing an account deletes its local copy and saved password. Nothing changes on the mail server.
      </p>
      <Problem text={error} />

      <h3 className="mt-6 mb-1 font-semibold">Google sign-in</h3>
      <p className="mb-2 text-[13px] text-ink2">
        Gmail needs a Google OAuth client of type "Desktop app" from your own Google Cloud project, with the Gmail API enabled. Paste its ID and secret here.
      </p>
      <label className={fieldCaption} htmlFor="g-id">
        Client ID
      </label>
      <input id="g-id" className={fieldBox} value={settings.google_client_id ?? ""} placeholder="1234567890-abc.apps.googleusercontent.com" autoComplete="off" onChange={(e) => void setSetting("google_client_id", e.target.value)} />
      <label className={`${fieldCaption} mt-3`} htmlFor="g-secret">
        Client secret
      </label>
      <input id="g-secret" type="password" className={fieldBox} value={settings.google_client_secret ?? ""} autoComplete="off" onChange={(e) => void setSetting("google_client_secret", e.target.value)} />
    </>
  );
}

/** HTML without the differences that saving and the editor add themselves, for comparing. */
function shape(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const a of doc.querySelectorAll("a")) for (const name of ["rel", "target", "class"]) a.removeAttribute(name);
  return doc.body.innerHTML;
}

function Signatures() {
  const signatures = useStore((s) => s.signatures);
  const defaults = useStore((s) => s.signatureDefaults);
  const accounts = useStore((s) => s.accounts);
  const loadPreferences = useStore((s) => s.loadPreferences);
  const [editing, setEditing] = useState<SavedSignature | null>(signatures[0] ?? null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const defaultsOf = (accountId: number) => defaults.find((d) => d.accountId === accountId) ?? { accountId, newId: null, replyId: null };
  const nameOf = (id: number | null) => signatures.find((s) => s.id === id)?.name ?? null;

  // ----- saving, automatically -----
  /** The signature as last edited, and whether that is saved yet. */
  const latest = useRef(editing);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Writes run one after another. */
  const writing = useRef(Promise.resolve());
  const run = (work: () => Promise<void>) => {
    writing.current = writing.current.then(work).then(
      () => (setError(""), setSaved(true)),
      (e) => setError(errorText(e)),
    );
    return writing.current;
  };
  /** Save now, if anything changed. Uses only refs, so it also works while Settings closes. */
  const flush = useRef(() => {
    clearTimeout(timer.current);
    const signature = latest.current;
    if (!dirty.current || !signature) return;
    dirty.current = false;
    void run(async () => {
      await backend.saveSignature(signature);
      await loadPreferences();
    });
  }).current;
  useEffect(() => flush, [flush]);

  /** Change the signature being edited; it is saved shortly after the last change. */
  const change = (part: Partial<SavedSignature>) => {
    if (!latest.current) return;
    latest.current = { ...latest.current, ...part };
    setEditing(latest.current);
    dirty.current = true;
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };
  const edit = (signature: SavedSignature | null) => {
    flush();
    latest.current = signature;
    setEditing(signature);
    setSaved(false);
  };

  /** Use the signature for an account's new mail or replies, or stop using it there. */
  const setUse = (accountId: number, which: "newId" | "replyId", on: boolean) => {
    const id = editing?.id;
    if (!id) return;
    void run(async () => {
      const now = useStore.getState().signatureDefaults.find((d) => d.accountId === accountId) ?? { accountId, newId: null, replyId: null };
      await backend.setSignatureDefaults({ ...now, [which]: on ? id : null });
      await loadPreferences();
    });
  };

  /** Switch between the editor and the signature's HTML source. */
  const setRawHtml = (rawHtml: boolean) => {
    const now = latest.current;
    if (!now) return;
    if (rawHtml) return change({ rawHtml });
    // The editor holds simple formatting only; say so before anything else is dropped.
    const kept = editorHtml(now.html);
    if (shape(kept) !== shape(now.html) && !window.confirm("The editor keeps only simple formatting: bold, italic, lists and links. Everything else in your HTML, such as tables, colours and pictures, will be removed.")) return;
    change({ rawHtml, html: kept });
  };
  /** The HTML as saved: what will be sent, after scripts and the like were removed. */
  const storedHtml = signatures.find((s) => s.id === editing?.id)?.html ?? "";

  /** A new signature exists from the start, so every later change is simply saved. */
  const add = () => {
    flush();
    void run(async () => {
      const fresh: SavedSignature = { id: 0, name: "New signature", html: "", layout: "text", image: "", rawHtml: false };
      const id = await backend.saveSignature(fresh);
      await loadPreferences();
      latest.current = { ...fresh, id };
      setEditing(latest.current);
    });
  };

  async function remove() {
    if (!editing) return;
    clearTimeout(timer.current);
    dirty.current = false;
    await run(async () => {
      await backend.deleteSignature(editing.id);
      await loadPreferences();
    });
    edit(useStore.getState().signatures[0] ?? null);
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {signatures.map((s) => (
          <Chip key={s.id} on={editing?.id === s.id} onClick={() => edit(s)}>
            {s.name}
          </Chip>
        ))}
        <Button variant="ghost" className="h-7 text-brand" onClick={add}>
          New signature
        </Button>
      </div>
      {editing && (
        <>
          <label className={fieldCaption} htmlFor="sig-name">
            Name
          </label>
          <input id="sig-name" className={fieldBox} value={editing.name} placeholder="Work" onChange={(e) => change({ name: e.target.value })} />
          <div className="mt-3 flex items-end justify-between">
            <div className={fieldCaption}>Signature</div>
            <Button variant="ghost" className={`mb-1 h-7 ${editing.rawHtml ? "text-brand" : "text-ink2"}`} aria-pressed={editing.rawHtml} onClick={() => setRawHtml(!editing.rawHtml)}>
              <IconCode size={16} /> {editing.rawHtml ? "Back to the editor" : "Edit as HTML"}
            </Button>
          </div>
          {editing.rawHtml ? (
            <>
              <textarea
                key={editing.id}
                aria-label="Signature HTML"
                className="selectable block h-44 w-full resize-y rounded-[10px] border border-edge bg-transparent p-2 font-mono text-[12.5px] leading-relaxed outline-none focus:border-brand"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={'<table>\n  <tr><td style="color:#555">Kind regards,<br><b>Your name</b></td></tr>\n</table>'}
                value={editing.html}
                onChange={(e) => change({ html: e.target.value })}
              />
              <p className="mt-1.5 text-xs text-ink3">Use inline styles, as mail programs expect. Scripts, forms and style sheets are removed when the signature is saved.</p>
            </>
          ) : (
            <div className="rounded-[10px] border border-edge p-2">
              <RichText key={editing.id} label="Signature" className="h-36" initial={editing.html} onChange={(html) => html !== latest.current?.html && change({ html })} />
            </div>
          )}
          <div className={`${fieldCaption} mt-3`}>Picture</div>
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Signature layout">
            {(
              [
                ["text", "No picture"],
                ["left", "Left of the text"],
                ["above", "Above the text"],
                ["below", "Below the text"],
              ] as const
            ).map(([layout, name]) => (
              <Chip key={layout} on={editing.layout === layout} onClick={() => change({ layout })}>
                {name}
              </Chip>
            ))}
            {editing.layout !== "text" && (
              <>
                <label className="ml-2 inline-flex h-7 cursor-pointer items-center rounded-full border border-edge px-3 text-[13px] hover:bg-hover">
                  {editing.image ? "Change image" : "Choose image"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      pictureFromFile(file)
                        .then((image) => change({ image }))
                        .catch(() => setError("That file could not be read as a picture."));
                    }}
                  />
                </label>
                {editing.image && (
                  <Button variant="ghost" className="h-7 text-ink2" onClick={() => change({ image: "" })}>
                    Remove image
                  </Button>
                )}
              </>
            )}
          </div>
          {(editing.layout !== "text" || editing.rawHtml) && (
            <>
              <div className={`${fieldCaption} mt-3`}>Preview</div>
              {editing.image || editing.layout === "text" ? (
                // Hand-written HTML is shown as saved, so the preview is what people receive.
                <div className="rich selectable overflow-x-auto rounded-[10px] border border-dashed border-edge p-3" dangerouslySetInnerHTML={{ __html: signatureHtml(editing.rawHtml ? { ...editing, html: storedHtml } : editing) }} />
              ) : (
                <p className="text-[13px] text-ink2">Choose a picture, such as a logo or a photo. It is made small and sent inside each message, so people see it without having to load images.</p>
              )}
            </>
          )}
          <div className={`${fieldCaption} mt-4`}>Add it automatically to</div>
          {accounts.length === 0 ? (
            <p className="text-[13px] text-ink3">Add an account first.</p>
          ) : (
            <div className="divide-y divide-edge rounded-[10px] border border-edge">
              {accounts.map((a) => {
                const now = defaultsOf(a.id);
                const use = { fresh: now.newId === editing.id, reply: now.replyId === editing.id };
                // Another signature that this account keeps using where a box is not ticked.
                const other = [!use.fresh && now.newId !== editing.id && nameOf(now.newId), !use.reply && now.replyId !== editing.id && nameOf(now.replyId)].filter(Boolean);
                return (
                  <div key={a.id} className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2" role="group" aria-label={a.address}>
                    <div className="min-w-40 flex-1">
                      <div className="truncate">{a.address}</div>
                      {other.length > 0 && <div className="text-xs text-ink3">Uses “{[...new Set(other)].join("” and “")}” otherwise</div>}
                    </div>
                    <label className="flex items-center gap-1.5 text-[13px]">
                      <input type="checkbox" className="size-4 accent-brand" checked={use.fresh} onChange={(e) => setUse(a.id, "newId", e.target.checked)} />
                      New mail
                    </label>
                    <label className="flex items-center gap-1.5 text-[13px]">
                      <input type="checkbox" className="size-4 accent-brand" checked={use.reply} onChange={(e) => setUse(a.id, "replyId", e.target.checked)} />
                      Replies and forwards
                    </label>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-1.5 text-xs text-ink3">While writing a message you can still pick another signature, or none.</p>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[13px] text-ink3" role="status">
              {saved ? "Saved" : "Changes are saved as you make them."}
            </span>
            <Button variant="ghost" className="ml-auto text-danger" onClick={() => void remove()}>
              <IconTrash size={16} /> Delete signature
            </Button>
          </div>
          <Problem text={error} />
        </>
      )}

    </>
  );
}

function Sync() {
  const settings = useStore((s) => s.settings);
  const accounts = useStore((s) => s.accounts);
  const progress = useStore((s) => s.progress);
  const setSetting = useStore((s) => s.setSetting);
  return (
    <>
      <Options
        label="Keep message text on this computer"
        value={settings.body_days ?? "0"}
        onChange={(v) => void setSetting("body_days", v)}
        options={[
          ["0", "All mail"],
          ["730", "Last 2 years"],
          ["365", "Last year"],
          ["90", "Last 3 months"],
        ]}
      />
      <p className="mb-4 text-[13px] text-ink2">
        Sender, subject and date are always kept for all mail, so older messages stay searchable by those. Text of older messages is fetched when you open them or use "Search the server for more". Applies from the next sync; text already downloaded is kept.
      </p>
      <div className={fieldCaption}>Sync status</div>
      {accounts.map((a) => (
        <div key={a.id} className="mb-2 rounded-[10px] border border-edge px-3 py-2">
          <div className="truncate">{a.address}</div>
          <div className={`truncate text-xs ${progress[a.id]?.phase === "error" ? "text-danger" : "text-ink2"}`}>{statusText(progress[a.id]) || "Waiting…"}</div>
        </div>
      ))}
      <Button onClick={() => void backend.syncNow()}>Sync now</Button>
    </>
  );
}

function Appearance() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const systemFont = useStore((s) => s.systemFont.family);
  return (
    <>
      <Options
        label="Font"
        value={fontChoice(settings.font)}
        onChange={(v) => void setSetting("font", v)}
        options={[
          ["inter", "Inter"],
          ["nunito", "Nunito (rounded)"],
          ["system", systemFont ? `This computer's font (${systemFont})` : "This computer's font"],
        ]}
      />
      <Options label="Text size" value={settings.text_size ?? "15"} onChange={(v) => void setSetting("text_size", v)} options={TEXT_SIZES} />
      <Options
        label="Time format"
        value={settings.time_format === "12" ? "12" : "24"}
        onChange={(v) => void setSetting("time_format", v)}
        options={[
          ["24", "24-hour (15:05)"],
          ["12", "AM / PM (3:05 PM)"],
        ]}
      />
      <Options
        label="Theme"
        value={settings.theme ?? "system"}
        onChange={(v) => void setSetting("theme", v)}
        options={[
          ["system", "Match system"],
          ["light", "Light"],
          ["dark", "Dark"],
        ]}
      />
      <Options
        label="Focused inbox"
        value={settings.focused_inbox === "off" ? "off" : "on"}
        onChange={(v) => void setSetting("focused_inbox", v)}
        options={[
          ["on", "Split into Focused and Other"],
          ["off", "One list"],
        ]}
      />
      <Options
        label="Message list density"
        value={settings.density ?? "cozy"}
        onChange={(v) => void setSetting("density", v)}
        options={[
          ["roomy", "Roomy"],
          ["cozy", "Cozy"],
          ["compact", "Compact"],
        ]}
      />
      <Options
        label="Undo send"
        value={settings.undo_seconds ?? "10"}
        onChange={(v) => void setSetting("undo_seconds", v)}
        options={[
          ["0", "Off"],
          ["5", "5 seconds"],
          ["10", "10 seconds"],
          ["30", "30 seconds"],
        ]}
      />
    </>
  );
}

function Privacy() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const onOff: ["on" | "off", string][] = [
    ["on", "On"],
    ["off", "Off"],
  ];
  const note = "mb-4 -mt-2 text-[13px] text-ink2";
  // Same format as the image list: a JSON list of text entries.
  const blockedList = imageSenders(settings.blocked_senders);
  const imageList = imageSenders(settings.image_senders);
  return (
    <>
      <Options label="Remove trackers from mail" value={settings.block_trackers === "off" ? "off" : "on"} onChange={(v) => void setSetting("block_trackers", v)} options={onOff} />
      <p className={note}>Hidden images that report when you open a message are removed, and tracking codes are taken out of links. The message says how many were found.</p>
      <Options label="Warn about suspicious mail" value={settings.phishing_warnings === "off" ? "off" : "on"} onChange={(v) => void setSetting("phishing_warnings", v)} options={onOff} />
      <p className={note}>A warning appears when your mail server could not confirm the sender, when the sender's name claims to be a company the address does not belong to, when a link shows one site but leads to another, or when an address imitates ordinary letters with look-alike ones from another alphabet.</p>
      <Options label="Company logos for well-known senders" value={settings.brand_logos === "off" ? "off" : "on"} onChange={(v) => void setSetting("brand_logos", v)} options={onOff} />
      <p className={note}>The logos are part of OpenWren, so nothing is looked up online. A logo appears only when the address belongs to that company and your mail server confirmed the sender; while OpenWren is still learning which server that is, or if yours does no such checks, senders keep their initials.</p>
      <Options label="Look for new versions" value={settings.update_check === "off" ? "off" : "on"} onChange={(v) => void setSetting("update_check", v)} options={onOff} />
      <p className={note}>A few times a day OpenWren downloads one small public file that says which version is the newest, and tells you when yours is older. The request carries nothing about you or this computer.</p>
      <Options label="Anonymous usage count" value={settings.usage_stats === "on" ? "on" : "off"} onChange={(v) => void setSetting("usage_stats", v)} options={onOff} />
      <p className={note}>Once a day OpenWren tells the project that one more copy is in use. Knowing that people rely on it is what motivates the maintainer to keep the code maintained in the long term. It is sent only if you switch it on. The request carries no name, address, mail or identifier, and the server keeps only totals.</p>
      <div className="mb-1 font-semibold">Blocked senders</div>
      <p className="mb-2 text-[13px] text-ink2">
        Mail from these senders goes straight to Junk, without a notification. To block someone, right-click one of their messages and choose "Block sender". OpenWren does the moving, so it happens while OpenWren is running.
      </p>
      {blockedList.length === 0 ? (
        <p className="mb-4 text-[13px] text-ink3">Nobody is blocked.</p>
      ) : (
        <div className="mb-4 rounded-[10px] border border-edge">
          {blockedList.map((entry) => (
            <div key={entry} className="flex items-center gap-2 border-b border-edge px-3 py-1.5 last:border-b-0">
              <span className="selectable min-w-0 flex-1 truncate">{entry.startsWith("@") ? `Everyone at ${entry.slice(1)}` : entry}</span>
              <Button className="h-7" onClick={() => void setSetting("blocked_senders", JSON.stringify(blockedList.filter((e) => e !== entry)))}>
                Unblock
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="mb-1 font-semibold">Senders whose images are always shown</div>
      <p className="mb-2 text-[13px] text-ink2">Pictures from the internet load without asking for these senders. Add one with "Always from this sender" above a message.</p>
      {imageList.length === 0 ? (
        <p className="mb-4 text-[13px] text-ink3">No senders yet.</p>
      ) : (
        <div className="mb-4 rounded-[10px] border border-edge">
          {imageList.map((address) => (
            <div key={address} className="flex items-center gap-2 border-b border-edge px-3 py-1.5 last:border-b-0">
              <span className="selectable min-w-0 flex-1 truncate">{address}</span>
              <Button className="h-7" onClick={() => void setSetting("image_senders", JSON.stringify(imageList.filter((a) => a !== address)))}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="text-[13px] text-ink2">Always on: the mail database is encrypted, passwords stay in the system's password store, and pictures from the internet are loaded only when you ask.</p>
    </>
  );
}

const blank: Rule = { id: 0, name: "", enabled: true, fromContains: "", subjectContains: "", action: "move", target: "Archive" };
const actionNames: [Rule["action"], string][] = [
  ["move", "Move to folder"],
  ["category", "Set category"],
  ["flag", "Flag"],
  ["read", "Mark as read"],
  ["delete", "Delete"],
];

function Rules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [error, setError] = useState("");
  const reload = () => backend.listRules().then(setRules);
  useEffect(() => void reload(), []);

  async function save() {
    if (!editing) return;
    try {
      await backend.saveRule(editing);
      setEditing(null);
      setError("");
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const describe = (r: Rule) =>
    [r.fromContains && `from "${r.fromContains}"`, r.subjectContains && `subject "${r.subjectContains}"`].filter(Boolean).join(" and ") +
    " → " +
    (actionNames.find((a) => a[0] === r.action)?.[1] ?? r.action) +
    (r.action === "move" || r.action === "category" ? `: ${r.target}` : "");

  return (
    <>
      <p className="mb-3 text-[13px] text-ink2">Rules run on new mail arriving in the inbox while OpenWren is open. The first rule that matches is applied.</p>
      {rules.map((r) => (
        <div key={r.id} className="mb-2 flex items-center gap-3 rounded-[10px] border border-edge px-3 py-2">
          <input type="checkbox" aria-label={`Enable ${r.name}`} checked={r.enabled} onChange={(e) => void backend.saveRule({ ...r, enabled: e.target.checked }).then(reload)} />
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(r)}>
            <div className="truncate">{r.name}</div>
            <div className="truncate text-xs text-ink2">{describe(r)}</div>
          </button>
          <IconButton label={`Delete ${r.name}`} onClick={() => void backend.deleteRule(r.id).then(reload)}>
            <IconTrash size={18} />
          </IconButton>
        </div>
      ))}
      {!editing && (
        <Button variant="primary" onClick={() => setEditing(blank)}>
          New rule
        </Button>
      )}
      {editing && (
        <div className="mt-3 rounded-[10px] border border-edge p-3">
          <label className={fieldCaption} htmlFor="rule-name">
            Name
          </label>
          <input id="rule-name" className={fieldBox} value={editing.name} placeholder="Newsletters to Archive" onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className={fieldCaption} htmlFor="rule-from">
                Sender contains
              </label>
              <input id="rule-from" className={fieldBox} value={editing.fromContains} placeholder="newsletter@" onChange={(e) => setEditing({ ...editing, fromContains: e.target.value })} />
            </div>
            <div>
              <label className={fieldCaption} htmlFor="rule-subject">
                Subject contains
              </label>
              <input id="rule-subject" className={fieldBox} value={editing.subjectContains} onChange={(e) => setEditing({ ...editing, subjectContains: e.target.value })} />
            </div>
            <div>
              <label className={fieldCaption} htmlFor="rule-action">
                Then
              </label>
              <select
                id="rule-action"
                className={fieldBox}
                value={editing.action}
                onChange={(e) => {
                  const action = e.target.value as Rule["action"];
                  setEditing({ ...editing, action, target: action === "category" ? "Blue" : action === "move" ? "Archive" : "" });
                }}
              >
                {actionNames.map(([v, text]) => (
                  <option key={v} value={v}>
                    {text}
                  </option>
                ))}
              </select>
            </div>
            {editing.action === "move" && (
              <div>
                <label className={fieldCaption} htmlFor="rule-target">
                  Folder name
                </label>
                <input id="rule-target" className={fieldBox} value={editing.target} onChange={(e) => setEditing({ ...editing, target: e.target.value })} />
              </div>
            )}
            {editing.action === "category" && (
              <div>
                <label className={fieldCaption} htmlFor="rule-category">
                  Category
                </label>
                <select id="rule-category" className={fieldBox} value={editing.target} onChange={(e) => setEditing({ ...editing, target: e.target.value })}>
                  {Object.keys(categories).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => void save()}>
              Save rule
            </Button>
            <Button onClick={() => (setEditing(null), setError(""))}>Cancel</Button>
          </div>
          <Problem text={error} />
        </div>
      )}
    </>
  );
}

function Notifications() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  return (
    <>
      <Options
        label="Desktop notification when new mail arrives in Focused"
        value={settings.notifications ?? "on"}
        onChange={(v) => void setSetting("notifications", v)}
        options={[
          ["on", "On"],
          ["off", "Off"],
        ]}
      />
      <Options
        label="When the window is closed"
        value={settings.close_to_tray === "off" ? "off" : "on"}
        onChange={(v) => void setSetting("close_to_tray", v)}
        options={[
          ["on", "Keep running in the tray"],
          ["off", "Quit OpenWren"],
        ]}
      />
      <Options
        label="When you log in to this computer"
        value={settings.start_at_login === "off" ? "off" : "on"}
        onChange={(v) => void setSetting("start_at_login", v)}
        options={[
          ["on", "Start OpenWren in the tray"],
          ["off", "Do not start OpenWren"],
        ]}
      />
      <p className="text-[13px] text-ink2">Notifications appear only while OpenWren is running. In the tray it keeps checking for mail; use the tray icon to open it again or to quit.</p>
    </>
  );
}

const builtWith: [string, string][] = [
  ["Tauri", "https://tauri.app"],
  ["Rust", "https://www.rust-lang.org"],
  ["React", "https://react.dev"],
  ["SQLCipher", "https://www.zetetic.net/sqlcipher/"],
  ["TipTap", "https://tiptap.dev"],
  ["Tabler Icons", "https://tabler.io/icons"],
  ["Inter", "https://rsms.me/inter/"],
];

/** The command that installs a new version on systems where apt or dnf does it. */
const SYSTEM_UPDATE: Record<string, string> = {
  deb: "sudo apt update && sudo apt install --only-upgrade openwren",
  rpm: "sudo dnf upgrade openwren",
};

/** Whether a newer version exists, and the way to get it for this kind of installation. */
function Updates({ version }: { version: string }) {
  const update = useStore((s) => s.update);
  const [state, setState] = useState<"idle" | "checking" | "current" | "installing">("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function check() {
    setState("checking");
    setError("");
    try {
      const found = await backend.checkUpdate();
      useStore.setState({ update: found });
      setState(found ? "idle" : "current");
    } catch (e) {
      setError(errorText(e));
      setState("idle");
    }
  }
  async function install() {
    setState("installing");
    setError("");
    try {
      await backend.installUpdate(); // OpenWren restarts when this succeeds
    } catch (e) {
      setError(errorText(e));
      setState("idle");
    }
  }

  if (!update) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[10px] border border-edge px-3 py-2.5">
        <span className="text-ink2">{state === "current" ? `Version ${version} is the newest.` : state === "checking" ? "Checking…" : "OpenWren looks for a new version a few times a day."}</span>
        <Button className="ml-auto h-7" onClick={() => void check()}>
          Check now
        </Button>
        <Problem text={error} />
      </div>
    );
  }
  const command = SYSTEM_UPDATE[update.package];
  return (
    <div className="mt-4 rounded-[10px] border border-brand/40 bg-brand/5 px-3 py-2.5" role="status">
      <div className="font-semibold">Version {update.version} is available</div>
      {update.notes && <p className="mt-0.5 text-[13px] text-ink2">{update.notes}</p>}
      {update.how === "install" && (
        <div className="mt-2 flex items-center gap-3">
          <Button variant="primary" onClick={() => void install()}>
            {state === "installing" ? "Installing…" : "Install and restart"}
          </Button>
          <span className="text-[13px] text-ink2">The update is checked against OpenWren's signing key before it is installed.</span>
        </div>
      )}
      {update.how === "system" && command && (
        <>
          <p className="mt-1 text-[13px] text-ink2">Your system installs it with its normal updates, or right now with:</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="selectable min-w-0 flex-1 overflow-x-auto rounded-md bg-canvas px-2 py-1.5 font-mono text-xs whitespace-nowrap">{command}</code>
            <Button
              className="h-7 flex-none"
              onClick={() => {
                void navigator.clipboard.writeText(command).then(() => setCopied(true));
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-ink3">Then quit OpenWren from the tray and start it again.</p>
        </>
      )}
      {(update.how === "download" || (update.how === "system" && !command)) && (
        <Button className="mt-2" onClick={() => void backend.openLink(`${WEBSITE}/download/`)}>
          Open the download page
        </Button>
      )}
      <Problem text={error} />
      {error && update.how === "install" && (
        <Button className="mt-2" onClick={() => void backend.openLink(`${WEBSITE}/download/`)}>
          Open the download page
        </Button>
      )}
    </div>
  );
}

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    backend
      .appInfo()
      .then(setInfo)
      .catch((e) => console.error("app_info failed", e));
  }, []);
  const row = "flex gap-3 border-b border-edge py-2";
  const name = "w-36 flex-none text-ink2";
  return (
    <>
      <div className="flex items-center gap-4">
        <img src={logo} alt="" className="size-16" />
        <div>
          <div className="text-lg font-semibold">OpenWren</div>
          <div className="text-ink2">{info ? `Version ${info.version}` : "Browser preview on sample mail"}</div>
        </div>
      </div>
      <p className="mt-4">An open-source mail client. Your mail is kept on this computer, encrypted, and in sync with your mail server.</p>
      <Updates version={info?.version ?? ""} />
      <div className="mt-4 text-[13px]">
        <div className={row}>
          <span className={name}>Licence</span>
          <span>
            Apache License, version 2.0. OpenWren is free and open source: you may use, study, share and change it. It comes with no warranty.{" "}
            <button type="button" className="text-brand underline" onClick={() => void backend.openLink("https://www.apache.org/licenses/LICENSE-2.0")}>
              Read the licence
            </button>
            {" · "}
            <button type="button" className="text-brand underline" onClick={() => void backend.openLink(REPOSITORY)}>
              View the code
            </button>
          </span>
        </div>
        {info && (
          <>
            <div className={row}>
              <span className={name}>Mail database</span>
              <span className="selectable break-all">{info.dataDir}/openwren.db</span>
            </div>
            <div className={row}>
              <span className={name}>Encryption</span>
              <span>{info.cipher ? `Encrypted with SQLCipher ${info.cipher.split(" ")[0]}. The key is in your system's password store.` : "Not encrypted"}</span>
            </div>
            <div className={row}>
              <span className={name}>Database version</span>
              <span>{info.schemaVersion}</span>
            </div>
          </>
        )}
        <div className={row}>
          <span className={name}>Built with</span>
          <span>
            {builtWith.map(([label, url], i) => (
              <span key={label}>
                {i > 0 && ", "}
                <button type="button" className="text-brand underline" onClick={() => void backend.openLink(url)}>
                  {label}
                </button>
              </span>
            ))}
          </span>
        </div>
      </div>
      <Button className="mt-4" onClick={() => useStore.getState().setWelcome(true)}>
        Show the welcome screens again
      </Button>
    </>
  );
}

/** Why the project asks for sponsors, and the way to become one. */
function Sponsor() {
  return (
    <div className="flex items-start gap-3.5">
      <div className="flex size-10 flex-none items-center justify-center rounded-full bg-danger/10 text-danger">
        <IconHeart size={20} />
      </div>
      <div className="min-w-0">
        <div className="font-semibold">OpenWren is free. Sponsors keep it that way.</div>
        <p className="mt-1 text-[13px] text-ink2">
          No ads and no data to sell. If OpenWren is your daily mail app, a few dollars a month pays for the time to fix bugs, answer security reports and keep up with mail providers, and for signed installers on Windows and macOS.
        </p>
        <Button className="mt-3" onClick={() => void backend.openLink(SPONSOR_PAGE)}>
          <IconHeart size={16} className="text-danger" /> Sponsor on GitHub
        </Button>
        <p className="mt-4 text-[13px] text-ink2">
          Not able to sponsor? A star on{" "}
          <button type="button" className="text-brand underline" onClick={() => void backend.openLink(REPOSITORY)}>
            GitHub
          </button>{" "}
          helps others find OpenWren, and costs nothing.
        </p>
      </div>
    </div>
  );
}

const content: Record<SettingsPage, () => React.ReactNode> = {
  accounts: Accounts,
  signatures: Signatures,
  sync: Sync,
  appearance: Appearance,
  privacy: Privacy,
  rules: Rules,
  notifications: Notifications,
  about: About,
  sponsor: Sponsor,
};

export function Settings() {
  const page = useStore((s) => s.settingsPage);
  const setDialog = useStore((s) => s.setDialog);
  const close = () => setDialog(null);
  const Page = content[page];
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex h-[560px] max-h-full w-[820px] max-w-full overflow-hidden rounded-[14px] border border-edge bg-card shadow-xl"
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <nav className="w-[210px] flex-none bg-canvas px-2 py-4" aria-label="Settings sections">
          <div className="px-2 pb-3 text-lg font-semibold">Settings</div>
          {pages.map(([id, name, Icon]) => (
            <button
              key={id}
              type="button"
              aria-current={page === id}
              onClick={() => setDialog("settings", id)}
              className={`flex w-full items-center gap-2 rounded-full px-3 py-1.5 text-left ${page === id ? "bg-sel" : "hover:bg-hover"}`}
            >
              <Icon size={18} className={id === "sponsor" ? "text-danger" : "text-ink2"} />
              <span className={id === "sponsor" ? "text-danger" : undefined}>{name}</span>
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="mb-3 flex items-center">
            <h2 className="text-base font-semibold">{pages.find((p) => p[0] === page)?.[1]}</h2>
            <IconButton label="Close settings" className="ml-auto" onClick={close}>
              <IconX size={20} />
            </IconButton>
          </div>
          <Page />
        </div>
      </div>
    </div>
  );
}
