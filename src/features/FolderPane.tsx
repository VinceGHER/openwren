import {
  IconArrowUpCircle,
  IconAlertCircle,
  IconArchive,
  IconCircleCheck,
  IconDots,
  IconFolder,
  IconInbox,
  IconMailOff,
  IconMailOpened,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSettings,
  IconStar,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import logo from "../../src-tauri/icons/128x128.png";
import { ContextMenu } from "../components/ui";
import { ALL_INBOXES, allInboxes, useStore } from "../store";
import { DRAG_TYPE } from "./MessageList";
import type { Folder, FolderRole, Progress } from "../types";

const icons: Record<FolderRole, typeof IconInbox> = {
  inbox: IconInbox,
  drafts: IconPencil,
  sent: IconSend,
  trash: IconTrash,
  junk: IconMailOff,
  archive: IconArchive,
  custom: IconFolder,
};

/** One folder. `label` replaces its name where that alone would be unclear (the pinned ones at the top). */
function FolderRow({ folder, label, pinned }: { folder: Folder; label?: string; pinned?: boolean }) {
  const selected = useStore((s) => s.folderId === folder.id && !s.query.trim());
  const selectFolder = useStore((s) => s.selectFolder);
  const moveMessages = useStore((s) => s.moveMessages);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const markFolderRead = useStore((s) => s.markFolderRead);
  const showToast = useStore((s) => s.showToast);
  const [over, setOver] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // "All inboxes" is not a real folder: nothing can be moved into it or starred.
  const real = folder.id !== ALL_INBOXES;
  // A favourite shown at the top wears a star, so it is not mistaken for the folder in its account.
  const Icon = pinned && real ? IconStar : icons[folder.role];
  const starLabel = folder.favorite ? "Remove from Favorites" : "Add to Favorites";
  return (
    <>
      <button
        type="button"
        onClick={() => selectFolder(folder.id)}
        aria-current={selected}
        title={label ?? folder.name}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        // Messages dragged from the list can be dropped here to move them.
        onDragOver={(e) => {
          if (!real || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const { ids, accountId } = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as { ids: number[]; accountId: number };
          if (accountId !== folder.accountId) showToast("Messages can only be moved within their own account.");
          else void moveMessages(ids, { folderId: folder.id });
        }}
        className={`flex w-full flex-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left ${over ? "bg-soft text-ink" : selected ? "bg-sel text-ink" : "text-ink2 hover:bg-hover"}`}
      >
        <Icon size={18} stroke={1.6} className="flex-none" />
        <span className="truncate">{label ?? folder.name}</span>
        {folder.unread > 0 && <span className="ml-auto pl-1 text-xs text-ink3">{folder.unread}</span>}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: "Mark all as read", icon: <IconMailOpened size={16} />, onSelect: () => void markFolderRead(folder) },
            ...(real ? [{ label: starLabel, icon: <IconStar size={16} />, onSelect: () => void toggleFavorite(folder) }] : []),
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** An account: its address as a quiet label, its standard folders, and the rest behind "More". */
function AccountFolders({ address, folders }: { address: string; folders: Folder[] }) {
  const selectedId = useStore((s) => s.folderId);
  const main = folders.filter((f) => f.role !== "custom");
  const extra = folders.filter((f) => f.role === "custom");
  // Open when the folder being shown is one of the extra ones, so the selection is never hidden.
  const [open, setOpen] = useState(false);
  const shown = open || extra.some((f) => f.id === selectedId);
  return (
    <section className="flex flex-none flex-col gap-px">
      <p className="truncate px-2.5 pt-5 pb-1.5 text-xs text-ink3" title={address}>
        {address}
      </p>
      {main.map((f) => (
        <FolderRow key={f.id} folder={f} />
      ))}
      {extra.length > 0 && (
        <button type="button" onClick={() => setOpen(!shown)} aria-expanded={shown} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-ink2 hover:bg-hover">
          <IconDots size={18} stroke={1.6} className="flex-none" />
          {shown ? "Less" : "More"}
        </button>
      )}
      {shown && extra.map((f) => <FolderRow key={f.id} folder={f} />)}
    </section>
  );
}

/** One line describing what sync is doing for an account. */
export function statusText(p: Progress | undefined): string {
  if (!p) return "";
  switch (p.phase) {
    case "folders":
      return "Checking folders…";
    case "headers":
      return `Syncing ${p.message}: ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`;
    case "bodies":
      return `Downloading mail text: ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`;
    case "idle":
      return "Up to date";
    case "error":
      return p.message;
  }
}

/** Shown above the sync line when a newer version exists. Opens Settings, About. */
function UpdateNotice() {
  const update = useStore((s) => s.update);
  const setDialog = useStore((s) => s.setDialog);
  if (!update) return null;
  return (
    <button
      type="button"
      onClick={() => setDialog("settings", "about")}
      title={`OpenWren ${update.version} is available`}
      className="mt-auto flex w-full flex-none items-center gap-2 rounded-lg bg-brand/10 px-2.5 py-2 text-left text-xs font-medium text-brand hover:bg-brand/15"
    >
      <IconArrowUpCircle size={16} stroke={1.8} className="flex-none" />
      <span className="truncate">Update available: {update.version}</span>
    </button>
  );
}

/** The line at the bottom of the sidebar: what sync is doing. Clicking it syncs now. */
function SyncStatus() {
  const syncNow = useStore((s) => s.syncNow);
  const progress = useStore((s) => s.progress);
  const hasUpdate = useStore((s) => s.update !== null);
  const all = Object.values(progress);
  const failed = all.find((p) => p.phase === "error");
  const busy = all.find((p) => p.phase !== "idle" && p.phase !== "error");
  const text = failed ? statusText(failed) : busy ? statusText(busy) : "Up to date";
  const Icon = failed ? IconAlertCircle : busy ? IconRefresh : IconCircleCheck;
  return (
    <button type="button" onClick={syncNow} title={`${text}. Click to sync now.`} className={`flex w-full flex-none items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-hover ${hasUpdate ? "mt-1" : "mt-auto"} ${failed ? "text-danger" : "text-ink3"}`}>
      <Icon size={16} stroke={1.6} className={`flex-none ${busy && !failed ? "animate-spin" : ""}`} />
      <span className="truncate" role="status">
        {text}
      </span>
    </button>
  );
}

export function FolderPane({ width }: { width: number }) {
  const compose = useStore((s) => s.compose);
  const accounts = useStore((s) => s.accounts);
  const folders = useStore((s) => s.folders);
  const setDialog = useStore((s) => s.setDialog);
  const favorites = folders.filter((f) => f.favorite && f.role !== "inbox");
  // With several accounts, a folder name alone does not say whose it is.
  const owner = (f: Folder) => (accounts.length > 1 ? `${f.name} · ${accounts.find((a) => a.id === f.accountId)?.address ?? ""}` : undefined);
  return (
    <nav className="flex flex-none flex-col gap-px overflow-y-auto bg-card px-2.5 pt-3.5 pb-2" style={{ width }} aria-label="Folders">
      <div className="mb-3 flex flex-none items-center gap-2 pr-0.5 pl-2">
        <img src={logo} alt="" className="size-[22px]" />
        <span className="truncate text-[17px] text-ink">OpenWren</span>
        <button type="button" aria-label="Settings" title="Settings" onClick={() => setDialog("settings")} className="ml-auto rounded-lg p-1.5 text-ink3 hover:bg-hover hover:text-ink">
          <IconSettings size={18} stroke={1.6} />
        </button>
      </div>
      <button type="button" onClick={() => compose()} className="mb-3 flex h-10 w-full flex-none items-center justify-center gap-2 rounded-[10px] bg-soft text-brand hover:brightness-[0.97]">
        <IconPencil size={18} stroke={1.6} />
        New mail
      </button>
      {accounts.length > 0 && <FolderRow folder={allInboxes(folders)} />}
      {favorites.map((f) => (
        <FolderRow key={`fav-${f.id}`} folder={f} label={owner(f)} pinned />
      ))}
      {accounts.map((a) => (
        <AccountFolders key={a.id} address={a.address} folders={folders.filter((f) => f.accountId === a.id)} />
      ))}
      {accounts.length === 0 && (
        <button type="button" onClick={() => setDialog("add-account")} className="mt-2 flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-brand hover:bg-hover">
          <IconPlus size={18} stroke={1.6} />
          Add account
        </button>
      )}
      <UpdateNotice />
      <SyncStatus />
    </nav>
  );
}
