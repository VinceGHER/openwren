// Read-only file server for the package repositories kept in an R2 bucket.
// apt and dnf only ever GET or HEAD a path; everything else is refused.

const TYPES = {
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
  gz: "application/gzip",
  xml: "application/xml",
  asc: "text/plain; charset=utf-8",
  repo: "text/plain; charset=utf-8",
  gpg: "application/octet-stream",
};

/** Indexes change with every release; package files never change once published. */
function cacheFor(key) {
  return /\.(deb|rpm)$/.test(key) ? "public, max-age=31536000, immutable" : "public, max-age=300";
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const key = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
    if (!key || key.endsWith("/")) {
      return new Response("OpenWren package repositories. See https://openwren.app/download/\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    // `range` and `onlyIf` take the request's own headers, so partial and conditional downloads work.
    const object = await env.BUCKET.get(key, { range: request.headers, onlyIf: request.headers });
    if (!object) return new Response("Not found\n", { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", cacheFor(key));
    headers.set("Content-Type", TYPES[key.split(".").pop()] ?? (key.includes("/dists/") || key.endsWith("Release") ? "text/plain; charset=utf-8" : "application/octet-stream"));

    // No body means a condition such as If-None-Match was not met.
    if (!("body" in object)) return new Response(null, { status: 304, headers });
    if (request.headers.has("Range") && object.range && "offset" in object.range) {
      const { offset, length } = object.range;
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("Content-Length", String(length));
      return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
    }
    headers.set("Content-Length", String(object.size));
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
};
