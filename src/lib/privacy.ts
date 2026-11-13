import { brandFor, brands, domainOf } from "./brands";

/**
 * Checks that protect the reader. Everything here runs on this computer on the
 * message itself; nothing is looked up online.
 */

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** The part of a host name that someone registered: "mail.shop.co.uk" gives "shop.co.uk". */
export function registrable(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const keep = labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/**
 * The sender checks of a message (`MessageSummary.auth`, such as
 * "id=mx.example.com;spf=pass;dkim=pass;dmarc=fail"), but only when they were
 * made by `server`, the mail server this account trusts. Results naming any
 * other server may have been written by the sender, so they count for nothing.
 */
function checks(auth: string | null | undefined, server: string | null | undefined): Record<string, string> | null {
  if (!auth || !server) return null;
  const result = Object.fromEntries(auth.split(";").map((part) => part.split("=") as [string, string]));
  return result.id === server ? result : null;
}

/** True when the account's mail server confirmed the sender: DMARC passed, or without a DMARC verdict the DKIM signature did. */
export function senderConfirmed(auth: string | null | undefined, server: string | null | undefined): boolean {
  const result = checks(auth, server);
  if (!result) return false;
  return result.dmarc !== undefined ? result.dmarc === "pass" : result.dkim === "pass";
}

/** A sentence when the account's mail server checked the sender and the checks failed, else null. */
export function authProblem(auth: string | null | undefined, server: string | null | undefined): string | null {
  const result = checks(auth, server);
  if (!result) return null;
  const failed = (["dmarc", "dkim", "spf"] as const).filter((method) => result[method] === "fail").map((m) => m.toUpperCase());
  // DMARC is the verdict. Without one, a failed signature or a refused sending server counts.
  if (result.dmarc === "fail" || (result.dmarc === undefined && failed.length > 0)) {
    return `Your mail server could not confirm who sent this (${failed.length > 2 ? `${failed.slice(0, -1).join(", ")} and ${failed[failed.length - 1]}` : failed.join(" and ")} failed). The sender's address may be forged.`;
  }
  return null;
}

/** Letters of other alphabets that look like Latin ones: Cyrillic "а", Greek "ο" and so on. */
const FOREIGN_LETTER = /[\u0370-\u03ff\u0400-\u052f]/;

/** Decode one "xn--" label of an internet name (RFC 3492). Returns the label unchanged if it is not valid. */
function fromPunycode(label: string): string {
  if (!label.toLowerCase().startsWith("xn--")) return label;
  const input = label.slice(4);
  const split = input.lastIndexOf("-");
  const output = split > 0 ? [...input.slice(0, split)] : [];
  let [n, i, bias] = [128, 0, 72];
  for (let at = split > 0 ? split + 1 : 0; at < input.length; ) {
    const start = i;
    for (let weight = 1, k = 36; ; k += 36) {
      const code = input.charCodeAt(at++);
      const digit = code - 48 < 10 ? code - 22 : code - 65 < 26 ? code - 65 : code - 97 < 26 ? code - 97 : 36;
      if (digit >= 36 || Number.isNaN(code)) return label;
      i += digit * weight;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      weight *= 36 - t;
    }
    const length = output.length + 1;
    let delta = start === 0 ? Math.floor((i - start) / 700) : (i - start) >> 1;
    delta += Math.floor(delta / length);
    let k = 0;
    for (; delta > 455; k += 36) delta = Math.floor(delta / 35);
    bias = k + Math.floor((36 * delta) / (delta + 38));
    n += Math.floor(i / length);
    i %= length;
    output.splice(i++, 0, String.fromCodePoint(n));
  }
  return output.join("");
}

/** An internet name as people would read it: "xn--pypal-4ve.com" becomes "pаypal.com" (with a Cyrillic а). */
export function readableHost(host: string): string {
  return host.split(".").map(fromPunycode).join(".");
}

/**
 * True for a name that mixes in letters of another alphabet under an ordinary
 * ending such as .com: the classic way to imitate a well-known address.
 */
export function lookAlike(host: string): boolean {
  const labels = readableHost(host).split(".");
  const ending = labels[labels.length - 1] ?? "";
  return /^[a-z]+$/i.test(ending) && labels.slice(0, -1).some((label) => FOREIGN_LETTER.test(label));
}

const GENERIC = new Set(
  "support team security service services billing account accounts customer care help info notification notifications news newsletter alerts alert no-reply noreply payments rewards store shop online official mail email inc llc ltd the".split(" "),
);

/**
 * A sender name that claims to be someone the address is not: it shows another
 * email address, or it is the name of a well-known company the address does not belong to.
 */
export function nameProblem(name: string, address: string): string | null {
  const domain = registrable(domainOf(address));
  if (!domain.includes(".")) return null;
  if (lookAlike(domainOf(address))) {
    return `The sender's address ${readableHost(domainOf(address))} contains letters from another alphabet that look like ordinary ones. This is a common way to imitate a known address.`;
  }
  const shown = name.match(/[\w.+-]+@([a-z0-9-]+\.)+[a-z]{2,}/i)?.[0];
  if (shown && registrable(domainOf(shown)) !== domain) {
    return `The sender's name shows the address ${shown}, but this message came from ${address}.`;
  }
  const words = name.toLowerCase().replace(/[^\p{L}\p{N}\s.-]/gu, " ").split(/\s+/).filter(Boolean);
  for (const brand of brands) {
    const title = brand.title.toLowerCase().split(/\s+/);
    if (brand.title.length < 4 || words.length < title.length || !title.every((w, i) => words[i] === w)) continue;
    if (!words.slice(title.length).every((w) => GENERIC.has(w))) continue;
    // The company's own domains, including country ones we do not list (paypal.be).
    const own = brandFor(address) === brand || brand.domains.some((d) => d.split(".")[0] === domain.split(".")[0]);
    if (!own) return `The sender's name says "${brand.title}", but the address ${address} does not belong to ${brand.title}.`;
  }
  return null;
}

const TRACKING_PARAMETER =
  /^(utm_\w+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|__hs\w+|hsctatracking|igshid|mkt_tok|oly_enc_id|oly_anon_id|vero_id|vero_conv|yclid|twclid|ttclid|li_fat_id|s_cid|_openstat|mkwid|pk_\w+|piwik_\w+|ml_subscriber(_hash)?|wickedid|ck_subscriber_id|_ga|_gl|trk\w*)$/i;

/** Addresses that exist only to report that a message was opened. */
const TRACKER_ADDRESS =
  /\/(open|track(ing)?|pixel|beacon|wf\/open|o\.gif|t\.gif|trk|e\/o)([/.?]|$)|list-manage\.com\/track|google-analytics\.com|doubleclick\.net|facebook\.com\/tr|sendgrid\.net\/wf|mailgun\.\w+\/o\/|awstrack\.me|hubspot\w*\.\w+\/e\d|klclick|mandrillapp\.com\/track|\.mcsv\.net\/|sparkpostmail|exct\.net\/open|cmail\d+\.com\/t\//i;

const INVISIBLE = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0+)?\s*(;|$)|(max-)?(width|height)\s*:\s*[01](px)?\s*(!important)?\s*(;|$))/i;

