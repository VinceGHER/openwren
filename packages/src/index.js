// Read-only file server for the package repositories kept in an R2 bucket.
// apt and dnf only ever GET or HEAD a path; everything else is refused.

const TYPES = {
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
  dmg: "application/x-apple-diskimage",
  AppImage: "application/vnd.appimage",
  json: "application/json",
  sig: "text/plain; charset=utf-8",
  exe: "application/vnd.microsoft.portable-executable",
  gz: "application/gzip",
  xml: "application/xml",
  asc: "text/plain; charset=utf-8",
  repo: "text/plain; charset=utf-8",
  gpg: "application/octet-stream",
};

/** Indexes change with every release; package files never change once published. */
function cacheFor(key) {
  // A published release never changes; "latest/" and latest.json point at the newest one.
  return /\.(deb|rpm)$/.test(key) || key.startsWith("releases/") ? "public, max-age=31536000, immutable" : "public, max-age=300";
}

const SECURITY = { "Strict-Transport-Security": "max-age=31536000; includeSubDomains", "X-Content-Type-Options": "nosniff" };
const plain = (status, message, extra = {}) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY, ...extra } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // A key or package fetched over plain HTTP could be swapped on the way: always move to HTTPS.
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return new Response(null, { status: 301, headers: { Location: url.toString() } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed\n", { Allow: "GET, HEAD" });

    let key;
    try {
      key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      return plain(400, "Bad request\n");
    }
    if (key.length > 512) return plain(400, "Bad request\n");
    if (!key || key.endsWith("/")) return plain(200, "OpenWren package repositories. See https://openwren.app/download/\n");

    // One plain byte range is honoured; anything else is answered with the whole file.
    const wanted = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");
    const ranged = wanted !== null && (wanted[1] !== "" || wanted[2] !== "");
    let object;
    try {
      object = await env.BUCKET.get(key, { range: ranged ? request.headers : undefined, onlyIf: request.headers });
    } catch {
      // R2 refuses a range that lies outside the file.
      return plain(416, "Range not satisfiable\n");
    }
    if (!object) return plain(404, "Not found\n");

    const headers = new Headers(SECURITY);
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", cacheFor(key));
    // Installers are saved, never shown in the browser.
    if (/\.(dmg|exe|AppImage)$/.test(key)) headers.set("Content-Disposition", `attachment; filename="${key.split("/").pop().replace(/[^\w.-]/g, "_")}"`);
    headers.set("Content-Type", TYPES[key.split(".").pop()] ?? (key.includes("/dists/") || key.endsWith("Release") ? "text/plain; charset=utf-8" : "application/octet-stream"));

    // No body means a condition in the request was not met.
    if (!("body" in object)) {
      const failed = request.headers.has("If-Match") || request.headers.has("If-Unmodified-Since");
      return new Response(null, { status: failed ? 412 : 304, headers });
    }
    if (ranged && object.range && "offset" in object.range) {
      const { offset, length } = object.range;
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("Content-Length", String(length));
      return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
    }
    headers.set("Content-Length", String(object.size));
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
};
