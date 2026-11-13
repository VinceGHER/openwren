import { searchMessages } from "../lib/search";
import type { Account, Flags, Folder, FolderRole, LocalDraft, MessageDetail, Rule, SavedSignature, SignatureDefaults } from "../types";
import type { Backend } from "./index";

/**
 * In-memory backend with fake mail, used when the interface runs in a plain
 * browser (pnpm dev) instead of inside the desktop app.
 */

const accounts: Account[] = [
  { id: 1, address: "katy@gmail.com", displayName: "Katy Reid", kind: "gmail", authServer: "mx.example.com" },
  { id: 2, address: "katy@work.com", displayName: "Katy Reid", kind: "imap", authServer: "mx.example.com" },
  { id: 3, address: "katy@oldmail.net", displayName: "Katy Reid", kind: "imap", authServer: "mx.example.com" },
];

const roles: [FolderRole, string][] = [
  ["inbox", "Inbox"],
  ["drafts", "Drafts"],
  ["sent", "Sent items"],
  ["trash", "Deleted items"],
  ["junk", "Junk email"],
  ["archive", "Archive"],
];

type BareFolder = Omit<Folder, "unread">;
const folders: BareFolder[] = accounts.flatMap((a) =>
  roles.map(([role, name], i) => ({ id: a.id * 10 + i, accountId: a.id, name, role, favorite: role === "inbox" && a.id === 1 })),
);
folders.push({ id: 19, accountId: 1, name: "Invoices", role: "custom", favorite: true });

const folderId = (accountId: number, role: FolderRole) => folders.find((f) => f.accountId === accountId && f.role === role)!.id;

const now = new Date();
/** A time `days` days ago at the given clock time, in Unix seconds. */
function ago(days: number, h: number, m: number): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, h, m);
  // Keep "today" messages in the past even early in the morning.
  return Math.floor((d > now ? now.getTime() - 60_000 : d.getTime()) / 1000);
}
const on = (y: number, mo: number, d: number, h = 9, mi = 2) => Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);

interface Seed {
  from: string;
  subject: string;
  body: string[];
  date: number;
  account?: number;
  folder?: number;
  to?: string;
  html?: string;
  unread?: boolean;
  pinned?: boolean;
  flagged?: boolean;
  focused?: boolean;
  files?: [string, number][];
  address?: string;
  auth?: string;
  unsubscribe?: MessageDetail["unsubscribe"];
}

