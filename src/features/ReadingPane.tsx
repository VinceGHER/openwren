import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconArrowBackUpDouble,
  IconArrowForwardUp,
  IconClock,
  IconDots,
  IconChevronDown,
  IconChevronRight,
  IconDeviceFloppy,
  IconExternalLink,
  IconFileText,
  IconFlag,
  IconFolderShare,
  IconMail,
  IconMailOpened,
  IconPaperclip,
  IconPencil,
  IconPin,
  IconSignature,
  IconTag,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useRef, useState } from "react";
import { backend, errorText } from "../backend";
import { Avatar, Button, CategoryDot, IconButton, Marked, Menu, categories } from "../components/ui";
import type { MenuItem } from "../components/ui";
import { longTime, shortTime } from "../lib/dates";
import { authProblem, cleanMail, nameProblem, senderConfirmed } from "../lib/privacy";
import { fileSize } from "../lib/search";
import { useStore } from "../store";
import { Composer } from "./Composer";
import { HtmlBody } from "./HtmlBody";
import { messageMenu, moveItems, snoozeItems } from "./actions";
import { mod } from "../lib/keys";

const shell = "min-w-0 flex-1 overflow-y-auto bg-card";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <section className={`${shell} flex flex-col items-center justify-center gap-3 px-6 text-center text-ink2`} aria-label="Reading pane">
      {children}
    </section>
  );
}

/** "3 trackers removed", in words that say what was done. */
function trackerNote(pixels: number, links: number): string | undefined {
  const parts = [
    pixels > 0 && `${pixels} tracking ${pixels === 1 ? "image" : "images"} removed`,
    links > 0 && `tracking removed from ${links} ${links === 1 ? "link" : "links"}`,
  ].filter(Boolean);
  return parts.length ? `Privacy: ${parts.join(", ")}.` : undefined;
}

/** The colour categories as one row of dots; a click switches a colour on or off. */
function CategoryRow({ m, close }: { m: { id: number; categories: string[] }; close: () => void }) {
  const setCategories = useStore((s) => s.setCategories);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5" role="group" aria-label="Colour categories">
      <span className="flex w-[18px] flex-none justify-center text-ink2">
        <IconTag size={16} />
      </span>
      {Object.entries(categories).map(([name, colour]) => {
        const on = m.categories.includes(name);
        return (
          <button
            key={name}
            type="button"
            title={on ? `Remove ${name}` : name}
            aria-label={`${name} category`}
            aria-pressed={on}
            onClick={() => {
              close();
              void setCategories(m.id, on ? m.categories.filter((c) => c !== name) : [...m.categories, name]);
            }}
            className={`size-[18px] flex-none rounded-full ${on ? "ring-2 ring-ink ring-offset-2 ring-offset-card" : "hover:scale-110"}`}
            style={{ background: colour }}
          />
        );
      })}
    </div>
  );
}

/**
 * The reply box under a message. A short answer can be typed and sent right here;
 * attaching a file, changing the signature or forwarding opens the full composer
 * with what was typed carried over.
 */
