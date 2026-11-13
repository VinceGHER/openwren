import { type Brand, brands } from "./brandIcons";

const byDomain = new Map<string, Brand>();
for (const brand of brands) for (const domain of brand.domains) byDomain.set(domain, brand);

/** The part of an address after the @, in lower case. */
export function domainOf(address: string): string {
  return (address.split("@").pop() ?? "").trim().toLowerCase();
}

/**
 * The company whose logo may be shown for this address: its domain, or a
 * parent of it, is on the bundled list. Matching is by domain only, never by
 * the sender's name, which anyone can choose.
 */
export function brandFor(address: string): Brand | undefined {
  const labels = domainOf(address).split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const brand = byDomain.get(labels.slice(i).join("."));
    if (brand) return brand;
  }
  return undefined;
}

/** True when a brand colour is light, so its logo needs a dark drawing on top. */
export function isLight(hex: string): boolean {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

export { brands };
export type { Brand };
