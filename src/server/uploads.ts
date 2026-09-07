/**
 * Upload intake.
 *
 * Two kinds of file arrive: HERO Designer character files (`.hdc`) and card
 * images.
 *
 * A character file is data, not a document. Nothing in it is ever executed, and
 * the sheet a game master looks at is rendered from it on demand
 * (`hero-sheet.ts`) rather than stored — so what routes/files.ts serves is
 * output this app generated, delivered into an opaque origin all the same,
 * because the character's own notes fields can carry CSS the game master wrote.
 *
 * The one edit a stored character file ever receives is `removeImage`, which
 * takes back out the portrait that has just become the character's card rather
 * than storing that picture twice.
 *
 * What this module does guarantee: files land outside any statically served
 * directory, under a random name that never derives from user input, with a size
 * ceiling and a content type the app assigns rather than one the client claims.
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import sharp from "sharp";
import { config, limits } from "../lib/config.ts";
import { errors } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { newId } from "../lib/ids.ts";
import { HDC_MIME, imageFromHdc, parseHdc, statsFromHdc, withoutImage } from "./hero-sheet.ts";
import type { HeroStatField } from "../lib/hero.ts";
import { uploads } from "../db/queries.ts";
import type { UploadRow } from "../db/types.ts";

const CHARACTER_DIR = resolve(config.uploadDir, "characters");
const IMAGE_DIR = resolve(config.uploadDir, "images");

/**
 * Where an upload's file actually is.
 *
 * `disk_path` is stored relative to the upload directory, so the rows survive
 * the checkout being renamed or moved — an absolute path written at upload time
 * froze the directory name of the day into every row, and a rename orphaned the
 * lot. Rows written before that changed hold an absolute path and are passed
 * through untouched.
 */
export function uploadPath(row: Pick<UploadRow, "disk_path">): string {
  return isAbsolute(row.disk_path) ? row.disk_path : resolve(config.uploadDir, row.disk_path);
}

await mkdir(CHARACTER_DIR, { recursive: true });
await mkdir(IMAGE_DIR, { recursive: true });

