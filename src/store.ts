import { create } from "zustand";
import { backend, errorText } from "./backend";
import { longTime, useTwelveHourClock } from "./lib/dates";
import { cleanMail } from "./lib/privacy";
import { SIGNATURE_CID, hasPicture, signatureHtml } from "./lib/signature";
import type {
  Account,
  Draft,
  Flags,
  Folder,
  MessageDetail,
  MessageSummary,
  MoveTarget,
  Progress,
  SavedSignature,
  SearchFilters,
  SignatureDefaults,
  StoredDraft,
} from "./types";

export type Tab = "focused" | "other";
/** Narrows a folder's list to unread or flagged mail. */
export type Only = "all" | "unread" | "flagged" | "other";
export type SettingsPage = "accounts" | "signatures" | "sync" | "appearance" | "privacy" | "rules" | "notifications" | "about";

export interface Toast {
  id: number;
  text: string;
  /** Optional button, such as Undo. */
  action?: { label: string; run: () => void };
  /** When set (milliseconds), the text is a countdown to this moment: "Sending in 7 seconds". */
  sendsAt?: number;
}

/** Folder id that stands for the inboxes of every account together. */
export const ALL_INBOXES = -1;

export function allInboxes(folders: Folder[]): Folder {
  const unread = folders.filter((f) => f.role === "inbox").reduce((n, f) => n + f.unread, 0);
  return { id: ALL_INBOXES, accountId: 0, name: "All inboxes", role: "inbox", favorite: true, unread };
}

/** The folder being shown, which may be "All inboxes". */
export function currentFolder(s: { folders: Folder[]; folderId: number | null }): Folder | undefined {
  return s.folderId === ALL_INBOXES ? allInboxes(s.folders) : s.folders.find((f) => f.id === s.folderId);
}

const PAGE = 100;
const TOAST_MS = 7000;

interface State {
  /** False until the first load of accounts and folders has finished. */
  ready: boolean;
  accounts: Account[];
  folders: Folder[];
  folderId: number | null;
  tab: Tab;
  only: Only;
  /** The current list: a folder page or search results. */
  items: MessageSummary[];
  pinned: MessageSummary[];
  hasMore: boolean;
  /** The message shown in the reading pane. */
  messageId: number | null;
  /** Messages ticked for a bulk action (always includes messageId when set by a click). */
  selected: number[];
  detail: MessageDetail | null;
  detailError: string | null;
  /** Other messages in the open message's conversation, oldest first. */
  thread: MessageSummary[];
  query: string;
  filters: SearchFilters;
  /** The open draft, or null when the composer is closed. */
  draft: Draft | null;
  /** Drafts saved on this computer, newest first. */
  drafts: StoredDraft[];
  dialog: "add-account" | "settings" | null;
  /** True while the first-run welcome screens are showing. */
  welcome: boolean;
  /** The message whose source (headers and raw text) is being inspected, if any. */
  sourceOf: number | null;
  settingsPage: SettingsPage;
  /** Latest sync status per account. */
  progress: Record<number, Progress>;
  toast: Toast | null;
  signatures: SavedSignature[];
  signatureDefaults: SignatureDefaults[];
  /** The desktop's own font, read once at start. */
  systemFont: { family: string; light: boolean };
  /** User preferences, as stored (all strings). */
  settings: Record<string, string>;

