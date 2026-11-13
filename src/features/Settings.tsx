import { IconBell, IconCloudDownload, IconFilter, IconInfoCircle, IconPalette, IconShieldLock, IconSignature, IconTrash, IconUserCircle, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import logo from "../../src-tauri/icons/128x128.png";
import { backend, errorText } from "../backend";
import type { AppInfo, StatsPreview } from "../backend";
import { RichText } from "../components/RichText";
import { Button, Chip, IconButton, categories, fieldBox, fieldCaption } from "../components/ui";
import { TEXT_SIZES, fontChoice } from "../lib/font";
import { REPOSITORY } from "../lib/links";
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

  async function remove(id: number) {
    try {
      await backend.removeAccount(id);
      setConfirm(null);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <>
      {accounts.map((a) => (
        <div key={a.id} className="mb-2 flex items-center gap-3 rounded-[10px] border border-edge px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="selectable truncate">{a.address}</div>
            <div className="truncate text-xs text-ink2">
              {a.kind === "gmail" ? "Google" : "IMAP"}
              {progress[a.id] && ` · ${statusText(progress[a.id])}`}
            </div>
          </div>
          {confirm === a.id ? (
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
      <p className="mt-2 text-xs text-ink3">Removing an account deletes its local copy and saved password. Nothing changes on the mail server.</p>
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

function Signatures() {
  const signatures = useStore((s) => s.signatures);
  const defaults = useStore((s) => s.signatureDefaults);
  const accounts = useStore((s) => s.accounts);
  const loadPreferences = useStore((s) => s.loadPreferences);
  const [editing, setEditing] = useState<SavedSignature | null>(signatures[0] ?? null);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? 0);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const current = defaults.find((d) => d.accountId === accountId) ?? { accountId, newId: null, replyId: null };

  async function save() {
    if (!editing) return;
    try {
      const id = await backend.saveSignature(editing);
      await loadPreferences();
      setEditing({ ...editing, id });
      setError("");
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function remove() {
    if (!editing) return;
    if (editing.id !== 0) await backend.deleteSignature(editing.id);
    await loadPreferences();
    setEditing(useStore.getState().signatures[0] ?? null);
  }

  async function setDefault(which: "newId" | "replyId", value: string) {
    await backend.setSignatureDefaults({ ...current, [which]: value ? Number(value) : null });
    await loadPreferences();
  }

  const pick = (
    <option value="">No signature</option>
  );
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {signatures.map((s) => (
          <Chip key={s.id} on={editing?.id === s.id} onClick={() => (setEditing(s), setSaved(false))}>
            {s.name}
          </Chip>
        ))}
        <Button variant="ghost" className="h-7 text-brand" onClick={() => (setEditing({ id: 0, name: "", html: "", layout: "text", image: "" }), setSaved(false))}>
          New signature
        </Button>
      </div>
      {editing && (
        <>
          <label className={fieldCaption} htmlFor="sig-name">
            Name
          </label>
          <input id="sig-name" className={fieldBox} value={editing.name} placeholder="Work" onChange={(e) => (setEditing({ ...editing, name: e.target.value }), setSaved(false))} />
          <div className={`${fieldCaption} mt-3`}>Signature</div>
          <div className="rounded-[10px] border border-edge p-2">
            <RichText key={editing.id} label="Signature" className="h-36" initial={editing.html} onChange={(html) => (setEditing((e) => e && { ...e, html }), setSaved(false))} />
          </div>
          <div className={`${fieldCaption} mt-3`}>Layout</div>
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Signature layout">
            {(
              [
                ["text", "Text only"],
                ["left", "Image left"],
                ["above", "Image above"],
              ] as const
            ).map(([layout, name]) => (
              <Chip key={layout} on={editing.layout === layout} onClick={() => (setEditing({ ...editing, layout }), setSaved(false))}>
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
                        .then((image) => (setEditing((s) => s && { ...s, image }), setSaved(false), setError("")))
                        .catch(() => setError("That file could not be read as a picture."));
                    }}
                  />
                </label>
                {editing.image && (
                  <Button variant="ghost" className="h-7 text-ink2" onClick={() => (setEditing({ ...editing, image: "" }), setSaved(false))}>
                    Remove image
                  </Button>
                )}
              </>
            )}
          </div>
          {editing.layout !== "text" && (
            <>
              <div className={`${fieldCaption} mt-3`}>Preview</div>
              {editing.image ? (
                <div className="rich selectable rounded-[10px] border border-dashed border-edge p-3" dangerouslySetInnerHTML={{ __html: signatureHtml(editing) }} />
              ) : (
                <p className="text-[13px] text-ink2">Choose a picture, such as a logo or a photo. It is made small and sent inside each message, so people see it without having to load images.</p>
              )}
            </>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" onClick={() => void save()}>
              Save
            </Button>
            {saved && <span className="text-[13px] text-ink2">Saved</span>}
            <Button variant="ghost" className="ml-auto text-danger" onClick={() => void remove()}>
              <IconTrash size={16} /> Delete signature
            </Button>
          </div>
          <Problem text={error} />
        </>
      )}

      <h3 className="mt-6 mb-2 font-semibold">Defaults</h3>
      {accounts.length === 0 ? (
        <p className="text-ink2">Add an account to choose its default signatures.</p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={fieldCaption} htmlFor="sig-account">
              Account
            </label>
            <select id="sig-account" className={fieldBox} value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.address}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={fieldCaption} htmlFor="sig-new">
              New messages
            </label>
            <select id="sig-new" className={fieldBox} value={current.newId ?? ""} onChange={(e) => void setDefault("newId", e.target.value)}>
              {pick}
              {signatures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={fieldCaption} htmlFor="sig-reply">
              Replies and forwards
            </label>
            <select id="sig-reply" className={fieldBox} value={current.replyId ?? ""} onChange={(e) => void setDefault("replyId", e.target.value)}>
              {pick}
              {signatures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
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
  const [preview, setPreview] = useState<StatsPreview | null>(null);
  const showPreview = async () => setPreview(preview ? null : await backend.statsPreview().catch(() => null));
  return (
    <>
      <Options label="Remove trackers from mail" value={settings.block_trackers === "off" ? "off" : "on"} onChange={(v) => void setSetting("block_trackers", v)} options={onOff} />
      <p className={note}>Hidden images that report when you open a message are removed, and tracking codes are taken out of links. The message says how many were found.</p>
      <Options label="Warn about suspicious mail" value={settings.phishing_warnings === "off" ? "off" : "on"} onChange={(v) => void setSetting("phishing_warnings", v)} options={onOff} />
      <p className={note}>A warning appears when your mail server could not confirm the sender, when the sender's name claims to be a company the address does not belong to, when a link shows one site but leads to another, or when an address imitates ordinary letters with look-alike ones from another alphabet.</p>
      <Options label="Company logos for well-known senders" value={settings.brand_logos === "off" ? "off" : "on"} onChange={(v) => void setSetting("brand_logos", v)} options={onOff} />
      <p className={note}>The logos are part of OpenWren, so nothing is looked up online. A logo appears only when the address belongs to that company and your mail server confirmed the sender; while OpenWren is still learning which server that is, or if yours does no such checks, senders keep their initials.</p>
      <Options label="Anonymous usage count" value={settings.usage_stats === "off" ? "off" : "on"} onChange={(v) => void setSetting("usage_stats", v)} options={onOff} />
      <p className={note}>
        Once a day OpenWren tells the project that one more copy is in use, so we know how many people rely on it. The request carries no name, address, mail or identifier, and the server keeps only totals.{" "}
        <button type="button" className="text-brand underline" onClick={() => void showPreview()}>
          {preview ? "Hide" : "Show what is sent"}
        </button>
      </p>
      {preview && (
        <pre className="selectable -mt-2 mb-4 overflow-x-auto rounded-[10px] bg-canvas px-3 py-2 font-mono text-xs text-ink">
          {preview.request ? `POST ${preview.endpoint}\n${JSON.stringify(preview.request, null, 2)}` : "Today's request has already been sent. The next one goes out tomorrow."}
          {!preview.active && "\n\n(Nothing is sent from this build: it is a development or preview build, or the count is switched off.)"}
        </pre>
      )}
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
      <p className="text-[13px] text-ink2">Always on: the mail database is encrypted, passwords stay in the system keyring, and pictures from the internet are loaded only when you ask.</p>
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
      <p className="mt-4">An open-source mail client for Linux. Your mail is kept on this computer, encrypted, and in sync with your mail server.</p>
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
              <span>{info.cipher ? `Encrypted with SQLCipher ${info.cipher.split(" ")[0]}. The key is in your system keyring.` : "Not encrypted"}</span>
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

const content: Record<SettingsPage, () => React.ReactNode> = {
  accounts: Accounts,
  signatures: Signatures,
  sync: Sync,
  appearance: Appearance,
  privacy: Privacy,
  rules: Rules,
  notifications: Notifications,
  about: About,
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
              <Icon size={18} className="text-ink2" />
              {name}
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