/** Magic-byte signatures, so an image is checked by content rather than by name. */
const IMAGE_SIGNATURES: ReadonlyArray<{ mime: string; test: (bytes: Uint8Array) => boolean }> = [
  {
    mime: "image/png",
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/jpeg",
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/gif",
    test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    mime: "image/webp",
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  return IMAGE_SIGNATURES.find((signature) => signature.test(bytes))?.mime ?? null;
}

/** Keeps a readable trace of what was uploaded without letting it influence a path. */
function safeOriginalName(name: string): string {
  return name.replace(/[^\w.\- ]/g, "_").slice(0, 120) || "upload";
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function persist(
  bytes: Uint8Array,
  directory: string,
  kind: "sheet" | "image",
  mime: string,
  originalName: string,
): Promise<UploadRow> {
  // The file is named after the row that is about to describe it, and the
  // uploaded filename never reaches the filesystem, so there is no path to
  // traverse out of. The two used to be separate identifiers — one minted here
  // and one inside `uploads.create` — which read as the same id typo'd whenever
  // they turned up side by side in a log, and left a file whose row had gone
  // (a restore from an older database, say) with nothing to identify it. Reading
  // an upload still goes through `disk_path` rather than rebuilding the path
  // from the id, so files can be rehomed and rows written before this change
  // keep working untouched. What the row stores is relative to the upload
  // directory: an absolute path would name whatever directory the checkout sat
  // in the day the file arrived, and moving it would orphan every upload.
  const id = newId();
  const diskPath = join(directory, id);
  await Bun.write(diskPath, bytes);

  const row = uploads.create({
    id,
    kind,
    diskPath: join(kind === "image" ? "images" : "characters", id),
    mime,
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
    originalName: safeOriginalName(originalName),
  });
  log.info("upload stored", { uploadId: row.id, kind, bytes: bytes.byteLength });
  return row;
}

async function readWithLimit(file: File, maxBytes: number, label: string): Promise<Uint8Array> {
  if (file.size > maxBytes) {
    throw errors.tooLarge(
      `That ${label} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${
        Math.round(maxBytes / 1024 / 1024)
      } MB.`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // The declared size and the actual body can disagree; check what we really got.
  if (bytes.byteLength > maxBytes) {
    throw errors.tooLarge(`That ${label} is larger than the ${
      Math.round(maxBytes / 1024 / 1024)
    } MB limit.`);
  }
  return bytes;
}

/**
 * An uploaded file's bytes, held to the same ceiling a stored one is.
 *
 * For the one route that reads a file without keeping it: the dialog sends a
 * character file to be told what its characteristics are, and nothing about it
 * is written down.
 */
export async function readUploadedFile(file: File, label: string): Promise<Uint8Array> {
  return await readWithLimit(file, limits.uploadBytes, label);
}

/**
 * Holds a submission carrying more than one file to the same ceiling the files
 * are held to individually.
 *
 * `UPLOAD_LIMIT_BYTES` is documented to an operator as the size of an upload, and
 * the only route that takes two files at once is a character's — a sheet and a
 * picture, in one submission. Without this, that request could carry twice the
 * configured limit, and a reverse proxy sized to the setting would cut it off
 * with a generic error of its own instead of the message below.
 *
 * Sizes come from the parsed multipart body, so they are the bytes that actually
 * arrived rather than anything the client asserted; each file is still measured
 * on its own as it is read.
 */
export function requireTotalWithinLimit(...files: (File | null)[]): void {
  const total = files.reduce((sum, file) => sum + (file?.size ?? 0), 0);
  if (total > limits.uploadBytes) {
    throw errors.tooLarge(
      `Those files are ${(total / 1024 / 1024).toFixed(1)} MB together. The limit is ${
        Math.round(limits.uploadBytes / 1024 / 1024)
      } MB.`,
    );
  }
}

/**
 * Stores an uploaded character file.
 *
 * Parsed before it is written, which is new: an HTML sheet was stored whatever
 * it turned out to contain, because it was a document to be handed back as it
 * arrived. A character file is read by this app every time anybody looks at the
 * character, so a file that cannot be read is a character that cannot be
 * displayed — and the moment to say so is while the game master still has the
 * upload dialog open, not the first time they click a name mid-fight.
 */
export async function storeSheet(file: File): Promise<UploadRow> {
  const name = file.name ?? "character.hdc";
  if (!/\.hdc$/i.test(name)) {
    throw errors.badRequest("Character files must be .hdc files exported from HERO Designer.");
  }
  const bytes = await readWithLimit(file, limits.uploadBytes, "character file");
  if (bytes.byteLength === 0) throw errors.badRequest("That character file was empty.");
  parseHdc(bytes, name);
  return await persist(bytes, CHARACTER_DIR, "sheet", HDC_MIME, name);
}

/**
 * How hard the WebP encoder is asked to work.
 *
 * 80 is the knee of the curve for pictures at this size: visually indistinct
 * from the source inside a 176px card, and roughly half the bytes of 90. Higher
 * settings mostly buy detail the card crops away.
 */
const WEBP_QUALITY = 80;

/**
 * Scales a picture down to the size it is actually looked at, and stores it in
 * the format that holds it in the fewest bytes.
 *
 * Every image the app shows ends up in a square card 176px across, so a 4000px
 * photograph costs a game master's phone several megabytes to draw a thumbnail.
 * The shorter side is what has to cover that square, so that is what is scaled —
 * to `limits.storedImagePx`, proportionally, with nothing cropped: the card takes
 * its square at display time, and the rest of the picture is still there for
 * anywhere it is shown differently. Nothing is enlarged.
 *
 * Then the same picture is encoded as WebP and the two are weighed against each
 * other, because the format a picture arrives in is rarely the one it should be
 * kept in: a photograph saved as PNG is lossless data about a lossy subject, and
 * over the images this app has been given WebP came out about seven times
 * smaller. The winner is whichever buffer is actually smaller, which is the whole
 * rule — re-encoding an already-lossy JPEG can *grow* it, and when it does the
 * original stands. Alpha survives the conversion, and an animated GIF converts
 * whole rather than flattening to its first frame.
 *
 * What the format never decides is what is *accepted*: that is still the
 * magic-byte check in `detectImageMime`, on the bytes as they arrived.
 *
 * A picture that cannot be read is stored as it came in. It passed the magic-byte
 * check, so this is a decoder disagreeing about the details of a real image, and
 * a game master would rather have their picture at full size than an error.
 */
async function fitToCard(
  bytes: Uint8Array,
  mime: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const animated = mime === "image/gif";
  const asUploaded = { bytes, mime };
  try {
    const { width, height } = await sharp(bytes).metadata();
    if (!width || !height) return asUploaded;

    // The picture at the size it will be looked at, still in its own format.
    // This is the candidate WebP has to beat, and on an image already small
    // enough it is simply the bytes that arrived.
    const scaled = Math.min(width, height) > limits.storedImagePx
      ? new Uint8Array(
        await sharp(bytes, { animated })
          .resize({
            width: limits.storedImagePx,
            height: limits.storedImagePx,
            // `outside` fits the shorter side to the box and lets the longer one
            // run over, which is exactly what a cropping card needs.
            fit: "outside",
            withoutEnlargement: true,
          })
          .toBuffer(),
      )
      : bytes;

    const webp = new Uint8Array(
      await sharp(scaled, { animated }).webp({ quality: WEBP_QUALITY }).toBuffer(),
    );

    const best = webp.byteLength < scaled.byteLength
      ? { bytes: webp, mime: "image/webp" }
      : { bytes: scaled, mime };

    if (best.bytes !== bytes) {
      log.info("image fitted to the card", {
        from: `${width}x${height} ${mime} ${bytes.byteLength}B`,
        to: `${best.mime} ${best.bytes.byteLength}B`,
      });
    }
    return best;
  } catch (error) {
    log.warn("could not fit an image; storing it as uploaded", { mime, error });
    return asUploaded;
  }
}

/**
 * Stores an image, verifying the format by its magic bytes and scaling it to the
 * size it is displayed at. Returns null for anything that is not an image.
 */
async function persistImage(bytes: Uint8Array, originalName: string): Promise<UploadRow | null> {
  const mime = detectImageMime(bytes);
  if (!mime) return null;
  // What is stored, and the type it is served as, is what came back from the fit
  // — which may be WebP whatever arrived.
  const fitted = await fitToCard(bytes, mime);
  return await persist(fitted.bytes, IMAGE_DIR, "image", fitted.mime, originalName);
}

/** Stores a card image, verifying the format by its magic bytes. */
export async function storeImage(file: File): Promise<UploadRow> {
  const bytes = await readWithLimit(file, limits.uploadBytes, "image");
  const stored = await persistImage(bytes, file.name ?? "image");
  if (!stored) {
    throw errors.badRequest("That image must be a PNG, JPEG, GIF or WebP file.");
  }
  return stored;
}

/* ---------------------------------------------------------------- portraits */

/** Images below this are furniture — an icon or a placeholder, not a portrait. */
const MIN_PORTRAIT_BYTES = 2 * 1024;

/**
 * The characteristics a stored character file already knows, or nothing.
 *
 * The file is on disk by the time this runs, so it is re-read rather than kept
 * in hand. What it says is worked out by `hero-sheet.ts`, against the game
 * system's rules — the same answer the dialog got from `/api/characters/stats`
 * as the file was chosen, so the two cannot disagree. This one is for the
 * characters filed by dropping a folder of them, which send no boxes at all.
 *
 * A file that cannot be read is not an error worth failing an upload over: the
 * character is filed with whatever the form did say, exactly as before any of
 * this existed.
 */
export async function statsFromSheet(
  sheet: UploadRow,
): Promise<Partial<Record<HeroStatField, number>>> {
  try {
    const bytes = new Uint8Array(await Bun.file(uploadPath(sheet)).arrayBuffer());
    return await statsFromHdc(bytes, sheet.original_name);
  } catch (error) {
    log.warn("could not re-read a character file to look for characteristics", {
      uploadId: sheet.id,
      error,
    });
    return {};
  }
}

/**
 * The portrait inside a stored character file, if it has one.
 *
 * HERO Designer keeps the character's picture in the file, as base64 in a single
 * `IMAGE` element, so taking it saves the game master finding and uploading the
 * same image a second time.
 *
 * There is exactly one place to look and one picture to find, which is the whole
 * of the difference from the HTML sheets this replaces: those had to be scanned
 * for long runs of base64 or hex that decoded to something with image magic
 * bytes, with the largest one assumed to be the portrait, because no markup
 * convention said which image was which. What has not changed is that only what
 * is *embedded* counts — a file naming a picture by URL is left alone, since
 * fetching it would have the server make a request to wherever an uploaded file
 * says to.
 *
 * Ordinarily there is nothing here to find: the browser splits the picture out
 * before uploading (`client/hdc.ts`), so the file arrives with no image and the
 * portrait arrives beside it, already sized. This is the path for a file that
 * reaches the server whole — through the API, or from a browser where the split
 * failed — and it is what makes the server, not the client, the authority on
 * what a character's picture is.
 */
export async function portraitFromSheet(sheet: UploadRow): Promise<UploadRow | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await Bun.file(uploadPath(sheet)).arrayBuffer());
  } catch (error) {
    log.warn("could not re-read a character file to look for a portrait", {
      uploadId: sheet.id,
      error,
    });
    return null;
  }

  const picture = imageFromHdc(parseHdc(bytes, sheet.original_name));
  if (!picture || picture.byteLength < MIN_PORTRAIT_BYTES) return null;

  const mime = detectImageMime(picture);
  if (!mime) {
    log.warn("a character file's picture was not an image this app can store", {
      uploadId: sheet.id,
    });
    return null;
  }

  const extension = mime.replace("image/", "").replace("jpeg", "jpg");
  log.info("portrait taken from a character file", {
    uploadId: sheet.id,
    mime,
    bytes: picture.byteLength,
  });
  // Scaled on the way in like any other picture: a character file's portrait is
  // often the largest image this app ever sees.
  const portrait = await persistImage(picture, `portrait.${extension}`);
  if (portrait) await removeImage(sheet);
  return portrait;
}

/**
 * Takes the portrait's own bytes back out of the file that carried them.
 *
 * Once the picture is a card of its own, the copy inside the character file is
 * the same image stored twice — and much the larger copy, since base64 in UTF-16
 * costs nearly three bytes for every one of the picture's. It is almost the
 * whole of what one of these files weighs: the fixture is 3.7 MB, of which
 * 3.63 MB is a 1.3 MB portrait, and it comes out at 92 KB.
 *
 * Which means a rendered sheet no longer shows a portrait. That is the trade
 * this makes, and the same one the HTML sheets made: the picture is on the card,
 * which is where this app shows it.
 *
 * A file that cannot be rewritten is left exactly as it was and the portrait
 * still stands: the picture is the point, and what the file saves is the bonus.
 */
async function removeImage(sheet: UploadRow): Promise<void> {
  try {
    const path = uploadPath(sheet);
    const before = new Uint8Array(await Bun.file(path).arrayBuffer());
    const bytes = withoutImage(before);
    if (bytes.byteLength === before.byteLength) return;

    await Bun.write(path, bytes);
    // The row describes the file, so what the file now weighs and hashes to has
    // to travel with it — `db:gc` and the duplicate check both read those.
    uploads.rewrite(sheet.id, { byteSize: bytes.byteLength, sha256: sha256(bytes) });
    log.info("portrait removed from the character file that carried it", {
      uploadId: sheet.id,
      bytes: `${before.byteLength} -> ${bytes.byteLength}`,
    });
  } catch (error) {
    log.warn("could not take the portrait out of the character file", {
      uploadId: sheet.id,
      error,
    });
  }
}

/** Removes an upload's row and its file. Missing files are not an error. */
export async function deleteUpload(uploadId: string): Promise<void> {
  const row = uploads.byId(uploadId);
  if (!row) return;
  uploads.remove(row.id);
  try {
    await unlink(uploadPath(row));
  } catch (error) {
    // A file that has already gone is the ordinary case when a sweep catches up
    // with rows left behind by something else, so it is not worth a warning. A
    // file that is there and will not delete is: that one needs a person.
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const report = missing ? log.debug : log.warn;
    report("could not delete upload file", { uploadId: row.id, error });
  }
}

/**
 * Deletes every upload nothing references any more. Called after a character or
 * campaign is removed, so deleted sheets don't linger on disk.
 */
export async function collectOrphanedUploads(): Promise<number> {
  const orphans = uploads.orphaned();
  for (const orphan of orphans) await deleteUpload(orphan.id);
  if (orphans.length > 0) log.info("collected orphaned uploads", { count: orphans.length });
  return orphans.length;
}

/**
 * Files under the upload directories that no `uploads` row claims.
 *
 * The mirror image of `uploads.orphaned()`, which finds rows nothing references:
 * this finds files nothing describes. They come from a write that landed before
 * its row failed to, and from a database restored from a backup older than the
 * files beside it. Nothing swept for them before `db:gc`.
 *
 * The scan lives here because `CHARACTER_DIR` and `IMAGE_DIR` do — where the files
 * are kept is this module's business and nobody else's.
 */
export async function findStrayFiles(): Promise<string[]> {
  const claimed = new Set(uploads.all().map(uploadPath));
  const stray: string[] = [];
  for (const directory of [CHARACTER_DIR, IMAGE_DIR]) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      if (!claimed.has(path)) stray.push(path);
    }
  }
  return stray;
}

/** Deletes what `findStrayFiles` finds. Returns how many went. */
export async function collectStrayFiles(): Promise<number> {
  const stray = await findStrayFiles();
  for (const path of stray) {
    try {
      await unlink(path);
    } catch (error) {
      log.warn("could not delete stray upload file", { path, error });
    }
  }
  if (stray.length > 0) log.info("collected stray upload files", { count: stray.length });
  return stray.length;
}

/**
 * Pulls a single optional file field out of a multipart form, rejecting empty
 * placeholder parts that browsers send for untouched file inputs.
 */
export function fileField(form: FormData, name: string): File | null {
  const value = form.get(name);
  if (!(value instanceof File)) return null;
  if (value.size === 0) return null;
  return value;
}
