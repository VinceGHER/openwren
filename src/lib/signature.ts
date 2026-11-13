import type { SavedSignature } from "../types";

/** The content id a signature's picture has inside a sent message. */
export const SIGNATURE_CID = "signature-image";

export const hasPicture = (s: SavedSignature) => s.image !== "" && s.layout !== "text";

/**
 * A signature as HTML. With a picture it is laid out with a table, the one
 * layout every mail program shows the same way. `src` is where the picture
 * comes from: the stored image for previews, `cid:...` inside a sent message.
 */
export function signatureHtml(s: SavedSignature, src: string = s.image): string {
  if (!hasPicture(s)) return s.html;
  const picture = (width: number) => `<img src="${src}" width="${width}" alt="" style="display:block;border:0">`;
  if (s.layout === "above") return `<div style="margin-bottom:8px">${picture(160)}</div>${s.html}`;
  return `<table cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-right:14px;vertical-align:top">${picture(96)}</td><td style="vertical-align:top">${s.html}</td></tr></table>`;
}

/** Shrink a chosen picture so it adds little to every message. Returns a data URL. */
export async function pictureFromFile(file: File, maxSide = 320): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  // PNG keeps transparent logos; photos are much smaller as JPEG.
  const png = canvas.toDataURL("image/png");
  return png.length <= 150_000 ? png : canvas.toDataURL("image/jpeg", 0.85);
}