export interface Cleaned {
  html: string;
  /** Hidden images removed because they report when the message is opened. */
  pixels: number;
  /** Links from which tracking parameters were removed. */
  links: number;
  /** Links whose text names one site while they lead to another. */
  mismatches: { shown: string; goes: string }[];
  /** Sites linked to whose names imitate ordinary letters with foreign ones. */
  lookAlikes: string[];
}

function tiny(img: Element): boolean {
  const size = (name: string) => {
    const value = img.getAttribute(name);
    return value !== null && /^\s*[0-2]\s*(px)?\s*$/.test(value);
  };
  return size("width") || size("height") || INVISIBLE.test(img.getAttribute("style") ?? "");
}

/**
 * Remove tracking from mail HTML and find misleading links.
 * `blockTrackers` false leaves the HTML as it is and only inspects the links.
 */
export function cleanMail(html: string, blockTrackers = true): Cleaned {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let pixels = 0;
  let links = 0;
  const mismatches: Cleaned["mismatches"] = [];
  const lookAlikes: string[] = [];
  const mark = (link: Element) => link.setAttribute("style", `${link.getAttribute("style") ?? ""};text-decoration:none;border-bottom:2px solid #e0a23a`);

  if (blockTrackers) {
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      if (/^https?:/i.test(src) && (tiny(img) || TRACKER_ADDRESS.test(src))) {
        img.remove();
        pixels += 1;
      }
    }
  }

  for (const link of Array.from(doc.querySelectorAll("a[href]"))) {
    let target: URL;
    try {
      target = new URL(link.getAttribute("href") ?? "");
    } catch {
      continue;
    }
    if (!/^https?:$/.test(target.protocol)) continue;
    if (blockTrackers) {
      const tracking = [...target.searchParams.keys()].filter((key) => TRACKING_PARAMETER.test(key));
      if (tracking.length > 0) {
        tracking.forEach((key) => target.searchParams.delete(key));
        link.setAttribute("href", target.toString());
        links += 1;
      }
    }
    // Hovering shows where the link really goes.
    link.setAttribute("title", target.toString());
    const text = (link.textContent ?? "").trim();
    const shown = /^(https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/?#]\S*)?$/i.exec(text)?.[2];
    if (shown && registrable(shown) !== registrable(target.hostname) && !mismatches.some((m) => m.shown === shown)) {
      mismatches.push({ shown: shown.toLowerCase(), goes: target.hostname });
      mark(link);
    }
    if (lookAlike(target.hostname)) {
      const name = readableHost(target.hostname);
      if (!lookAlikes.includes(name)) lookAlikes.push(name);
      mark(link);
    }
  }
  return { html: doc.body.innerHTML, pixels, links, mismatches, lookAlikes };
}