let nextId = 0;
function make(s: Seed): MessageDetail {
  nextId += 1;
  const accountId = s.account ?? 1;
  const plain = s.body.join("\n\n");
  return {
    id: nextId,
    accountId,
    folderId: s.folder ?? folderId(accountId, "inbox"),
    folderName: "",
    accountAddress: accounts.find((a) => a.id === accountId)!.address,
    fromName: s.from,
    fromAddress: s.address ?? `${s.from.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
    auth: s.auth ?? "id=mx.example.com;spf=pass;dkim=pass;dmarc=pass",
    unsubscribeTo: s.unsubscribe ? "spotify.com" : null,
    unsubscribe: s.unsubscribe ?? null,
    to: s.to ?? "you",
    cc: "",
    subject: s.subject,
    preview: s.body.join(" "),
    html: s.html ?? null,
    plain,
    date: s.date,
    unread: s.unread ?? false,
    pinned: s.pinned ?? false,
    flagged: s.flagged ?? false,
    focused: s.focused ?? true,
    categories: [],
    snoozedUntil: null,
    messageIdHeader: `sample-${nextId}@openwren.test`,
    references: null,
    toAddresses: "Katy Reid <katy@work.com>",
    ccAddresses: "",
    hasAttachment: (s.files ?? []).length > 0,
    attachments: (s.files ?? []).map(([name, size]) => ({ name, size, mimeType: "application/pdf" })),
  };
}

const messages: MessageDetail[] = [
  make({ from: "Amanda Brady", subject: "Team pictures", body: ["We look forward to meeting our fall interns. Here are the pictures from the team day.", "Amanda"], date: ago(0, 8, 46), pinned: true, files: [["team-day.zip", 18_900_000]] }),
  make({ from: "Laurence Gilbertson", subject: "September expense reports", body: ["Hello,", "Please see the updated instructions for expense reports. The deadline moves to the 20th.", "Laurence"], date: ago(0, 11, 58), unread: true }),
  make({
    from: "Mona Kane",
    to: "you; Cameron Evans",
    subject: "Event announcement content",
    body: ["Hi team,", "I hope you're all doing well. Here's the draft of the announcement for next week's event. Let me know if anything should change before Friday.", "Thanks,\nMona"],
    html: '<p>Hi team,</p><p>I hope you\'re all doing well. Here\'s the <b>draft</b> of the announcement for next week\'s event. Details are on <a href="https://example.com/event">the event page</a>.</p><p><img src="https://example.com/banner.png" alt="Event banner" width="320" height="80"></p><p>Thanks,<br>Mona</p>',
    date: ago(0, 11, 11),
    files: [["announcement-draft.pdf", 217_000]],
  }),
  make({
    from: "PayPal Security",
    address: "alerts@paypal-account-check.example",
    auth: "id=mx.example.com;spf=fail;dkim=fail;dmarc=fail",
    subject: "Your account is limited",
    body: ["We noticed unusual activity. Confirm your details at www.paypal.com to restore access."],
    html: '<p>We noticed unusual activity.</p><p>Confirm your details at <a href="https://paypal-account-check.example/login">www.paypal.com</a> to restore access.</p>',
    date: ago(0, 9, 30),
    unread: true,
  }),
  make({
    from: "Spotify",
    address: "no-reply@spotify.com",
    subject: "Your week in music",
    body: ["Your top songs this week are ready.", "Open your playlist to listen."],
    html: '<p>Your top songs this week are ready.</p><p><a href="https://open.spotify.com/playlist/37i9?utm_source=email&utm_campaign=weekly&si=abc">Open your playlist</a></p><img src="https://tracking.spotify.example/open?id=42" width="1" height="1"><img src="https://wl.spotify.example/pixel.gif" style="display:none">',
    date: ago(0, 7, 5),
    focused: false,
    unsubscribe: "one-click",
  }),
  // Well-known senders, confirmed by the mail server, so their logos show.
  make({
    from: "GitHub",
    address: "notifications@github.com",
    subject: "[openwren] Pull request merged: faster folder lists",
    body: ["Your pull request was merged into main.", "All checks have passed."],
    html: '<p>Your pull request <b>Faster folder lists</b> was merged into <code>main</code>.</p><p>All checks have passed. <a href="https://github.com/">View it on GitHub</a></p>',
    date: ago(0, 11, 42),
    unread: true,
  }),
  make({
    from: "Stripe",
    address: "receipts@stripe.com",
    subject: "Your payout of 1,240.00 euros is on its way",
    body: ["A payout of 1,240.00 euros was sent to your bank account. It should arrive within two working days."],
    date: ago(0, 10, 15),
    files: [["payout-november.pdf", 64_000]],
  }),
  make({
    from: "Google",
    address: "no-reply@accounts.google.com",
    subject: "Security alert: new sign-in on Linux",
    body: ["We noticed a new sign-in to your Google Account on a Linux device. If this was you, you don't need to do anything."],
    date: ago(0, 9, 48),
    unread: true,
  }),
  make({
    from: "Figma",
    address: "notifications@figma.com",
    subject: "Mona commented on Event poster",
    body: ["Mona Kane left a comment: \"Can we try the blue for the headline?\""],
    date: ago(0, 9, 2),
  }),
  make({
    from: "Airbnb",
    address: "express@airbnb.com",
    subject: "Your reservation in Lisbon is confirmed",
    body: ["You're going to Lisbon. Check-in is on Friday after 15:00. Your host has sent the arrival details."],
    date: ago(0, 8, 20),
    flagged: true,
  }),
  make({
    from: "Notion",
    address: "notify@notion.so",
    subject: "Cameron invited you to Planning 2027",
    body: ["Cameron Evans invited you to edit the page Planning 2027."],
    date: ago(0, 7, 40),
    focused: false,
  }),
  make({
    from: "Netflix",
    address: "info@members.netflix.com",
    subject: "New this week for you",
    body: ["A new season of a series you watched is out now, and three films were added to your list."],
    date: ago(0, 6, 50),
    focused: false,
    unsubscribe: "one-click",
  }),
  make({
    from: "Uber",
    address: "noreply@uber.com",
    subject: "Your Thursday evening trip",
    body: ["Thanks for riding. Your trip from the station to Harbour Street cost 11.40 euros."],
    date: ago(1, 21, 14),
    focused: false,
  }),
  make({
    from: "Dropbox",
    address: "no-reply@dropbox.com",
    subject: "Elvia shared a folder with you",
    body: ["Elvia Atkins shared the folder Workshop photos with you."],
    date: ago(1, 12, 5),
  }),
  make({
    from: "Booking.com",
    address: "noreply@booking.com",
    subject: "Your stay in Copenhagen: one week to go",
    body: ["Your stay starts next Friday. Free cancellation ends on Tuesday."],
    date: ago(2, 9, 30),
    focused: false,
  }),
  make({ from: "Cameron Evans", subject: "Planning session", body: ["Let's get together and discuss the agenda for the planning session. Does Thursday work?", "Cameron"], date: ago(0, 10, 38), unread: true }),
  make({ from: "Elvia Atkins", subject: "Project tracker design doc", body: ["The project tracker is comprehensive and user-friendly. A few comments are in the document.", "Elvia"], date: ago(1, 15, 55) }),
  make({ from: "Kadji Bell", subject: "Research project update", body: ["I hope this email finds you well. I wanted to share where the research project stands.", "Kadji"], date: ago(1, 14, 21), flagged: true }),
  make({ from: "City Library", subject: "Your loans are due soon", body: ["Two items are due back on Friday. You can renew them online."], date: ago(3, 7, 30), focused: false }),
  make({ from: "Trainline Deals", subject: "Autumn fares from 19 euros", body: ["Book early and save on trips this autumn."], date: ago(0, 6, 5), focused: false, unread: true }),
  make({ from: "Hosting Support", subject: "Scheduled maintenance on Sunday", body: ["Your server will restart during a short maintenance window on Sunday morning."], date: ago(9, 16, 40), focused: false }),
  make({ from: "Kadji Bell", folder: 19, subject: "Invoice for workshop", body: ["Hi Katy,", "Here is the invoice for the June workshop. Thank you for having me.", "Kadji"], date: on(2024, 6, 7, 14, 12), files: [["workshop-invoice.pdf", 75_000]] }),
  make({ from: "Hosting Support", folder: folderId(1, "archive"), subject: "Your yearly invoice", body: ["Your hosting plan was renewed for another year. The invoice is attached."], date: on(2025, 3, 2, 3, 15), files: [["hosting-2025.pdf", 52_000]] }),
  make({ from: "Nordic Print", account: 2, subject: "Invoice 2025-0914", body: ["Hello Katy,", "Attached is your invoice for the September print order. Payment is due within 30 days.", "Nordic Print"], date: on(2025, 9, 14), files: [["invoice-0914.pdf", 98_000]] }),
  make({ from: "Elvia Atkins", account: 2, folder: folderId(2, "sent"), subject: "Re: corrected invoice", body: ["Thanks, the corrected invoice looks right now. I've passed it to finance.", "Elvia"], date: on(2024, 11, 19, 10, 44) }),
  make({ from: "Nordic Print", account: 2, subject: "Invoice 2023-1102", body: ["Hello Katy,", "Attached is your invoice for the November print order."], date: on(2023, 11, 2), files: [["invoice-1102.pdf", 90_000]] }),
  make({ from: "Mona Kane", account: 2, subject: "Welcome to the team", body: ["Welcome aboard, Katy. Your first-week schedule is attached.", "Mona"], date: on(2022, 4, 4, 8, 30), files: [["first-week.pdf", 123_000]] }),
  make({ from: "ISP Billing", account: 3, subject: "Your broadband invoice", body: ["Your monthly broadband invoice is ready."], date: on(2024, 2, 1, 6, 0), focused: false }),
];

const listeners = new Set<(accountId: number) => void>();
const changed = (accountId: number) => listeners.forEach((l) => l(accountId));
const named = (m: MessageDetail): MessageDetail => ({ ...m, folderName: folders.find((f) => f.id === m.folderId)?.name ?? "" });
const newestFirst = (a: MessageDetail, b: MessageDetail) => b.date - a.date;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const inFolder = (id: number, focused: boolean | null) =>
  messages
    // Folder -1 is "All inboxes".
    .filter((m) => (id === -1 ? folders.find((f) => f.id === m.folderId)?.role === "inbox" : m.folderId === id))
    .filter((m) => (focused === null || m.focused === focused) && (m.snoozedUntil === null || m.snoozedUntil <= nowSeconds()))
    .sort(newestFirst)
    .map(named);
const find = (id: number) => messages.find((m) => m.id === id);
const desktopOnly = (what: string) => new Error(`${what} works in the desktop app. This browser preview uses sample mail.`);

// Moves that can still be undone: operation id -> where the message was.
const undoable = new Map<number, { id: number; folderId: number }>();
let nextOp = 0;
function moveTo(id: number, target: number): number[] {
  const m = find(id);
  if (!m || m.folderId === target) return [];
  nextOp += 1;
  undoable.set(nextOp, { id, folderId: m.folderId });
  m.folderId = target;
  m.pinned = false;
  return [nextOp];
}

let signatures: SavedSignature[] = [
  { id: 1, name: "Work", html: "<p>Kind regards,<br><strong>Katy Reid</strong><br>Operations lead · Contoso<br>+31 20 555 0142 · contoso.example</p>", layout: "text", image: "" },
  { id: 2, name: "Personal", html: "<p>Cheers,<br>Katy</p>", layout: "text", image: "" },
  { id: 3, name: "Short reply", html: "<p>Katy</p>", layout: "text", image: "" },
];
let defaults: SignatureDefaults[] = [
  { accountId: 1, newId: 2, replyId: 3 },
  { accountId: 2, newId: 1, replyId: 3 },
];
let rules: Rule[] = [{ id: 1, name: "Train deals to Archive", enabled: true, fromContains: "trainline", subjectContains: "", action: "move", target: "Archive" }];
const settings = new Map<string, string>();
const outbox = new Map<number, ReturnType<typeof setTimeout>>();
let nextLocal = 100;
let drafts: LocalDraft[] = [];

export const sampleBackend: Backend = {
  real: false,
  appInfo: async () => null,

  listAccounts: async () => accounts,
  addAccount: async () => {
    throw desktopOnly("Adding accounts");
  },
  googleSignIn: async () => {
    throw desktopOnly("Google sign-in");
  },
  removeAccount: async () => {
    throw desktopOnly("Removing accounts");
  },
  syncNow: async () => {},

  listFolders: async () => folders.map((f) => ({ ...f, unread: messages.filter((m) => m.folderId === f.id && m.unread).length })),
  listMessages: async (id, focused, limit, offset, only) =>
    inFolder(id, focused)
      .filter((m) => only === null || (only === "unread" ? m.unread : m.flagged))
      .slice(offset, offset + limit),
  listPinned: async (id, focused) => inFolder(id, focused).filter((m) => m.pinned),
  search: async (query, filters) => searchMessages(messages, query, filters, new Date()).map(named),
  setFavorite: async (id, favorite) => {
    const f = folders.find((x) => x.id === id);
    if (f) f.favorite = favorite;
    changed(0);
  },
  markFolderRead: async (id) => {
    for (const m of messages) {
      if (id === -1 ? folders.find((f) => f.id === m.folderId)?.role === "inbox" : m.folderId === id) m.unread = false;
    }
    changed(0);
  },
  searchServer: async () => 0,
  getMessage: async (id) => {
    const m = find(id);
    if (!m) throw new Error("This message no longer exists.");
    return named(m);
  },
  threadMessages: async (id) => {
    const m = find(id);
    if (!m) return [];
    const key = (x: MessageDetail) => x.references?.split(" ")[0] ?? x.messageIdHeader;
    return messages.filter((x) => x.accountId === m.accountId && key(x) === key(m)).sort((a, b) => a.date - b.date).map(named);
  },

  unsubscribe: async () => "posted",
  saveDraft: async (id, accountId, content) => {
    const saved = { id: id ?? nextLocal++, accountId, content, updatedAt: Math.floor(Date.now() / 1000) };
    drafts = [saved, ...drafts.filter((d) => d.id !== saved.id)];
    return saved.id;
  },
  listDrafts: async () => drafts,
  deleteDraft: async (id) => {
    drafts = drafts.filter((d) => d.id !== id);
  },

  setFlags: async (id, flags: Flags) => {
    const m = find(id);
    if (!m) return;
    Object.assign(m, flags);
    changed(m.accountId);
  },
  moveMessages: async (ids, target) => {
    const ops = ids.flatMap((id) => {
      const m = find(id);
      if (!m) return [];
      return moveTo(id, "folderId" in target ? target.folderId : folderId(m.accountId, target.role));
    });
    changed(0);
    return ops;
  },
  deleteMessages: async (ids) => {
    const ops = ids.flatMap((id) => {
      const m = find(id);
      if (!m) return [];
      const trash = folderId(m.accountId, "trash");
      if (m.folderId === trash) {
        messages.splice(messages.indexOf(m), 1); // already in Deleted items: gone for good
        return [];
      }
      return moveTo(id, trash);
    });
    changed(0);
    return ops;
  },
  undoMoves: async (ops) => {
    let undone = 0;
    for (const op of ops) {
      const was = undoable.get(op);
      const m = was && find(was.id);
      if (was && m) {
        m.folderId = was.folderId;
        undoable.delete(op);
        undone += 1;
      }
    }
    changed(0);
    return undone;
  },
  sweep: async (id) => {
    const m = find(id);
    if (!m) return [];
    const same = messages.filter((x) => x.folderId === m.folderId && x.fromAddress === m.fromAddress).map((x) => x.id);
    return sampleBackend.deleteMessages(same);
  },
  setCategories: async (id, categories) => {
    const m = find(id);
    if (m) m.categories = categories;
    changed(0);
  },
  snooze: async (id, until) => {
    const m = find(id);
    if (m) m.snoozedUntil = until;
    changed(0);
  },
  blockSender: async (id, wholeDomain) => {
    const m = find(id);
    if (!m) return [];
    const list: string[] = JSON.parse(settings.get("blocked_senders") ?? "[]");
    const entry = wholeDomain ? `@${m.fromAddress.split("@").pop()}` : m.fromAddress.toLowerCase();
    if (!list.includes(entry)) settings.set("blocked_senders", JSON.stringify([...list, entry]));
    for (const x of messages) {
      const hit = wholeDomain ? x.fromAddress.endsWith(entry) : x.fromAddress.toLowerCase() === entry;
      if (hit && folders.find((f) => f.id === x.folderId)?.role === "inbox") x.folderId = folderId(x.accountId, "junk");
    }
    changed(0);
    return [];
  },
  setSenderFocus: async (id, focused) => {
    const m = find(id);
    if (!m) return;
    messages.filter((x) => x.fromAddress === m.fromAddress).forEach((x) => (x.focused = focused));
    changed(0);
  },

  sendMessage: async (out) => {
    nextLocal += 1;
    const id = nextLocal;
    const account = accounts.find((a) => a.id === out.accountId)!;
    const delay = Math.max(0, out.sendAt * 1000 - Date.now());
    outbox.set(
      id,
      setTimeout(() => {
        outbox.delete(id);
        const text = out.html.replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").trim();
        messages.push({
          ...make({ from: account.displayName, subject: out.subject, body: [text], date: nowSeconds(), account: account.id, folder: folderId(account.id, "sent"), to: out.to, html: out.html }),
          fromAddress: account.address,
        });
        changed(account.id);
      }, delay),
    );
    return id;
  },
  cancelSend: async (id) => {
    const timer = outbox.get(id);
    if (timer === undefined) return false;
    clearTimeout(timer);
    outbox.delete(id);
    return true;
  },
  suggestContacts: async (typed) => {
    const t = typed.trim().toLowerCase();
    const seen = new Map<string, string>();
    for (const m of messages) if (m.focused) seen.set(m.fromAddress, m.fromName);
    return [...seen].filter(([address, name]) => address.includes(t) || name.toLowerCase().includes(t)).slice(0, 8).map(([address, name]) => ({ address, name }));
  },
  pickFiles: async () => {
    throw desktopOnly("Attaching files");
  },
  messageSource: async (id) => {
    const m = find(id);
    if (!m) throw new Error("This message no longer exists.");
    const headers = [
      "Return-Path: <" + m.fromAddress + ">",
      "Authentication-Results: " + (m.auth ?? "").replace("id=", "").replace(/;/g, "; "),
      "From: " + m.fromName + " <" + m.fromAddress + ">",
      "To: " + m.to,
      "Subject: " + m.subject,
      "Date: " + new Date(m.date * 1000).toUTCString(),
      "Message-ID: <sample-" + m.id + "@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: " + (m.html ? "text/html" : "text/plain") + "; charset=utf-8",
    ];
    return headers.join("\r\n") + "\r\n\r\n" + (m.html ?? m.plain);
  },
  markReady: async () => {},
  statsPreview: async () => ({
    request: { v: "0.1.0", pkg: "deb", os: "ubuntu-24.04", arch: "x86_64", d: true, w: true, m: false, first: false, iw: "2026-W46" },
    endpoint: "https://stats.openwren.app/ping",
    active: false,
  }),
  openPickedFile: async () => {},
  openAttachment: async () => {
    throw desktopOnly("Opening attachments");
  },
  saveAttachment: async () => {
    throw desktopOnly("Saving attachments");
  },
  saveMessage: async () => {
    throw desktopOnly("Saving messages");
  },

  listSignatures: async () => signatures,
  saveSignature: async (signature) => {
    if (signature.id === 0) {
      nextLocal += 1;
      signatures = [...signatures, { ...signature, id: nextLocal }];
      return nextLocal;
    }
    signatures = signatures.map((s) => (s.id === signature.id ? signature : s));
    return signature.id;
  },
  deleteSignature: async (id) => {
    signatures = signatures.filter((s) => s.id !== id);
  },
  signatureDefaults: async () => defaults,
  setSignatureDefaults: async (d) => {
    defaults = [...defaults.filter((x) => x.accountId !== d.accountId), d];
  },

  listRules: async () => rules,
  saveRule: async (rule) => {
    if (rule.id === 0) {
      nextLocal += 1;
      rules = [...rules, { ...rule, id: nextLocal }];
      return nextLocal;
    }
    rules = rules.map((r) => (r.id === rule.id ? rule : r));
    return rule.id;
  },
  deleteRule: async (id) => {
    rules = rules.filter((r) => r.id !== id);
  },

  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },

  openLink: async (url) => {
    window.open(url, "_blank", "noopener");
  },
  onChanged: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onProgress: () => () => {},
  onSendFailed: () => () => {},
};
