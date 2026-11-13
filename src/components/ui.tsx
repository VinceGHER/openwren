import { useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { highlight } from "../lib/search";
import { brandFor, isLight } from "../lib/brands";
import { senderConfirmed } from "../lib/privacy";
import { useStore } from "../store";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" };

const variants = {
  default: "border-edge bg-card text-ink hover:bg-hover",
  primary: "border-line bg-soft text-on-soft font-semibold hover:brightness-[0.97]",
  ghost: "border-transparent text-ink2 hover:bg-hover",
};

export function Button({ variant = "default", className = "", ...rest }: BtnProps) {
  return (
    <button
      type={rest.type ?? "button"}
      className={`inline-flex h-[34px] items-center gap-1.5 rounded-full border px-3.5 whitespace-nowrap ${variants[variant]} ${className}`}
      {...rest}
    />
  );
}

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean };

/** Square icon-only button; `label` is the accessible name and tooltip. */
export function IconButton({ label, active, className = "", children, ...rest }: IconBtnProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`inline-flex size-8 items-center justify-center rounded-lg hover:bg-hover ${active ? "text-brand" : "text-ink2"} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean };

export function Chip({ on, className = "", ...rest }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] whitespace-nowrap ${
        on ? "border-line bg-soft font-semibold text-on-soft" : "border-edge bg-card text-ink2 hover:bg-hover"
      } ${className}`}
      {...rest}
    />
  );
}

/**
 * The sender's picture: a company logo when the address belongs to a
 * well-known company and the account's mail server confirmed the sender,
 * else initials. An address alone proves nothing: anyone can write one.
 */
export function Avatar({ name, address, auth, accountId }: { name: string; address?: string; auth?: string | null; accountId?: number }) {
  const logos = useStore((s) => s.settings.brand_logos !== "off");
  const server = useStore((s) => s.accounts.find((a) => a.id === accountId)?.authServer);
  const brand = logos && address && senderConfirmed(auth, server) ? brandFor(address) : undefined;
  if (brand) {
    return (
      <div className="flex size-8 flex-none items-center justify-center rounded-full" style={{ background: `#${brand.hex}` }} title={brand.title}>
        <svg viewBox="0 0 24 24" className="size-[17px]" fill={isLight(brand.hex) ? "#1f2328" : "#fff"} role="img" aria-label={`${brand.title} logo`}>
          <path d={brand.path} />
        </svg>
      </div>
    );
  }
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className="flex size-8 flex-none items-center justify-center rounded-full bg-chip text-xs text-ink2">
      {initials}
    </div>
  );
}

/** Text with search matches highlighted. */
export function Marked({ text, query }: { text: string; query: string }): ReactNode {
  if (!query) return text;
  return highlight(text, query).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text));
}

export function Divider() {
  return <span className="mx-1.5 h-5 w-px flex-none bg-edge" />;
}

interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  checked?: boolean;
}

/**
 * One entry of a menu: an action, a group that opens in place ("Move to"),
 * a custom row (the colour dots), or a dividing line.
 */
export type MenuItem = MenuAction | { label: string; icon?: ReactNode; submenu: MenuAction[] } | { custom: (close: () => void) => ReactNode } | "divider";

const menuRow = "flex w-full items-center gap-2 px-3 py-1.5 text-left whitespace-nowrap hover:bg-hover";

/** A menu entry that opens a short list right under itself, so long lists do not crowd the menu. */
function SubMenu({ label, icon, items, close }: { label: string; icon?: ReactNode; items: MenuAction[]; close: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" role="menuitem" aria-expanded={open} onClick={() => setOpen(!open)} className={`${menuRow} text-ink`}>
        <span className="flex w-[18px] flex-none justify-center text-ink2">{icon}</span>
        {label}
        <span className="ml-auto pl-4 text-ink3">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="max-h-56 overflow-y-auto border-y border-edge bg-canvas py-1">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                item.onSelect();
              }}
              className="block w-full truncate py-1 pr-3 pl-[38px] text-left text-[13px] text-ink hover:bg-hover"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function MenuList({ items, close }: { items: MenuItem[]; close: () => void }) {
  return (
    <>
      {items.map((item, i) =>
        item === "divider" ? (
          <div key={i} className="my-1 h-px bg-edge" />
        ) : "custom" in item ? (
          <div key={i}>{item.custom(close)}</div>
        ) : "submenu" in item ? (
          <SubMenu key={i} label={item.label} icon={item.icon} items={item.submenu} close={close} />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              item.onSelect();
            }}
            className={`${menuRow} ${item.danger ? "text-danger" : "text-ink"}`}
          >
            <span className="flex w-[18px] flex-none justify-center text-ink2">{item.checked ? "✓" : item.icon}</span>
            {item.label}
          </button>
        ),
      )}
    </>
  );
}

const popup = "z-30 min-w-48 rounded-[10px] border border-edge bg-card py-1 shadow-lg";

/** A button that opens a small menu below it. */
export function Menu({ label, button, items, align = "left" }: { label: string; button: ReactNode; items: MenuItem[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={root} className="relative inline-flex">
      <IconButton label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="w-auto min-w-8 px-1.5">
        {button}
      </IconButton>
      {open && (
        <div role="menu" className={`absolute top-full mt-1 ${align === "right" ? "right-0" : "left-0"} ${popup}`}>
          <MenuList items={items} close={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** A menu at a point on screen, for right-clicks. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  // Keep the menu on screen near the bottom and right edges.
  const left = Math.min(x, window.innerWidth - 230);
  const top = Math.min(y, window.innerHeight - items.length * 32 - 16);
  return (
    <div className="fixed inset-0 z-30" onMouseDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())}>
      <div role="menu" className={`fixed ${popup}`} style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
        <MenuList items={items} close={onClose} />
      </div>
    </div>
  );
}

export const categories: Record<string, string> = {
  Red: "#e5484d",
  Orange: "#f2994a",
  Yellow: "#e2b93b",
  Green: "#3fa66a",
  Blue: "#378add",
  Purple: "#8e6ad8",
};

export function CategoryDot({ name }: { name: string }) {
  return <span title={name} aria-label={`${name} category`} className="inline-block size-2.5 flex-none rounded-full" style={{ background: categories[name] ?? "#999" }} />;
}

export const fieldBox = "h-9 w-full rounded-[10px] border border-edge bg-card px-2.5 outline-none focus:border-line placeholder:text-ink3";
export const fieldCaption = "mb-1 block text-xs text-ink2";
