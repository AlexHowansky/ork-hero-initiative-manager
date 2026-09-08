/**
 * The export templates a game master's character sheets are rendered through.
 *
 * A `.hde` is the other half of what a sheet is: the character file says what
 * the character is, and the template says what a sheet of them looks like. Until
 * this module there was one template for the whole deployment, hardcoded; now
 * each game master keeps their own collection and picks which of them their
 * sheets are drawn with, and the one this app ships is what they get until they
 * say otherwise.
 *
 * Between the two modules either side of it: the files live where
 * `uploads.ts` says they live, and what a template *is* — whether this is one at
 * all — is `hero-sheet.ts`, which owns every conversation with the renderer.
 */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { BUILT_IN_TEMPLATE_ID } from "../lib/templates.ts";
import { SHEET_LAYOUTS, type SheetLayout } from "../lib/sheetLayout.ts";
import { errors } from "../lib/errors.ts";
import { limits } from "../lib/config.ts";
import { log } from "../lib/log.ts";
import { newId } from "../lib/ids.ts";
import { gms, templates } from "../db/queries.ts";
import type { TemplateRow } from "../db/types.ts";
import { parseHde } from "./hero-sheet.ts";
import { readUploadedFile, safeOriginalName, sha256, templatePath } from "./uploads.ts";

/**
 * The template this app ships, from the Ork HERO Templates project, in each of
 * the shapes it comes in.
 *
 * It is what the cards, the player screen and the sheet overlay were all
 * designed around, so it stays the default and cannot be deleted — a game master
 * with no templates of their own still has working sheets, and one who deletes
 * every upload does too. Which of the three a sheet is drawn through is not a
 * setting but the shape of the window it is being read in; see `lib/sheetLayout`.
 */
const BUILT_IN_PATHS: Record<SheetLayout, string> = {
  "16x9": resolve(import.meta.dir, "../../assets/Ork-16x9.hde"),
  "8x9": resolve(import.meta.dir, "../../assets/Ork-8x9.hde"),
  "9x16": resolve(import.meta.dir, "../../assets/Ork-9x16.hde"),
};

/**
 * Template sources, read once each and held.
 *
 * Keyed by template id, with each shape of the built-in under its own sentinel
 * key (`built-in:16x9`) — so `forgetTemplate`, which takes a row id, can never
 * name one of them, which is right: a file that ships with the app does not
 * change under a running server. Rendering
 * happens on every request and a template is 45 KB of HTML to parse, so this is
 * the same saving the single memoised promise it replaces was making — and the
 * bound is the number of templates on the instance, which is a game master's own
 * collection rather than anything a stranger can grow.
 */
const sources = new Map<string, Promise<string>>();

function sourceAt(key: string, path: string): Promise<string> {
  const held = sources.get(key);
  if (held) return held;

  const reading = Bun.file(path).text();
  // A read that failed must not be remembered as the answer. The file behind an
  // uploaded template can go while the app is running — a botched restore, a
  // stray sweep — and a rejected promise left in here would fail every sheet
  // that template draws until the process restarted.
  reading.catch(() => {
    if (sources.get(key) === reading) sources.delete(key);
  });
  sources.set(key, reading);
  return reading;
}

/** Forgets a template's source, for a file that has changed or gone. */
export function forgetTemplate(id: string): void {
  sources.delete(id);
}

/** The source of the template this app ships, in the shape asked for. */
export function builtInSource(layout: SheetLayout): Promise<string> {
  return sourceAt(`${BUILT_IN_TEMPLATE_ID}:${layout}`, BUILT_IN_PATHS[layout]);
}

/**
 * Every shape of the built-in, read before the first request.
 *
 * They ship with the app, so a running server can no more be handed a new one
 * than it can a new component — the same reasoning as the card art in
 * `routes/frames.ts`, and the same treatment. Doing it here rather than lazily
 * is about *when* a broken install is discovered: read on demand, a missing
 * `Ork-9x16.hde` is found by the first player who turns a phone sideways, as a
 * 500 that tells them to re-export their character. Read now, it is found by
 * whoever started the server.
 */
await Promise.all(SHEET_LAYOUTS.map((layout) => builtInSource(layout)));

/**
 * The template a character's sheet should be drawn through.
 *
 * Taken from the game master who owns the character, never from whoever is
 * asking: a player reading their own character's sheet sees it through the
 * template the game master who filed them chose.
 *
 * A choice whose file has gone falls back to the built-in rather than failing.
 * Every character at that table being unopenable is a worse answer than the
 * right character in the wrong frame, and the warning is where an operator can
 * act on it.
 */
