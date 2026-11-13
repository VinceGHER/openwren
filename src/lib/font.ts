/**
 * The fonts the app can be shown in. Inter ships with the app, so it looks the
 * same on every computer; "system" is whatever the desktop is set to use.
 */
export type FontChoice = "inter" | "nunito" | "system";

export function fontChoice(setting: string | undefined): FontChoice {
  return setting === "nunito" || setting === "system" ? setting : "inter";
}

/** The CSS font family list for a choice. `desktop` is the desktop's own font name, when known. */
export function fontStack(choice: FontChoice, desktop: string): string {
  if (choice === "inter") return '"Inter Variable", system-ui, sans-serif';
  if (choice === "nunito") return '"Nunito Variable", system-ui, sans-serif';
  return `${desktop ? `"${desktop}", ` : ""}system-ui, sans-serif`;
}

/** Text sizes offered in Settings, in pixels. */
export const TEXT_SIZES: [string, string][] = [
  ["14", "Small"],
  ["15", "Medium"],
  ["16", "Large"],
  ["17", "Larger"],
];