  init: () => Promise<void>;
  /** Re-read folders and the current list after the mail engine reports a change. */
  refresh: () => Promise<void>;
  loadPreferences: () => Promise<void>;
  setSetting: (key: string, value: string) => Promise<void>;
  selectFolder: (id: number) => void;
  setTab: (tab: Tab) => void;
  setOnly: (only: Only) => void;
  loadMore: () => Promise<void>;
  /** Get a message ready (download its text if needed) so it opens at once when clicked. */
  prefetch: (id: number) => void;
  /** Open a message. `mode` extends the selection instead (Ctrl- or Shift-click). */
  selectMessage: (id: number, mode?: "single" | "toggle" | "range") => Promise<void>;
  /** Move to the next (1) or previous (-1) message in the list. */
  step: (direction: 1 | -1) => void;
  setQuery: (query: string) => void;
  setFilters: (patch: Partial<SearchFilters>) => void;
  searchServer: () => Promise<void>;
  setFlags: (id: number, flags: Flags) => Promise<void>;
  /** The messages an action applies to: the ticked ones, or the open one. */
  targets: () => number[];
  moveMessages: (ids: number[], target: MoveTarget) => Promise<void>;
  deleteMessages: (ids: number[]) => Promise<void>;
  sweep: (id: number) => Promise<void>;
  setCategories: (id: number, categories: string[]) => Promise<void>;
  snooze: (id: number, until: number | null) => Promise<void>;
  setSenderFocus: (id: number, focused: boolean) => Promise<void>;
  /** Send this sender's mail (or their whole domain's) to Junk from now on. */
  blockSender: (id: number, wholeDomain: boolean) => Promise<void>;
  compose: (seed?: Partial<Draft>) => void;
  /** Open the composer on a reply or forward of the open message; `html` is text already typed. */
  reply: (kind: "reply" | "reply-all" | "forward", html?: string) => void;
  /** Send a short reply to the open message straight from the reading pane. */
  quickReply: (text: string) => Promise<void>;
  closeCompose: () => void;
  /** Keep a draft on this computer. Returns its id. */
  saveDraft: (draft: Draft) => Promise<number>;
  deleteDraft: (id: number) => Promise<void>;
  openDraft: (id: number) => void;
  toggleFavorite: (folder: Folder) => Promise<void>;
  markFolderRead: (folder: Folder) => Promise<void>;
  syncNow: () => void;
  /** Queue the draft. `sendAt` (Unix seconds) schedules it; otherwise it leaves after the undo delay. */
  send: (draft: Draft, signature: SavedSignature | undefined, sendAt?: number) => Promise<void>;
  /** Continue writing the open message, which is a draft on the server. */
  editDraft: () => void;
  /** Ask the sender of the open mailing to stop writing. */
  unsubscribe: () => Promise<void>;
  setDialog: (dialog: State["dialog"], page?: SettingsPage) => void;
  showSource: (id: number | null) => void;
  setWelcome: (on: boolean) => void;
  showToast: (text: string, action?: Toast["action"], sendsAt?: number) => void;
  dismissToast: () => void;
}

export const noFilters: SearchFilters = { accountId: null, hasAttachment: false, date: "any", after: null, before: null };

// Only the latest request of each kind may write its result.
let listRequest = 0;
let detailRequest = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastId = 0;
let started = false;

/** How many messages at the top of a list are made ready in advance. */
const PREFETCH_TOP = 12;
const CACHE_SIZE = 300;

interface Opened {
  detail: MessageDetail;
  thread: MessageSummary[];
}
/** Messages already read from the mail engine. Their text never changes; flags come from the list. */
const opened = new Map<number, Opened>();
const loading = new Map<number, Promise<Opened>>();
/** Prefetching runs one message at a time, so it never competes with a click. */
let prefetching: Promise<unknown> = Promise.resolve();
let prefetchRound = 0;

function load(id: number): Promise<Opened> {
  const running = loading.get(id);
  if (running) return running;
  const request = Promise.all([backend.getMessage(id), backend.threadMessages(id)])
    .then(([detail, thread]) => {
      opened.delete(id);
      opened.set(id, { detail, thread });
      if (opened.size > CACHE_SIZE) opened.delete(opened.keys().next().value!);
      return { detail, thread };
    })
    .finally(() => loading.delete(id));
  loading.set(id, request);
  return request;
}