export async function templateSourceForGm(gmId: string, layout: SheetLayout): Promise<string> {
  const templateId = gms.byId(gmId)?.template_id ?? null;
  if (templateId === null) return await builtInSource(layout);

  const row = templates.byId(templateId);
  if (row) {
    try {
      return await sourceAt(row.id, templatePath(row.id));
    } catch (error) {
      log.warn("an export template's file could not be read", { templateId: row.id, error });
    }
  } else {
    log.warn("a game master's export template is no longer on file", { gmId, templateId });
  }
  return await builtInSource(layout);
}

/**
 * Files an uploaded `.hde`, or says why it is not one.
 *
 * Checked before anything reaches the disk, in the order `storeSheet` checks a
 * character file: what it is called, how big it is, whether it is empty, and
 * then whether it parses as the thing it claims to be.
 *
 * A name this game master already has is that template being *updated* rather
 * than a second copy of it — a template is something you edit and re-export, and
 * the one they edit most is the one they are using. So the row keeps its id, and
 * a template that was in use is still in use, drawn from the new file on the very
 * next sheet.
 */
export async function storeTemplate(
  gmId: string,
  file: File,
): Promise<{ template: TemplateRow; replaced: boolean }> {
  const originalName = file.name || "template.hde";
  if (!/\.hde$/i.test(originalName)) {
    throw errors.badRequest("Export templates must be .hde files exported from HERO Designer.");
  }

  const bytes = await readUploadedFile(file, "export template");
  if (bytes.byteLength === 0) throw errors.badRequest("That export template was empty.");

  // UTF-8, and strictly: an `.hde` is HTML written by HERO Designer and that is
  // what it writes. Storing something that decoded to mojibake would put the
  // damage on every sheet drawn through it, where saying so now costs one
  // sentence.
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw errors.badRequest(
      "We couldn't read that file as text. An export template is UTF-8 HTML.",
    );
  }

  const parsed = parseHde(source, originalName);
  const name = templateName(parsed.name, originalName);
  const stored = safeOriginalName(originalName);
  const digest = sha256(bytes);

  const existing = templates.byName(gmId, name);
  if (existing) {
    await Bun.write(templatePath(existing.id), bytes);
    templates.rewrite(existing.id, {
      byteSize: bytes.byteLength,
      sha256: digest,
      originalName: stored,
    });
    forgetTemplate(existing.id);
    log.info("export template replaced", { templateId: existing.id, gmId });
    return { template: templates.byId(existing.id)!, replaced: true };
  }

  // Named after the row that is about to describe it, as every stored file is,
  // so the uploaded filename never reaches the filesystem.
  const id = newId();
  await Bun.write(templatePath(id), bytes);
  const template = templates.create({
    id,
    gmId,
    name,
    byteSize: bytes.byteLength,
    sha256: digest,
    originalName: stored,
  });
  log.info("export template stored", { templateId: id, gmId, bytes: bytes.byteLength });
  return { template, replaced: false };
}

/**
 * What to call a template in the list a game master picks from.
 *
 * Its own `<!--TEMPLATE_NAME-->` first, since that is what its author called it
 * and what HERO Designer shows. A template that gives no name falls back to its
 * filename, and one that somehow gives neither still gets something a person can
 * point at.
 *
 * Clipped rather than refused: a name longer than a character's may be is still a
 * template worth keeping.
 */
function templateName(declared: string, originalName: string): string {
  const tidy = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, limits.nameMaxLength);
  return tidy(declared) || tidy(originalName.replace(/\.hde$/i, "")) || "Export template";
}

/** Removes a template and the file behind it. */
export async function deleteTemplate(row: TemplateRow): Promise<void> {
  templates.remove(row.id);
  forgetTemplate(row.id);
  try {
    await unlink(templatePath(row.id));
  } catch (error) {
    // A file that has already gone is not worth a warning; one that is there and
    // will not delete needs a person, as it does for every other upload.
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const report = missing ? log.debug : log.warn;
    report("could not delete an export template file", { templateId: row.id, error });
  }
}

/**
 * Removes every template a game master owns, and returns how many went.
 *
 * For deleting the game master themselves. The database cascade takes the rows,
 * which is exactly the problem: once they are gone nothing on the instance can
 * name the files any more, and they would sit in the upload directory until
 * somebody ran `db:gc`. So this runs *before* the account goes.
 */
export async function deleteTemplatesForGm(gmId: string): Promise<number> {
  const owned = templates.listForGm(gmId);
  for (const row of owned) await deleteTemplate(row);
  return owned.length;
}
