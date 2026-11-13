/** Keyboard shortcuts use Cmd on a Mac and Ctrl everywhere else. */

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** True when the shortcut key of this system is held: Cmd on macOS, Ctrl elsewhere. */
export function mod(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** How that key is written in hints: "⌘" or "Ctrl". */
export const MOD = isMac ? "⌘" : "Ctrl";
