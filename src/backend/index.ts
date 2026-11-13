import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Account,
  Contact,
  Flags,
  Folder,
  LocalDraft,
  MessageDetail,
  MessageSummary,
  MoveTarget,
  NewAccount,
  Outgoing,
  Progress,
  Rule,
  SavedSignature,
  SearchFilters,
  SendFailed,
  SignatureDefaults,
} from "../types";
import { sampleBackend } from "./sample";

export interface AppInfo {
  version: string;
  schemaVersion: number;
  /** Folder that holds the mail database. */
  dataDir: string;
  /** Version of SQLCipher encrypting the database. */
  cipher: string;
  /** The font this desktop is set to use, or empty when unknown. */
  systemFont: string;
  /** True when the desktop uses the light weight of that font. */
  systemFontLight: boolean;
}

/** What the anonymous usage count would send right now. */
export interface StatsPreview {
  /** The request, or null when today's has already been sent. */
  request: Record<string, string | boolean> | null;
  endpoint: string;
  /** False in development builds, whatever the setting says. */
  active: boolean;
}

type Unsubscribe = () => void;

/** Everything the interface asks of the mail engine. */
export interface Backend {
  /** True in the desktop app; false for the sample-mail browser preview. */
  real: boolean;
  appInfo(): Promise<AppInfo | null>;

  listAccounts(): Promise<Account[]>;
  addAccount(account: NewAccount): Promise<Account>;
  /** Opens the system browser for Google sign-in, then adds the account. */
  googleSignIn(address: string, displayName: string): Promise<Account>;
  removeAccount(id: number): Promise<void>;
  syncNow(): Promise<void>;

  listFolders(): Promise<Folder[]>;
  setFavorite(folderId: number, favorite: boolean): Promise<void>;
  /** Marks every message of a folder as read; -1 means the inboxes of all accounts. */
  markFolderRead(folderId: number): Promise<void>;
  /** One page of a folder, newest first. `focused` is null outside the inbox. */
  listMessages(folderId: number, focused: boolean | null, limit: number, offset: number, only: "unread" | "flagged" | null): Promise<MessageSummary[]>;
  listPinned(folderId: number, focused: boolean | null): Promise<MessageSummary[]>;
  search(query: string, filters: SearchFilters): Promise<MessageSummary[]>;
  /** Searches message text on the mail servers and downloads matches. Returns how many were fetched. */
  searchServer(query: string, accountId: number | null): Promise<number>;
  /** Fetches the body from the server the first time. */
  getMessage(id: number): Promise<MessageDetail>;
  /** Other messages of the same conversation, oldest first. */
  threadMessages(id: number): Promise<MessageSummary[]>;

  setFlags(id: number, flags: Flags): Promise<void>;
  /** Returns ids that `undoMoves` accepts for a few seconds. */
  moveMessages(ids: number[], target: MoveTarget): Promise<number[]>;
  /** To Deleted items, or permanently when already there. Returns undo ids. */
  deleteMessages(ids: number[]): Promise<number[]>;
  undoMoves(ops: number[]): Promise<number>;
  /** Deletes all mail from this message's sender in its folder. Returns undo ids. */
  sweep(id: number): Promise<number[]>;
  setCategories(id: number, categories: string[]): Promise<void>;
  snooze(id: number, until: number | null): Promise<void>;
  /**
   * Blocks the sender of a message, or everyone at their domain: their inbox mail
   * moves to Junk now and as it arrives. Returns undo ids for the moves.
   */
  blockSender(id: number, wholeDomain: boolean): Promise<number[]>;
  /** Always show this sender in Focused (or Other). */
  setSenderFocus(id: number, focused: boolean): Promise<void>;

  /** Queues a message; returns its outbox id. */
  sendMessage(message: Outgoing): Promise<number>;
  /** Takes a queued message back. False when it has already been sent. */
  cancelSend(id: number): Promise<boolean>;
  /** Saves a draft on this computer; `id` is null for a new one. Returns its id. */
  saveDraft(id: number | null, accountId: number, content: string, messageId: string | null): Promise<number>;
  listDrafts(): Promise<LocalDraft[]>;
  deleteDraft(id: number): Promise<void>;
  /**
   * Asks a mailing's sender to stop: "posted" (request sent directly),
   * "mailed" (an unsubscribe message was queued) or "opened" (their web page was opened).
   */
  unsubscribe(id: number): Promise<"posted" | "mailed" | "opened">;
  suggestContacts(typed: string): Promise<Contact[]>;
  /** Lets the user choose files to attach; returns their paths. */
  pickFiles(): Promise<string[]>;
  /** Asks where to save, then writes the attachment. False when the user cancelled. */
  saveAttachment(id: number, index: number, name: string): Promise<boolean>;
  /** Opens the attachment in the program this computer uses for its type. */
  openAttachment(id: number, index: number, name: string): Promise<void>;
  saveMessage(id: number, name: string): Promise<boolean>;
  /** The complete message as it arrived, headers included. */
  messageSource(id: number): Promise<string>;