function prefetch(ids: number[]) {
  const round = ++prefetchRound;
  for (const id of ids) {
    if (opened.has(id)) continue;
    prefetching = prefetching.then(() => (round === prefetchRound && !opened.has(id) ? load(id).catch(() => undefined) : undefined));
  }
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nowSeconds = () => Math.floor(Date.now() / 1000);
const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

/** The original message as it is quoted under a reply or forward. */
function quoteOf(m: MessageDetail, forward: boolean): string {
  const when = longTime(new Date(m.date * 1000), new Date());
  // Quoted mail is sent on to others: leave the trackers out of it.
  const body = m.html ? cleanMail(m.html).html : `<p>${escapeHtml(m.plain).replace(/\n/g, "<br>")}</p>`;
  const intro = forward
    ? `<p>---------- Forwarded message ----------<br>From: ${escapeHtml(m.fromName)} &lt;${escapeHtml(m.fromAddress)}&gt;<br>Date: ${when}<br>Subject: ${escapeHtml(m.subject)}<br>To: ${escapeHtml(m.to)}</p>`
    : `<p>On ${when}, ${escapeHtml(m.fromName)} wrote:</p>`;
  return `${intro}<blockquote style="margin:0 0 0 8px;padding-left:10px;border-left:3px solid #e3e6ea">${body}</blockquote>`;
}

const prefixed = (prefix: string, subject: string) => (new RegExp(`^${prefix}:`, "i").test(subject) ? subject : `${prefix}: ${subject}`);

export const useStore = create<State>((set, get) => {
  /** What the list chips ask for: (Focused / Other split, unread or flagged only). "Other" is the mailings of an inbox. */
  const narrowed = (): [boolean | null, "unread" | "flagged" | null] => {
    const { only } = get();
    return [only === "other" ? false : null, only === "unread" || only === "flagged" ? only : null];
  };

  /** Load the list for the current folder, tab and search. */
  async function loadList(keepLength: boolean) {
    const request = ++listRequest;
    const { query, filters } = get();
    if (query.trim()) {
      const items = await backend.search(query, filters);
      if (request === listRequest) set({ items, pinned: [], hasMore: false });
      return;
    }
    const folder = currentFolder(get());
    if (!folder) {
      set({ items: [], pinned: [], hasMore: false });
      return;
    }
    const [focused, only] = narrowed();
    const limit = keepLength ? Math.max(PAGE, get().items.length) : PAGE;
    const [items, pinned] = await Promise.all([backend.listMessages(folder.id, focused, limit, 0, only), backend.listPinned(folder.id, focused)]);
    if (request !== listRequest) return;
    set({ items, pinned, hasMore: items.length === limit });
    prefetch([...pinned, ...items].slice(0, PREFETCH_TOP).map((m) => m.id));
  }

  /** Apply a change to one message everywhere it is shown. */
  function patch(id: number, change: Partial<MessageSummary>) {
    const apply = <T extends MessageSummary>(m: T): T => (m.id === id ? { ...m, ...change } : m);
    set((s) => ({ items: s.items.map(apply), pinned: s.pinned.map(apply), detail: s.detail && apply(s.detail) }));
  }

  /** Messages in the order they appear on screen. */
  const visible = () => {
    const { items, pinned, query } = get();
    return query.trim() ? items : [...pinned, ...items.filter((m) => !m.pinned)];
  };

  /** After messages leave the list, open the one that followed them. */
  function leave(ids: number[]) {
    const { messageId } = get();
    const order = visible();
    set((s) => ({ selected: s.selected.filter((id) => !ids.includes(id)), items: s.items.filter((m) => !ids.includes(m.id)), pinned: s.pinned.filter((m) => !ids.includes(m.id)) }));
    if (messageId === null || !ids.includes(messageId)) return;
    const from = order.findIndex((m) => m.id === messageId);
    const next = order.slice(from + 1).find((m) => !ids.includes(m.id)) ?? order.slice(0, from).reverse().find((m) => !ids.includes(m.id));
    if (next) void get().selectMessage(next.id);
    else set({ messageId: null, detail: null, thread: [] });
  }

  /** Run a move-like action, then offer Undo. */
  async function moved(ids: number[], what: string, run: () => Promise<number[]>) {
    if (ids.length === 0) return;
    leave(ids);
    try {
      const ops = await run();
      const undo = ops.length
        ? {
            label: "Undo",
            run: () =>
              void backend.undoMoves(ops).then((n) => {
                get().showToast(n === ops.length ? "Undone" : "Too late to undo: the change has already reached the mail server.");
                void get().refresh();
              }),
          }
        : undefined;
      get().showToast(`${plural(ids.length, "message")} ${what}`, undo);
    } catch (e) {
      get().showToast(errorText(e));
      await get().refresh();
    }
  }

  return {
    ready: false,
    accounts: [],
    folders: [],
    folderId: null,
    tab: "focused",
    only: "all",
    items: [],
    pinned: [],
    hasMore: false,
    messageId: null,
    selected: [],
    detail: null,
    detailError: null,
    thread: [],
    query: "",
    filters: noFilters,
    draft: null,
    drafts: [],
    dialog: null,
    sourceOf: null,
    welcome: false,
    settingsPage: "accounts",
    progress: {},
    toast: null,
    signatures: [],
    signatureDefaults: [],
    settings: {},
    systemFont: { family: "", light: false },

    init: async () => {
      if (started) return; // React's strict mode runs effects twice in development
      started = true;
      backend.onChanged(() => {
        // Sync reports changes in bursts; re-read at most a few times a second.
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void get().refresh(), 250);
      });
      backend.onProgress((p) => set((s) => ({ progress: { ...s.progress, [p.accountId]: p } })));
      backend.onSendFailed((f) => get().showToast(`"${f.subject || "(no subject)"}" could not be sent and will be retried. ${f.error}`));
      void backend
        .appInfo()
        .then((info) => info && set({ systemFont: { family: info.systemFont, light: info.systemFontLight } }))
        .catch((e) => console.error("app_info failed", e));
      await Promise.all([get().refresh(), get().loadPreferences()]);
      // A first start (no account yet, welcome never finished) opens on the welcome screens.
      set({ ready: true, welcome: get().accounts.length === 0 && get().settings.onboarded !== "yes" });
      // Two frames later the first list is on screen; the engine may be timing that.
      requestAnimationFrame(() => requestAnimationFrame(() => void backend.markReady().catch(() => undefined)));
    },

    refresh: async () => {
      const [accounts, folders, saved] = await Promise.all([backend.listAccounts(), backend.listFolders(), backend.listDrafts()]);
      const current = get().folderId;
      const kept = current === ALL_INBOXES ? accounts.length > 0 : folders.some((f) => f.id === current);
      const folderId = kept ? current : (folders.find((f) => f.role === "inbox")?.id ?? null);
      const drafts = saved.flatMap((d): StoredDraft[] => {
        try {
          return [{ ...(JSON.parse(d.content) as Draft), id: d.id, accountId: d.accountId, updatedAt: d.updatedAt }];
        } catch {
          return []; // unreadable draft: leave it out instead of breaking the list
        }
      });
      set({ accounts, folders, folderId, drafts });
      await loadList(true);
    },

    loadPreferences: async () => {
      const keys = ["theme", "density", "body_days", "notifications", "undo_seconds", "google_client_id", "google_client_secret", "block_trackers", "phishing_warnings", "brand_logos", "close_to_tray", "focused_inbox", "image_senders", "blocked_senders", "font", "text_size", "time_format", "onboarded", "usage_stats", "thread_collapsed"];
      const [signatures, signatureDefaults, values] = await Promise.all([
        backend.listSignatures(),
        backend.signatureDefaults(),
        Promise.all(keys.map((k) => backend.getSetting(k))),
      ]);
      const settings: Record<string, string> = {};
      keys.forEach((k, i) => {
        if (values[i] !== null) settings[k] = values[i];
      });
      const split = get().settings.focused_inbox !== settings.focused_inbox;
      useTwelveHourClock(settings.time_format === "12");
      set({ signatures, signatureDefaults, settings });
      if (split) await loadList(false); // the first list was loaded before the preference was known
    },

    setSetting: async (key, value) => {
      set((s) => ({ settings: { ...s.settings, [key]: value } }));
      await backend.setSetting(key, value);
      if (key === "time_format") useTwelveHourClock(value === "12");
      // These change what the list shows: read it again so every row is redrawn.
      if (key === "focused_inbox" || key === "time_format") await loadList(true);
    },

    selectFolder: (folderId) => {
      set({ folderId, only: "all", messageId: null, selected: [], detail: null, detailError: null, thread: [], query: "", filters: noFilters, draft: null, items: [], pinned: [] });
      void loadList(false);
    },

    setOnly: (only) => {
      set({ only, items: [], selected: [] });
      void loadList(false);
    },

    setTab: (tab) => {
      set({ tab, items: [], pinned: [], selected: [] });
      void loadList(false);
    },

    loadMore: async () => {
      const { items, hasMore, query } = get();
      const folder = currentFolder(get());
      if (!folder || !hasMore || query.trim()) return;
      const request = ++listRequest;
      const [focused, only] = narrowed();
      const more = await backend.listMessages(folder.id, focused, PAGE, items.length, only);
      if (request === listRequest) set({ items: [...items, ...more], hasMore: more.length === PAGE });
    },

    prefetch: (id) => prefetch([id]),

    selectMessage: async (id, mode = "single") => {
      if (mode === "toggle") {
        set((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] }));
        return;
      }
      if (mode === "range") {
        const order = visible().map((m) => m.id);
        const anchor = get().messageId ?? id;
        const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
        if (a >= 0) set({ selected: order.slice(a, b + 1) });
        return;
      }
      const request = ++detailRequest;
      // A message read before (or made ready in advance) shows at once, with the flags the list has now.
      const ready = opened.get(id);
      const order = visible();
      const row = order.find((m) => m.id === id);
      // Moving within a conversation keeps its list on screen while the next message loads.
      const sameThread = get().thread.some((t) => t.id === id) ? get().thread : [];
      set({ messageId: id, selected: [id], detail: ready ? { ...ready.detail, ...row } : null, detailError: null, thread: ready?.thread ?? sameThread, draft: null });
      try {
        const { detail, thread } = await load(id);
        if (request !== detailRequest) return;
        set({ detail, thread });
        // The reader usually moves on to another message of the conversation, or to a
        // neighbour in the list: have those ready, so they open without a flash.
        const at = order.findIndex((m) => m.id === id);
        const neighbours = [order[at + 1], order[at + 2], order[at - 1]].filter(Boolean).map((m) => m.id);
        prefetch([...thread.map((t) => t.id).filter((other) => other !== id), ...neighbours]);
        if (detail.unread) await get().setFlags(id, { unread: false });
      } catch (e) {
        if (request === detailRequest) set({ detailError: errorText(e) });
      }
    },

    step: (direction) => {
      const order = visible();
      const at = order.findIndex((m) => m.id === get().messageId);
      const next = order[at === -1 ? 0 : at + direction];
      if (next) void get().selectMessage(next.id);
    },

    setQuery: (query) => {
      const wasSearching = get().query.trim() !== "";
      set({ query });
      clearTimeout(searchTimer);
      if (!query.trim()) {
        if (wasSearching) {
          set({ filters: noFilters, messageId: null, selected: [], detail: null, thread: [], items: [], pinned: [] });
          void loadList(false);
        }
        return;
      }
      searchTimer = setTimeout(() => void loadList(false), 150);
    },

    setFilters: (change) => {
      set((s) => ({ filters: { ...s.filters, ...change } }));
      void loadList(false);
    },

    searchServer: async () => {
      const { query, filters } = get();
      get().showToast("Searching the mail server…");
      try {
        const fetched = await backend.searchServer(query, filters.accountId);
        get().showToast(fetched === 0 ? "The server found nothing more." : `${plural(fetched, "more message")} downloaded from the server.`);
        await loadList(false);
      } catch (e) {
        get().showToast(errorText(e));
      }
    },

    setFlags: async (id, flags) => {
      patch(id, flags); // show the change at once; the engine confirms with a refresh
      try {
        await backend.setFlags(id, flags);
      } catch (e) {
        console.error("set_flags failed", e);
        await get().refresh();
      }
    },

    targets: () => {
      const { selected, messageId } = get();
      return selected.length > 0 ? selected : messageId !== null ? [messageId] : [];
    },

    moveMessages: (ids, target) => moved(ids, "role" in target && target.role === "archive" ? "archived" : "moved", () => backend.moveMessages(ids, target)),
    deleteMessages: (ids) => moved(ids, "deleted", () => backend.deleteMessages(ids)),

    sweep: async (id) => {
      const sender = get().items.find((m) => m.id === id)?.fromAddress ?? get().detail?.fromAddress;
      const ids = visible().filter((m) => m.fromAddress === sender).map((m) => m.id);
      await moved(ids.length ? ids : [id], "deleted", () => backend.sweep(id));
    },

    setCategories: async (id, categories) => {
      patch(id, { categories });
      await backend.setCategories(id, categories);
    },

    snooze: async (id, until) => {
      await backend.snooze(id, until);
      if (until !== null) {
        leave([id]);
        get().showToast("Snoozed. It returns to the top of the folder, unread.", { label: "Undo", run: () => void backend.snooze(id, null).then(() => get().refresh()) });
      }
    },

    blockSender: async (id, wholeDomain) => {
      const m = get().items.find((x) => x.id === id) ?? get().detail;
      if (!m) return;
      const domain = m.fromAddress.split("@").pop() ?? "";
      const who = wholeDomain ? `everyone at ${domain}` : m.fromAddress;
      // Their mail in the list on screen leaves at once; the engine moves the rest.
      const hostOf = (x: MessageSummary) => (x.fromAddress.split("@").pop() ?? "").toLowerCase();
      const covered = (x: MessageSummary) =>
        wholeDomain ? hostOf(x) === domain.toLowerCase() || hostOf(x).endsWith(`.${domain.toLowerCase()}`) : x.fromAddress.toLowerCase() === m.fromAddress.toLowerCase();
      const inInbox = get().folders.find((f) => f.id === m.folderId)?.role === "inbox";
      if (inInbox) leave(visible().filter(covered).map((x) => x.id));
      try {
        const ops = await backend.blockSender(id, wholeDomain);
        await get().loadPreferences();
        await get().refresh();
        const undo = ops.length ? { label: "Undo move", run: () => void backend.undoMoves(ops).then(() => get().refresh()) } : undefined;
        get().showToast(`Blocked ${who}. Their mail now goes to Junk. Unblock in Settings, Privacy.`, undo);
      } catch (e) {
        get().showToast(errorText(e));
        await get().refresh();
      }
    },

    setSenderFocus: async (id, focused) => {
      await backend.setSenderFocus(id, focused);
      get().showToast(`Mail from this sender now goes to ${focused ? "Focused" : "Other"}.`);
      await get().refresh();
    },

    compose: (seed) => {
      const { accounts } = get();
      // "All inboxes" belongs to no account: write from the first one.
      const accountId = currentFolder(get())?.accountId || accounts[0]?.id;
      if (accountId === undefined) {
        get().setDialog("add-account");
        return;
      }
      set({ draft: { accountId, to: "", cc: "", bcc: "", subject: "", html: "", quote: "", inReplyTo: null, references: null, attachments: [], isReply: false, ...seed } });
    },

    quickReply: async (text) => {
      const m = get().detail;
      if (!m || !text.trim()) return;
      const own = get().accounts.find((a) => a.id === m.accountId);
      const sender = m.fromName && m.fromName !== m.fromAddress ? `${m.fromName.replace(/[,;<>"]/g, " ")} <${m.fromAddress}>` : m.fromAddress;
      const html = text
        .trim()
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
      const draft: Draft = {
        accountId: m.accountId,
        to: sender,
        cc: "",
        bcc: "",
        subject: prefixed("Re", m.subject),
        html,
        quote: quoteOf(m, false),
        inReplyTo: m.messageIdHeader,
        references: [m.references, m.messageIdHeader].filter(Boolean).join(" ") || null,
        attachments: [],
        isReply: true,
      };
      // The account's usual signature for replies goes along, as it would from the composer.
      const replyId = get().signatureDefaults.find((d) => d.accountId === own?.id)?.replyId;
      await get().send(draft, get().signatures.find((s) => s.id === replyId));
    },

    reply: (kind, html = "") => {
      const m = get().detail;
      if (!m) return;
      const own = get().accounts.find((a) => a.id === m.accountId)?.address.toLowerCase() ?? "";
      const notMe = (list: string) => list.split(",").map((x) => x.trim()).filter((x) => x && !x.toLowerCase().includes(own)).join(", ");
      const sender = m.fromName && m.fromName !== m.fromAddress ? `${m.fromName.replace(/[,;<>"]/g, " ")} <${m.fromAddress}>` : m.fromAddress;
      const base = { accountId: m.accountId, quote: quoteOf(m, kind === "forward"), isReply: true, html };
      const threading = { inReplyTo: m.messageIdHeader, references: [m.references, m.messageIdHeader].filter(Boolean).join(" ") || null };
      if (kind === "forward") get().compose({ ...base, subject: prefixed("Fw", m.subject) });
      else if (kind === "reply") get().compose({ ...base, ...threading, to: sender, subject: prefixed("Re", m.subject) });
      else get().compose({ ...base, ...threading, to: [sender, notMe(m.toAddresses)].filter(Boolean).join(", "), cc: notMe(m.ccAddresses), subject: prefixed("Re", m.subject) });
    },

    closeCompose: () => set({ draft: null }),

    saveDraft: async (draft) => {
      const { id, messageId, ...content } = draft;
      const saved = await backend.saveDraft(id ?? null, draft.accountId, JSON.stringify(content), messageId ?? null);
      set((s) => ({ drafts: [{ ...draft, id: saved, updatedAt: nowSeconds() }, ...s.drafts.filter((d) => d.id !== saved)] }));
      return saved;
    },

    deleteDraft: async (id) => {
      set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }));
      await backend.deleteDraft(id);
    },

    openDraft: (id) => {
      const draft = get().drafts.find((d) => d.id === id);
      if (draft) set({ draft, messageId: null, selected: [], detail: null, detailError: null, thread: [] });
    },

    toggleFavorite: async (folder) => {
      const favorite = !folder.favorite;
      set((s) => ({ folders: s.folders.map((f) => (f.id === folder.id ? { ...f, favorite } : f)) }));
      try {
        await backend.setFavorite(folder.id, favorite);
      } catch (e) {
        get().showToast(errorText(e));
        await get().refresh();
      }
    },

    markFolderRead: async (folder) => {
      try {
        await backend.markFolderRead(folder.id);
        get().showToast(`Everything in ${folder.name} is marked as read.`);
        await get().refresh();
      } catch (e) {
        get().showToast(errorText(e));
      }
    },

    syncNow: () => {
      void backend.syncNow().catch((e) => get().showToast(errorText(e)));
    },

    editDraft: () => {
      const m = get().detail;
      if (!m) return;
      get().compose({
        accountId: m.accountId,
        to: m.toAddresses,
        cc: m.ccAddresses,
        subject: m.subject,
        html: m.html ?? `<p>${escapeHtml(m.plain).replace(/\n/g, "<br>")}</p>`,
        // Saving replaces the copy on the server. One with attachments is kept
        // as it is, because its files cannot be carried over.
        messageId: m.attachments.length === 0 ? m.messageIdHeader : null,
      });
    },

    unsubscribe: async () => {
      const m = get().detail;
      if (!m) return;
      try {
        const done = await backend.unsubscribe(m.id);
        get().showToast(
          done === "posted"
            ? `Unsubscribe request sent to ${m.fromName}.`
            : done === "mailed"
              ? `An unsubscribe message is on its way to ${m.fromName}.`
              : "The sender's unsubscribe page is open in your browser.",
        );
      } catch (e) {
        get().showToast(errorText(e));
      }
    },

    send: async (draft, signature, sendAt) => {
      const delay = Number(get().settings.undo_seconds ?? "10");
      const at = sendAt ?? nowSeconds() + delay;
      // A signature picture travels inside the message, so it shows without "load images".
      const picture = signature && hasPicture(signature);
      const signed = signature && signatureHtml(signature, picture ? `cid:${SIGNATURE_CID}` : undefined);
      const html = [draft.html, signed && `<br><div>${signed}</div>`, draft.quote && `<br>${draft.quote}`].filter(Boolean).join("");
      const id = await backend.sendMessage({
        accountId: draft.accountId,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        html,
        inReplyTo: draft.inReplyTo,
        references: draft.references,
        attachments: draft.attachments,
        inlineImages: picture ? [{ cid: SIGNATURE_CID, dataUrl: signature.image }] : [],
        sendAt: at,
      });
      set({ draft: null });
      if (draft.id !== undefined) await get().deleteDraft(draft.id);
      const undo = {
        label: sendAt ? "Cancel" : "Undo",
        run: () =>
          void backend.cancelSend(id).then((ok) => {
            if (!ok) return get().showToast("Too late: the message has already been sent.");
            // Back to a draft: save it again so it is not lost if the composer is closed.
            const again: Draft = { ...draft, id: undefined };
            void get()
              .saveDraft(again)
              .then((id) => set({ draft: { ...again, id } }));
          }),
      };
      get().showToast(sendAt ? `Scheduled for ${longTime(new Date(sendAt * 1000), new Date())}. OpenWren must be running then.` : delay > 0 ? `Sending in ${delay} seconds` : "Sending…", undo, sendAt || delay <= 0 ? undefined : at * 1000);
    },

    showSource: (sourceOf) => set({ sourceOf }),
    setWelcome: (welcome) => set({ welcome, dialog: null }),

    setDialog: (dialog, page) => set((s) => ({ dialog, settingsPage: page ?? s.settingsPage })),

    showToast: (text, action, sendsAt) => {
      clearTimeout(toastTimer);
      toastId += 1;
      set({ toast: { id: toastId, text, action, sendsAt } });
      const delay = Number(get().settings.undo_seconds ?? "10") * 1000;
      toastTimer = setTimeout(() => set({ toast: null }), action ? Math.max(TOAST_MS, delay) : TOAST_MS);
    },

    dismissToast: () => {
      clearTimeout(toastTimer);
      set({ toast: null });
    },
  };
});
