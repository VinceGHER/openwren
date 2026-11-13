import { IconAlertTriangle, IconFlag, IconPaperclip, IconPin, IconSearch, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, CategoryDot, ContextMenu, IconButton, Marked } from "../components/ui";
import { groupLabel, shortTime } from "../lib/dates";
import { authProblem, nameProblem } from "../lib/privacy";
import { currentFolder, useStore } from "../store";
import type { Only } from "../store";
import type { MessageSummary, StoredDraft } from "../types";
import { messageMenu } from "./actions";
import { SearchChips } from "./SearchChips";
import { MOD, mod } from "../lib/keys";

/** Drag-and-drop type for message ids dragged onto a folder. */
export const DRAG_TYPE = "application/x-openwren-messages";

interface Section {
  label: string;
  items: MessageSummary[];
}

/** Group messages that are already sorted newest first. */
function sections(items: MessageSummary[], label: (m: MessageSummary) => string): Section[] {
  const out: Section[] = [];
  for (const m of items) {
    const l = label(m);
    const last = out[out.length - 1];
    if (last && last.label === l) last.items.push(m);
    else out.push({ label: l, items: [m] });
  }
  return out;
}

function Row({ m, now, query, onMenu }: { m: MessageSummary; now: Date; query: string; onMenu: (x: number, y: number, m: MessageSummary) => void }) {
  const open = useStore((s) => s.messageId === m.id);
  const ticked = useStore((s) => s.selected.includes(m.id));
  const { selectMessage, prefetch } = useStore.getState();
  // What can be told without opening the message: failed sender checks, or a name the address does not match.
  const warn = useStore((s) => s.settings.phishing_warnings !== "off");
  const server = useStore((s) => s.accounts.find((a) => a.id === m.accountId)?.authServer);
  const suspicious = useMemo(() => (warn ? (authProblem(m.auth, server) ?? nameProblem(m.fromName, m.fromAddress)) : null), [warn, m.auth, server, m.fromName, m.fromAddress]);
  const date = new Date(m.date * 1000);
  return (
    <div
      role="option"
      aria-selected={ticked}
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        const s = useStore.getState();
        const ids = s.selected.includes(m.id) ? s.selected : [m.id];
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ ids, accountId: m.accountId }));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => void selectMessage(m.id, e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "single")}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY, m);
      }}
      onKeyDown={(e) => e.key === "Enter" && void selectMessage(m.id)}
      // Pointing at a message gets it ready, so the click shows it at once.
      onMouseEnter={() => prefetch(m.id)}
      style={{ paddingTop: "var(--row-pad)", paddingBottom: "var(--row-pad)" }}
      // Rows run edge to edge and are divided by hairlines. Unread mail is bold, with a dot and a blue time;
      // once read, the sender and subject drop to regular weight and the subject turns grey.
      className={`flex cursor-default gap-3 border-b border-edge px-4 ${open || ticked ? "bg-sel" : "hover:bg-hover"}`}
    >
      <Avatar name={m.fromName} address={m.fromAddress} auth={m.auth} accountId={m.accountId} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-ink ${m.unread ? "font-semibold" : ""}`}>
            <Marked text={m.fromName} query={query} />
          </span>
          {suspicious && (
            <span className="flex-none text-[#b7791f]" title={`Be careful: ${suspicious}`} role="img" aria-label="Suspicious message">
              <IconAlertTriangle size={15} stroke={1.6} />
            </span>
          )}
          {m.unread && <span className="size-[7px] flex-none rounded-full bg-dot" aria-label="Unread" />}
          <span className="flex flex-none items-center gap-1 text-ink3">
            {m.categories.map((c) => (
              <CategoryDot key={c} name={c} />
            ))}
            {m.hasAttachment && <IconPaperclip size={14} stroke={1.6} />}
            {m.flagged && <IconFlag size={14} className="text-danger" />}
            {m.pinned && <IconPin size={14} className="text-brand" />}
          </span>
          <span className={`ml-auto flex-none pl-1 text-xs whitespace-nowrap ${m.unread ? "text-brand" : "text-ink3"}`}>{shortTime(date, now)}</span>
        </div>
        <div className={`truncate ${m.unread ? "font-semibold text-ink" : "text-ink2"}`}>
          <Marked text={m.subject || "(no subject)"} query={query} />
        </div>
        {/* A non-breaking space keeps the row height while the preview is still downloading. */}
        <div className={`truncate ${m.unread ? "text-ink2" : "text-ink3"}`}>{query ? `${m.folderName} · ${m.accountAddress}` : m.preview || " "}</div>
      </div>
    </div>
  );
}

/** A draft kept on this computer. Clicking it opens the composer again. */
function DraftRow({ d, now }: { d: StoredDraft; now: Date }) {
  const open = useStore((s) => s.draft?.id === d.id);
  const { openDraft, deleteDraft } = useStore.getState();
  return (
    <div
      role="option"
      aria-selected={open}
      tabIndex={0}
      onClick={() => openDraft(d.id)}
      onKeyDown={(e) => e.key === "Enter" && openDraft(d.id)}
      style={{ paddingTop: "var(--row-pad)", paddingBottom: "var(--row-pad)" }}
      className={`group relative flex cursor-default gap-3 border-b border-edge px-4 ${open ? "bg-sel" : "hover:bg-hover"}`}
    >
      <Avatar name={d.to || "Draft"} />
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-2">
          <span className="truncate">{d.to || "(no recipient)"}</span>
          <span className="flex-none text-xs whitespace-nowrap text-ink2 group-hover:invisible">{shortTime(new Date(d.updatedAt * 1000), now)}</span>
        </div>
        <div className="truncate">{d.subject || "(no subject)"}</div>
        <div className="truncate text-ink2">{d.html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim() || " "}</div>
      </div>
      {/* The open draft is discarded from the composer, which knows about unsaved typing. */}
      {!open && (
        <div className="absolute top-6 right-1.5 hidden rounded-lg bg-card shadow-sm group-hover:flex" onClick={(e) => e.stopPropagation()}>
          <IconButton label="Discard draft" className="size-7" onClick={() => void deleteDraft(d.id)}>
            <IconTrash size={16} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

export function MessageList({ width }: { width: number }) {
  const items = useStore((s) => s.items);
  const pinned = useStore((s) => s.pinned);
  const hasMore = useStore((s) => s.hasMore);
  const loadMore = useStore((s) => s.loadMore);
  const folders = useStore((s) => s.folders);
  const folderId = useStore((s) => s.folderId);
  const folder = useMemo(() => currentFolder({ folders, folderId }), [folders, folderId]);
  const allDrafts = useStore((s) => s.drafts);
  const typed = useStore((s) => s.query);
  const query = typed.trim();
  const setQuery = useStore((s) => s.setQuery);
  const only = useStore((s) => s.only);
  const setOnly = useStore((s) => s.setOnly);
  const search = useRef<HTMLInputElement>(null);
  // Ctrl+K (or Ctrl+E, as in Outlook) jumps to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mod(e) && ["k", "e"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const searchServer = useStore((s) => s.searchServer);
  const [menu, setMenu] = useState<{ x: number; y: number; m: MessageSummary } | null>(null);
  // Refreshed whenever the list changes, so "Today" stays right overnight.
  const now = useMemo(() => new Date(), [items]);
  const focusedInbox = useStore((s) => s.settings.focused_inbox !== "off");
  // "Other" (mailings only) is offered for inboxes while the Focused inbox setting is on.
  const isInbox = folder?.role === "inbox" && focusedInbox;
  const chips: [Only, string][] = [["all", "All"], ["unread", "Unread"], ["flagged", "Flagged"], ...(isInbox ? ([["other", "Other"]] as [Only, string][]) : [])];

  const groups = useMemo(() => {
    if (query) return sections(items, (m) => String(new Date(m.date * 1000).getFullYear()));
    const rest = sections(
      items.filter((m) => !m.pinned),
      (m) => groupLabel(new Date(m.date * 1000), now),
    );
    const pins = pinned.filter((m) => only === "all" || (only === "unread" ? m.unread : m.flagged));
    return pins.length ? [{ label: "Pinned", items: pins }, ...rest] : rest;
  }, [items, pinned, query, now, only]);

  // Drafts written here are listed above the server's Drafts folder of the same account.
  const drafts = useMemo(() => (!query && folder?.role === "drafts" ? allDrafts.filter((d) => d.accountId === folder.accountId) : []), [allDrafts, folder, query]);
  const empty = items.length === 0 && pinned.length === 0 && drafts.length === 0;
  return (
    <section className="flex flex-none flex-col overflow-hidden bg-card" style={{ width }} aria-label="Messages">
      <div className="flex-none border-b border-edge px-4 pt-3.5 pb-3">
        <label className={`flex h-9 items-center gap-2 rounded-lg px-3 ${typed ? "bg-card ring-1 ring-line" : "bg-canvas focus-within:bg-card focus-within:ring-1 focus-within:ring-line"}`}>
          <IconSearch size={16} className="flex-none text-ink3" />
          <input
            ref={search}
            value={typed}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search mail"
            title="Try from:name, has:attachment or before:2024-01-31"
            aria-label="Search mail"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink3"
          />
          {typed ? (
            <button type="button" aria-label="Clear search" className="flex-none text-ink3 hover:text-ink" onClick={() => setQuery("")}>
              <IconX size={16} />
            </button>
          ) : (
            <span className="flex-none text-[11px] text-ink3">{MOD} K</span>
          )}
        </label>
        {query ? (
          <>
            <SearchChips />
            <div className="mt-2 flex items-baseline text-xs text-ink2">
              <span className="text-ink">{items.length === 1 ? "1 result" : `${items.length} results`}</span>
              <span className="ml-auto">Newest first</span>
            </div>
          </>
        ) : (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Show">
            {chips.map(([value, name]) => (
              <button
                key={value}
                type="button"
                aria-pressed={only === value}
                onClick={() => setOnly(value)}
                className={`h-7 rounded-full px-3 text-[13px] ${only === value ? "bg-soft text-brand" : "border border-edge text-ink2 hover:bg-hover"}`}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto pb-1.5"
        role="listbox"
        aria-multiselectable
        aria-label="Message list"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 600) void loadMore();
        }}
      >
        {drafts.length > 0 && (
          <div>
            <div className="border-b border-edge px-4 pt-3 pb-2 text-xs text-ink3">Written here</div>
            {drafts.map((d) => (
              <DraftRow key={d.id} d={d} now={now} />
            ))}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="border-b border-edge px-4 pt-3 pb-2 text-xs text-ink3">{g.label}</div>
            {g.items.map((m) => (
              <Row key={m.id} m={m} now={now} query={query} onMenu={(x, y, msg) => setMenu({ x, y, m: msg })} />
            ))}
          </div>
        ))}
        {empty && (
          <p className="px-4 py-10 text-center text-ink2">
            {query
              ? "No mail matches. Try fewer words or another date range."
              : !folder
                ? "Add an account to see your mail."
                : only === "other"
                  ? "No mailings here."
                  : only !== "all"
                    ? `No ${only} mail here.`
                    : "This folder is empty."}
          </p>
        )}
        {query && (
          <button type="button" onClick={() => void searchServer()} className="mx-auto my-2 block rounded-full px-3 py-1.5 text-brand hover:bg-hover">
            Search the server for more
          </button>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={messageMenu(menu.m)} onClose={() => setMenu(null)} />}
    </section>
  );
}