  listSignatures(): Promise<SavedSignature[]>;
  saveSignature(signature: SavedSignature): Promise<number>;
  deleteSignature(id: number): Promise<void>;
  signatureDefaults(): Promise<SignatureDefaults[]>;
  setSignatureDefaults(defaults: SignatureDefaults): Promise<void>;

  listRules(): Promise<Rule[]>;
  saveRule(rule: Rule): Promise<number>;
  deleteRule(id: number): Promise<void>;

  statsPreview(): Promise<StatsPreview>;
  /** Tells the engine the first message list is on screen (used only for start-up timing). */
  markReady(): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  openLink(url: string): Promise<void>;
  /** Folders or messages of an account changed. */
  onChanged(listener: (accountId: number) => void): Unsubscribe;
  onProgress(listener: (progress: Progress) => void): Unsubscribe;
  onSendFailed(listener: (failure: SendFailed) => void): Unsubscribe;
}

/** Subscribe to a Tauri event; returns a function that unsubscribes. */
function subscribe<T>(event: string, listener: (payload: T) => void): Unsubscribe {
  const pending = listen<T>(event, (e) => listener(e.payload));
  return () => void pending.then((off) => off());
}

const tauriBackend: Backend = {
  real: true,
  appInfo: () => invoke("app_info"),

  listAccounts: () => invoke("list_accounts"),
  addAccount: (account) => invoke("add_account", { account }),
  googleSignIn: (address, displayName) => invoke("google_sign_in", { address, displayName }),
  removeAccount: (id) => invoke("remove_account", { id }),
  syncNow: () => invoke("sync_now"),

  listFolders: () => invoke("list_folders"),
  setFavorite: (folderId, favorite) => invoke("set_favorite", { folderId, favorite }),
  markFolderRead: (folderId) => invoke("mark_folder_read", { folderId }),
  listMessages: (folderId, focused, limit, offset, only) => invoke("list_messages", { folderId, focused, limit, offset, only }),
  listPinned: (folderId, focused) => invoke("list_pinned", { folderId, focused }),
  search: (query, filters) => invoke("search_messages", { query, filters }),
  searchServer: (query, accountId) => invoke("search_server", { query, accountId }),
  getMessage: (id) => invoke("get_message", { id }),
  threadMessages: (id) => invoke("thread_messages", { id }),

  setFlags: (id, flags) => invoke("set_flags", { id, unread: flags.unread ?? null, flagged: flags.flagged ?? null, pinned: flags.pinned ?? null }),
  moveMessages: (ids, target) =>
    invoke("move_messages", { ids, folderId: "folderId" in target ? target.folderId : null, role: "role" in target ? target.role : null }),
  deleteMessages: (ids) => invoke("delete_messages", { ids }),
  undoMoves: (ops) => invoke("undo_moves", { ops }),
  sweep: (id) => invoke("sweep", { id }),
  setCategories: (id, categories) => invoke("set_categories", { id, categories }),
  snooze: (id, until) => invoke("snooze", { id, until }),
  blockSender: (id, wholeDomain) => invoke("block_sender", { id, wholeDomain }),
  setSenderFocus: (id, focused) => invoke("set_sender_focus", { id, focused }),

  sendMessage: (draft) => invoke("send_message", { draft }),
  cancelSend: (id) => invoke("cancel_send", { id }),
  saveDraft: (id, accountId, content, messageId) => invoke("save_draft", { id, accountId, content, messageId }),
  unsubscribe: (id) => invoke("unsubscribe", { id }),
  listDrafts: () => invoke("list_drafts"),
  deleteDraft: (id) => invoke("delete_draft", { id }),
  suggestContacts: (typed) => invoke("suggest_contacts", { typed }),
  // File dialogs are shown by the engine, which then accepts only what the user chose there.
  pickFiles: () => invoke("pick_attachments"),
  saveAttachment: (id, index, name) => invoke("save_attachment", { id, index, name }),
  openAttachment: (id, index, name) => invoke("open_attachment", { id, index, name }),
  saveMessage: (id, name) => invoke("save_message", { id, name }),
  messageSource: (id) => invoke("message_source", { id }),

  listSignatures: () => invoke("list_signatures"),
  saveSignature: (signature) => invoke("save_signature", { signature }),
  deleteSignature: (id) => invoke("delete_signature", { id }),
  signatureDefaults: () => invoke("signature_defaults"),
  setSignatureDefaults: (defaults) => invoke("set_signature_defaults", { defaults }),

  listRules: () => invoke("list_rules"),
  saveRule: (rule) => invoke("save_rule", { rule }),
  deleteRule: (id) => invoke("delete_rule", { id }),

  statsPreview: () => invoke("stats_preview"),
  markReady: () => invoke("mark_ready"),
  getSetting: (key) => invoke("get_setting", { key }),
  setSetting: (key, value) => invoke("set_setting", { key, value }),

  openLink: (url) => invoke("open_link", { url }),
  onChanged: (listener) => subscribe("mail-changed", listener),
  onProgress: (listener) => subscribe("sync-progress", listener),
  onSendFailed: (listener) => subscribe("send-failed", listener),
};

export const backend: Backend = isTauri() ? tauriBackend : sampleBackend;

/** Rust errors arrive as plain strings; browser errors as Error objects. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
