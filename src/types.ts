/** Shapes shared with the Rust core (src-tauri/src/model.rs). */

export type AccountKind = "gmail" | "imap";

export interface Account {
  id: number;
  address: string;
  displayName: string;
  kind: AccountKind;
  /** The mail server whose sender checks this account trusts; null until enough mail has been seen. */
  authServer: string | null;
}

export type FolderRole = "inbox" | "drafts" | "sent" | "trash" | "junk" | "archive" | "custom";

export interface Folder {
  id: number;
  accountId: number;
  name: string;
  role: FolderRole;
  favorite: boolean;
  unread: number;
}

export interface MessageSummary {
  id: number;
  accountId: number;
  folderId: number;
  folderName: string;
  accountAddress: string;
  fromName: string;
  fromAddress: string;
  to: string;
  subject: string;
  preview: string;
  /** Unix seconds, UTC. */
  date: number;
  unread: boolean;
  flagged: boolean;
  pinned: boolean;
  focused: boolean;
  hasAttachment: boolean;
  /** Colour categories, by name. */
  categories: string[];
  /** Unix seconds; hidden from its folder until then. */
  snoozedUntil: number | null;
  /** The mail server's sender checks, such as "id=mx.example.com;spf=pass;dkim=pass;dmarc=fail"; null when not read yet. */
  auth: string | null;
}

export interface Attachment {
  name: string;
  mimeType: string;
  /** Bytes. */
  size: number;
}

export interface MessageDetail extends MessageSummary {
  cc: string;
  /** Sanitised HTML, when the message has an HTML part. */
  html: string | null;
  plain: string;
  attachments: Attachment[];
  /** Message-ID and References headers, for replying in the same conversation. */
  messageIdHeader: string | null;
  references: string | null;
  /** Recipients as "Name <address>" lists, for Reply all. */
  toAddresses: string;
  ccAddresses: string;
  /** How this mailing can be unsubscribed from, if it says. */
  unsubscribe: "one-click" | "mail" | "link" | null;
  /** Where the unsubscribe request goes: a mail address or a website name. */
  unsubscribeTo: string | null;
}

export type DateFilter = "any" | "past-year" | "older-1y" | "older-2y" | "custom";

export interface SearchFilters {
  accountId: number | null;
  hasAttachment: boolean;
  date: DateFilter;
  /** Unix seconds, used when `date` is "custom". */
  after: number | null;
  before: number | null;
}

export type Security = "tls" | "starttls" | "none";

export interface ServerSettings {
  host: string;
  port: number;
  security: Security;
  username: string;
}

export interface NewAccount {
  address: string;
  displayName: string;
  password: string;
  imap: ServerSettings | null;
  smtp: ServerSettings | null;
}

/** A message being written. */
export interface Draft {
  /** Set once the draft has been saved on this computer. */
  id?: number;
  /** Message-ID of the draft on the server that this one continues and replaces. */
  messageId?: string | null;
  accountId: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** What the user typed, as HTML. */
  html: string;
  /** The quoted original for replies and forwards, as HTML. */
  quote: string;
  inReplyTo: string | null;
  references: string | null;
  /** Paths of files to attach. */
  attachments: string[];
  /** True for replies and forwards, which may use a different default signature. */
  isReply: boolean;
}

/** A draft as the mail engine stores it; `content` is a Draft as JSON. */
export interface LocalDraft {
  id: number;
  accountId: number;
  content: string;
  /** Unix seconds. */
  updatedAt: number;
}

/** A saved draft, ready to open in the composer. */
export type StoredDraft = Draft & { id: number; updatedAt: number };

/** What is handed to the mail engine to send. */
export interface Outgoing {
  accountId: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  inReplyTo: string | null;
  references: string | null;
  attachments: string[];
  /** Pictures inside the message, referred to as `cid:<cid>` in the HTML. */
  inlineImages: { cid: string; dataUrl: string }[];
  /** Unix seconds. */
  sendAt: number;
}

export interface SavedSignature {
  /** 0 until saved. */
  id: number;
  name: string;
  html: string;
  /** Text only, or a picture left of or above the text. */
  layout: "text" | "left" | "above";
  /** The picture as a data URL, or empty. */
  image: string;
}

export interface SignatureDefaults {
  accountId: number;
  newId: number | null;
  replyId: number | null;
}

export interface Contact {
  name: string;
  address: string;
}

export interface Rule {
  /** 0 until saved. */
  id: number;
  name: string;
  enabled: boolean;
  fromContains: string;
  subjectContains: string;
  action: "move" | "category" | "flag" | "read" | "delete";
  target: string;
}

export interface SendFailed {
  id: number;
  subject: string;
  error: string;
}

/** Where to move messages: a folder, or a role such as "archive". */
export type MoveTarget = { folderId: number } | { role: "archive" | "trash" | "junk" | "inbox" };

export interface Progress {
  accountId: number;
  phase: "folders" | "headers" | "bodies" | "idle" | "error";
  done: number;
  total: number;
  message: string;
}

export interface Flags {
  unread?: boolean;
  flagged?: boolean;
  pinned?: boolean;
}