function QuickReply({ to }: { to: string }) {
  const { quickReply, reply, showToast } = useStore.getState();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const asHtml = () =>
    text
      .trim()
      .split(/\n{2,}/)
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`)
      .join("");
  async function send() {
    if (busy) return;
    if (!text.trim()) return box.current?.focus();
    setBusy(true);
    try {
      await quickReply(text);
      setText("");
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const tool = "rounded-md p-1.5 text-ink3 hover:bg-hover hover:text-ink";
  return (
    <div className="mt-auto flex-none pt-7">
      <div className="rounded-[14px] border border-edge px-4 pt-3 pb-2.5 focus-within:border-line">
        <textarea
          id="quick-reply"
          ref={box}
          value={text}
          rows={Math.min(8, Math.max(2, text.split("\n").length))}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Keep typing keys (Delete, arrows) away from the message shortcuts.
            e.stopPropagation();
            if (mod(e) && e.key === "Enter") void send();
          }}
          placeholder={`Reply to ${to}`}
          aria-label={`Reply to ${to}`}
          className="selectable block w-full resize-none bg-transparent outline-none placeholder:text-ink3"
        />
        <div className="mt-1 flex items-center gap-1">
          <button type="button" aria-label="Attach a file" title="Attach a file" className={tool} onClick={() => reply("reply", asHtml())}>
            <IconPaperclip size={18} stroke={1.6} />
          </button>
          <button type="button" aria-label="Signature and formatting" title="Signature and formatting" className={tool} onClick={() => reply("reply", asHtml())}>
            <IconSignature size={18} stroke={1.6} />
          </button>
          <button type="button" className="ml-auto rounded-md px-2.5 py-1.5 text-ink2 hover:bg-hover" onClick={() => reply("forward", asHtml())}>
            Forward
          </button>
          <button type="button" className="rounded-lg bg-ink px-4 py-1.5 text-card hover:opacity-90" onClick={() => void send()}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Plain-text mail, with web addresses turned into links that open in the browser. */
function PlainText({ text, query }: { text: string; query: string }) {
  const showToast = useStore((s) => s.showToast);
  // Split keeps the addresses (odd positions) between the ordinary text (even positions).
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            title={part}
            className="text-brand underline"
            onClick={(e) => {
              e.preventDefault();
              void backend.openLink(part).catch((err) => showToast(errorText(err)));
            }}
          >
            {part}
          </a>
        ) : (
          <Marked key={i} text={part} query={query} />
        ),
      )}
    </>
  );
}

/** One quiet line that says the message is suspicious; "Details" lists why. */
interface Reason {
  short: string;
  text: string;
}

function Warning({ id, reasons }: { id: number; reasons: Reason[] }) {
  const blockSender = useStore((s) => s.blockSender);
  const [open, setOpen] = useState(false);
  const first = reasons[0].short;
  const action = "flex-none rounded-md px-1.5 py-0.5 hover:bg-card/50";
  return (
    <div className="mb-4 flex-none rounded-[10px] bg-warn px-3.5 py-2.5 text-on-warn" role="alert">
      <div className="flex items-center gap-2">
        <IconAlertTriangle size={17} className="flex-none" />
        <span className="min-w-0 flex-1 truncate">{open ? "Be careful with this message" : reasons.length > 1 ? `${first}, and ${reasons.length - 1} more ${reasons.length === 2 ? "reason" : "reasons"}` : first}</span>
        <button type="button" className={action} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Details"}
        </button>
        <button type="button" className={action} onClick={() => void blockSender(id, false)}>
          Block
        </button>
      </div>
      {open && (
        <ul className="selectable mt-1.5 list-disc space-y-0.5 pl-9">
          {reasons.map((reason) => (
            <li key={reason.text}>{reason.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Offers to unsubscribe from a mailing; asks once before doing it. */
function Unsubscribe({ sender, kind, to }: { sender: string; kind: "one-click" | "mail" | "link"; to: string }) {
  const unsubscribe = useStore((s) => s.unsubscribe);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  // Say where the request goes: the address comes from the message, and the reader should see it first.
  const how =
    kind === "one-click"
      ? `OpenWren sends the request to ${to} for you.`
      : kind === "mail"
        ? `OpenWren sends an unsubscribe message from your address to ${to}.`
        : `The unsubscribe page at ${to} opens in your browser.`;
  return (
    <div className="mb-3 flex items-center gap-3 rounded-[10px] bg-canvas px-3 py-1.5 text-[13px] text-ink2">
      {asking ? (
        <>
          <span>
            Ask {sender} to stop sending you mail? {how}
          </span>
          <Button
            className="ml-auto h-7 flex-none"
            variant="primary"
            onClick={() => {
              setBusy(true);
              void unsubscribe().finally(() => (setBusy(false), setAsking(false)));
            }}
          >
            {busy ? "Sending…" : "Unsubscribe"}
          </Button>
          <Button className="h-7 flex-none" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          This is a mailing.
          <Button className="ml-auto h-7" onClick={() => setAsking(true)}>
            Unsubscribe
          </Button>
        </>
      )}
    </div>
  );
}

export function ReadingPane() {
  const ready = useStore((s) => s.ready);
  const hasAccounts = useStore((s) => s.accounts.length > 0);
  const messageId = useStore((s) => s.messageId);
  const selectedCount = useStore((s) => s.selected.length);
  const m = useStore((s) => s.detail);
  const thread = useStore((s) => s.thread);
  const error = useStore((s) => s.detailError);
  const draft = useStore((s) => s.draft);
  const query = useStore((s) => s.query.trim());
  const blockTrackers = useStore((s) => s.settings.block_trackers !== "off");
  const warn = useStore((s) => s.settings.phishing_warnings !== "off");
  const authServer = useStore((s) => s.accounts.find((a) => a.id === s.detail?.accountId)?.authServer);
  const isDraft = useStore((s) => s.folders.find((f) => f.id === s.detail?.folderId)?.role === "drafts");
  const editDraft = useStore((s) => s.editDraft);
  const threadHidden = useStore((s) => s.settings.thread_collapsed === "yes");
  const setSetting = useStore((s) => s.setSetting);
  const cleaned = useMemo(() => (m?.html ? cleanMail(m.html, blockTrackers) : null), [m?.id, m?.html, blockTrackers]);
  const { setFlags, moveMessages, deleteMessages, selectMessage, reply, setDialog, showToast, targets } = useStore.getState();
  const now = useMemo(() => new Date(), [m]);

  if (draft) return <Composer key={`${draft.id ?? "new"}-${draft.inReplyTo}-${draft.subject}`} className={shell} />;
  if (ready && !hasAccounts) {
    return (
      <Centered>
        <IconMail size={36} stroke={1.25} />
        <p className="text-base text-ink">Add your first account</p>
        <p>OpenWren keeps your mail on this computer and in sync with your mail server.</p>
        <Button variant="primary" onClick={() => setDialog("add-account")}>
          Add account
        </Button>
      </Centered>
    );
  }
  if (selectedCount > 1) {
    return (
      <Centered>
        <p className="text-base text-ink">{selectedCount} messages selected</p>
        <div className="flex gap-2">
          <Button onClick={() => void moveMessages(targets(), { role: "archive" })}>
            <IconArchive size={18} /> Archive
          </Button>
          <Button onClick={() => void deleteMessages(targets())}>
            <IconTrash size={18} /> Delete
          </Button>
          <Button onClick={() => targets().forEach((id) => void setFlags(id, { unread: false }))}>
            <IconMailOpened size={18} /> Mark as read
          </Button>
        </div>
        <p>Drag the selection onto a folder to move it.</p>
      </Centered>
    );
  }
  if (error && messageId !== null) {
    return (
      <Centered>
        <IconAlertCircle size={36} stroke={1.25} className="text-danger" />
        <p className="text-ink">This message couldn't be loaded.</p>
        <p className="selectable max-w-md">{error}</p>
        <Button onClick={() => void selectMessage(messageId)}>Try again</Button>
      </Centered>
    );
  }
  if (!m) {
    return (
      <Centered>
        <IconMail size={36} stroke={1.25} />
        {messageId === null ? "Select a message to read it" : "Loading…"}
      </Centered>
    );
  }

  // Reasons to distrust this message, most serious first.
  // Each reason has a few words for the one-line summary and a full sentence for "Details".
  const warnings: Reason[] = warn
    ? (
        [
          ["Sender not confirmed", authProblem(m.auth, authServer)],
          ["Sender name does not match the address", nameProblem(m.fromName, m.fromAddress)],
          ...(cleaned?.mismatches ?? []).slice(0, 3).map((l): [string, string] => ["Misleading link", `A link shows "${l.shown}" but leads to ${l.goes}.`]),
          ...(cleaned?.lookAlikes ?? []).slice(0, 3).map((name): [string, string] => ["Look-alike link", `A link leads to ${name}, a name that uses look-alike letters from another alphabet.`]),
        ] as [string, string | null][]
      )
        .filter((w): w is [string, string] => !!w[1])
        .map(([short, text]) => ({ short, text }))
    : [];

  const openFile = (index: number, name: string) => {
    showToast(`Opening ${name}…`);
    void backend.openAttachment(m.id, index, name).catch((e) => showToast(errorText(e)));
  };
  // The right-click menu already knows how to do these; borrow them by name.
  const borrowed = (...labels: string[]) => messageMenu(m).filter((item) => item !== "divider" && "onSelect" in item && labels.includes(item.label));
  const moreItems: MenuItem[] = [
    { label: "Reply all", icon: <IconArrowBackUpDouble size={16} />, onSelect: () => reply("reply-all") },
    { label: "Move to", icon: <IconFolderShare size={16} />, submenu: moveItems(m) },
    { custom: (close) => <CategoryRow m={m} close={close} /> },
    "divider",
    { label: m.unread ? "Mark as read" : "Mark as unread", icon: <IconMailOpened size={16} />, onSelect: () => void setFlags(m.id, { unread: !m.unread }) },
    { label: m.flagged ? "Remove flag" : "Flag", icon: <IconFlag size={16} />, onSelect: () => void setFlags(m.id, { flagged: !m.flagged }) },
    { label: m.pinned ? "Unpin" : "Pin", icon: <IconPin size={16} />, onSelect: () => void setFlags(m.id, { pinned: !m.pinned }) },
    "divider",
    ...borrowed("Block sender", "View source", "Save as file…"),
  ];

  const saveFile = (index: number, name: string) =>
    void backend
      .saveAttachment(m.id, index, name)
      .then((saved) => saved && showToast(`${name} saved`))
      .catch((e) => showToast(errorText(e)));

  return (
    <section className={`${shell} flex flex-col px-7 pt-3 pb-5`} aria-label="Reading pane">
      {/* The three everyday actions on the left; filing on the right; everything else under "More". */}
      <div className="mb-2.5 -ml-1.5 flex flex-none items-center gap-0.5 text-ink2" role="toolbar" aria-label="Message actions">
        <IconButton label="Archive" onClick={() => void moveMessages([m.id], { role: "archive" })}>
          <IconArchive size={19} />
        </IconButton>
        <IconButton label="Delete" onClick={() => void deleteMessages([m.id])}>
          <IconTrash size={19} />
        </IconButton>
        <Menu label="Snooze" button={<IconClock size={19} />} items={snoozeItems(m)} />
        {/* Flag and pin show here only while set, so they can be cleared with one click. */}
        {m.flagged && (
          <IconButton label="Remove flag" active onClick={() => void setFlags(m.id, { flagged: false })}>
            <IconFlag size={19} stroke={1.6} />
          </IconButton>
        )}
        {m.pinned && (
          <IconButton label="Unpin" active onClick={() => void setFlags(m.id, { pinned: false })}>
            <IconPin size={19} stroke={1.6} />
          </IconButton>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {!isDraft && (
            <IconButton
              label="Reply"
              onClick={() => {
                // Jump to the reply box at the bottom and start typing there.
                const box = document.getElementById("quick-reply");
                box?.scrollIntoView({ block: "nearest" });
                box?.focus();
              }}
            >
              <IconArrowBackUp size={19} />
            </IconButton>
          )}
          <IconButton label="Forward" onClick={() => reply("forward")}>
            <IconArrowForwardUp size={19} />
          </IconButton>
          <Menu label="More actions" align="right" button={<IconDots size={19} />} items={moreItems} />
        </div>
      </div>

      <h1 className="selectable mb-3.5 flex items-center gap-2 text-[23px] leading-snug text-ink">
        <Marked text={m.subject || "(no subject)"} query={query} />
        {m.categories.map((c) => (
          <CategoryDot key={c} name={c} />
        ))}
      </h1>

      {/* The whole conversation, oldest first. The list stays put while you move through it. */}
      {thread.length > 1 && (
        <div className="mb-4 flex-none rounded-[10px] bg-canvas p-1.5" aria-label="Conversation">
          {/* The arrow folds the list away, which helps with long conversations; the choice is remembered. */}
          <button
            type="button"
            aria-expanded={!threadHidden}
            onClick={() => void setSetting("thread_collapsed", threadHidden ? "no" : "yes")}
            className="flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-xs text-ink2 hover:bg-hover"
          >
            {threadHidden ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
            {thread.length} messages in this conversation
          </button>
          {!threadHidden && thread.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={t.id === m.id}
              onClick={() => t.id !== m.id && void selectMessage(t.id)}
              className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left ${t.id === m.id ? "bg-sel" : "hover:bg-hover"}`}
            >
              <span className={`w-36 flex-none truncate ${t.unread ? "font-semibold" : ""}`}>{t.fromName}</span>
              <span className="min-w-0 flex-1 truncate text-ink2">{t.preview || t.subject}</span>
              <span className="flex-none text-xs text-ink3">
                {t.folderName} · {shortTime(new Date(t.date * 1000), now)}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-none items-center gap-3">
        <Avatar name={m.fromName} address={m.fromAddress} auth={m.auth} accountId={m.accountId} />
        <div className="min-w-0 flex-1">
          <div className="selectable truncate">
            <span className="text-ink">{m.fromName}</span>
            {m.fromAddress && m.fromAddress !== m.fromName && <span className="text-ink3"> {m.fromAddress}</span>}
          </div>
          <div className="truncate text-[13px] text-ink3">
            to {m.to || "undisclosed recipients"}
            {m.cc && `, cc ${m.cc}`} · {longTime(new Date(m.date * 1000), now).replace(/^(Today|Yesterday)/, (word) => word.toLowerCase())}
          </div>
        </div>
        {isDraft && (
          <Button variant="primary" onClick={editDraft}>
            <IconPencil size={18} /> Edit draft
          </Button>
        )}
      </div>

      {warnings.length > 0 && <Warning key={`warning-${m.id}`} id={m.id} reasons={warnings} />}
      {m.unsubscribe && !isDraft && <Unsubscribe key={`unsubscribe-${m.id}`} sender={m.fromName} kind={m.unsubscribe} to={m.unsubscribeTo ?? "the sender"} />}

      {m.html ? (
        <HtmlBody key={`body-${m.id}`} sender={m.fromAddress} confirmed={senderConfirmed(m.auth, authServer)} html={cleaned?.html ?? m.html} note={trackerNote(cleaned?.pixels ?? 0, cleaned?.links ?? 0)} />
      ) : (
        <div className="selectable leading-relaxed whitespace-pre-wrap">
          <PlainText text={m.plain} query={query} />
        </div>
      )}

      {m.attachments.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {m.attachments.map((a, i) => (
            // Clicking the name opens the file; the arrow offers to save it.
            <div key={`${a.name}-${i}`} className="inline-flex items-center rounded-[10px] border border-edge text-ink2">
              <button type="button" title={`Open ${a.name}`} onClick={() => openFile(i, a.name)} className="inline-flex items-center gap-2 rounded-l-[10px] py-2 pr-2 pl-3 hover:bg-hover">
                <IconFileText size={18} />
                {a.name} · {fileSize(a.size)}
              </button>
              <Menu
                label={`More for ${a.name}`}
                button={<IconChevronDown size={16} />}
                items={[
                  { label: "Open", icon: <IconExternalLink size={16} />, onSelect: () => openFile(i, a.name) },
                  { label: "Save as…", icon: <IconDeviceFloppy size={16} />, onSelect: () => saveFile(i, a.name) },
                ]}
              />
            </div>
          ))}
        </div>
      )}

      {!isDraft && <QuickReply key={`reply-${m.id}`} to={m.fromName || m.fromAddress} />}
    </section>
  );
}
