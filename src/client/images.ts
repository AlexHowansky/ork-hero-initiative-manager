/**
 * Sizing a picture for a card before it is uploaded.
 *
 * Every picture this app stores ends up as the square face of a card, scaled to
 * `limits.storedImagePx` by the server (`fitToCard` in `server/uploads.ts`).
 * Doing the same thing here first is about what crosses the wire: a photograph
 * off a phone is several megabytes, and the card it becomes is tens of
 * kilobytes.
 *
 * It also decides whether a picture can be filed at all. The upload ceiling is
 * `UPLOAD_LIMIT_BYTES`, checked as the bytes arrive and so before the server has
 * anything to scale — so a picture larger than the ceiling is refused rather
 * than shrunk, however small the card it was going to become. Sized here, it is
 * under the ceiling long before it is sent.
 *
 * This was the character file's own trick first (`hdc.ts`, which lifts the
 * portrait out of a `.hdc` and sizes it on the way past). It lives here now
 * because a picture chosen as a picture — dropped on a card, or picked in either
 * edit dialog — deserves the same treatment, and because the two must scale
 * pictures identically or a card would look different depending on which way its
 * artwork arrived.
 *
 * Nothing here is load-bearing. Every step falls back to the file as it was,
 * because the server does all of this anyway — this is a saving, never a
 * correctness step, and it must never be the reason a picture cannot be filed.
 */

import { CARD_IMAGE_PX } from "../lib/cards.ts";

/**
 * The shorter side a picture is scaled to, matching `limits.storedImagePx` on
 * the server.
 *
 * Twice the largest card a game master can choose, because a 350px card on a 2×
 * screen needs 700 device pixels. The server re-fits whatever arrives and never
 * enlarges, so a picture sized here passes through it untouched — and the two
 * numbers must not drift, which is why this is the same constant.
 */
export const CARD_IMAGE_TARGET_PX = CARD_IMAGE_PX.max * 2;

/** What a fitted picture is encoded at, so one is not re-compressed differently. */
const WEBP_QUALITY = 0.8;

/**
 * Scales a picture down to the size a card shows it at, and encodes it as WebP.
 *
 * The same rule the server applies: the shorter side covers the card's square,
 * nothing is cropped, nothing is enlarged. Encoding is left to the browser,
 * which is why the result is checked rather than assumed — WebP from a canvas is
 * not universal, and a browser that will not produce it hands back a PNG
 * instead, which the server is perfectly happy to re-encode.
 *
 * `name` is what the result should be called; its extension is replaced with the
 * one the encoder actually produced, since a WebP called `.png` is a file whose
 * name lies about it. The type comes from the encoder for the same reason.
 *
 * Anything that goes wrong — no `createImageBitmap`, no `OffscreenCanvas`, a
 * file that is not a picture at all, an encoder that produces something larger
 * than it was given — answers with `fallback`, which is the picture exactly as
 * it arrived.
 */
export async function fitToCard(source: Blob, name: string, fallback: File): Promise<File> {
  try {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
      return fallback;
    }

    const bitmap = await createImageBitmap(source);
    const shorter = Math.min(bitmap.width, bitmap.height);
    const scale = shorter > CARD_IMAGE_TARGET_PX ? CARD_IMAGE_TARGET_PX / shorter : 1;
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    // `resizeQuality` is the decoder's own resampling, which is better than
    // drawing a full-size bitmap into a small canvas.
    const fitted = scale === 1
      ? bitmap
      : await createImageBitmap(bitmap, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: "high",
      });

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return fallback;
    context.drawImage(fitted, 0, 0, width, height);

    const blob = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
    bitmap.close();
    if (fitted !== bitmap) fitted.close();

    // A picture that grew is one the browser has re-compressed badly — an
    // already-lossy source encoded again. The original stands, as it does on
    // the server.
    if (blob.size >= source.size) return fallback;

    const extension = blob.type === "image/webp" ? "webp" : blob.type.replace("image/", "");
    return new File([blob], `${name.replace(/\.[^.]+$/, "")}.${extension}`, { type: blob.type });
  } catch {
    return fallback;
  }
}

/**
 * The same, for a picture the game master chose as a file.
 *
 * A `File` is already everything the fit needs — its own bytes to read and its
 * own name to keep — so this is the whole of what a caller with one has to say.
 */
export function fitFileToCard(file: File): Promise<File> {
  return fitToCard(file, file.name, file);
}
