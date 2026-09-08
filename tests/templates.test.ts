/**
 * Export templates: what one is, where it is kept, and whose it is.
 *
 * A template is the frame every character sheet at a table is drawn in, and
 * unlike a character file it is not checked again on the way out — `render` runs
 * with strict mode off, so a file that is not a template produces a page rather
 * than an error. The upload is the only place that can be said, which is what
 * most of this is about.
 */

import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  builtInSource,
  deleteTemplate,
  deleteTemplatesForGm,
  forgetTemplate,
  storeTemplate,
  templateSourceForGm,
} from "../src/server/templates.ts";
import {
  collectOrphanedUploads,
  collectStrayFiles,
  findStrayFiles,
  TEMPLATE_DIR,
  templatePath,
} from "../src/server/uploads.ts";
import { gms, templates } from "../src/db/queries.ts";
import { limits } from "../src/lib/config.ts";
import { hdcBytes, hdeFile, hdeSource, makeGm } from "./helpers.ts";
import { SHEET_LAYOUTS } from "../src/lib/sheetLayout.ts";

describe("filing an export template", () => {
  test("is kept where templates are kept, under a generated name", async () => {
    const gm = makeGm();
    const { template, replaced } = await storeTemplate(gm.id, hdeFile("../../etc/passwd.hde"));

    expect(replaced).toBe(false);
    // Named after the row that describes it, so the uploaded filename never
    // reaches the filesystem — the same guarantee every other upload has.
    expect(basename(templatePath(template.id))).toBe(template.id);
    expect(dirname(templatePath(template.id))).toBe(TEMPLATE_DIR);
    expect(await Bun.file(templatePath(template.id)).exists()).toBe(true);
    expect(template.original_name).not.toContain("/");
  });

  test("is named whatever the template calls itself", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(
      gm.id,
      hdeFile("whatever-i-saved-it-as.hde", { name: "Ork 16x9" }),
    );

    // Its own `<!--TEMPLATE_NAME-->`, which is what HERO Designer shows and what
    // its author called it. The filename is a working title.
    expect(template.name).toBe("Ork 16x9");
  });

  test("falls back to the filename when the template names itself nothing", async () => {
    const gm = makeGm();
    const source = hdeSource({ name: "" });
    const { template } = await storeTemplate(
      gm.id,
      new File([source], "My Own Layout.hde"),
    );

    expect(template.name).toBe("My Own Layout");
  });

  test("a name too long for a character is clipped rather than refused", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(gm.id, hdeFile("Long.hde", { name: "x".repeat(200) }));

    // A template with a long name is still a template worth keeping.
    expect(template.name.length).toBe(limits.nameMaxLength);
  });

  test("must be a .hde by extension", async () => {
    const gm = makeGm();
    expect(storeTemplate(gm.id, new File([hdeSource()], "template.txt"))).rejects.toThrow(/\.hde/);
  });

  test("cannot be empty", async () => {
    const gm = makeGm();
    expect(storeTemplate(gm.id, new File([], "empty.hde"))).rejects.toThrow(/empty/);
  });

  test("must actually be a template, not merely named like one", async () => {
    const gm = makeGm();
    // A character file under a template's name. It is refused for the first
    // thing that is wrong with it rather than the last: a `.hdc` is UTF-16 with
    // a byte-order mark and a template is UTF-8, so it never reaches the parser.
    const notATemplate = new File([hdcBytes({ name: "Hero" }) as BlobPart], "sneaky.hde");

    expect(storeTemplate(gm.id, notATemplate)).rejects.toThrow(/UTF-8/);
    expect(templates.listForGm(gm.id)).toHaveLength(0);
  });

  test("a page with no directives in it is refused even when it is HTML", async () => {
    const gm = makeGm();
    const flat = new File([hdeSource({ directives: false })], "flat.hde");

    expect(storeTemplate(gm.id, flat)).rejects.toThrow(/directives/);
  });

  test("nothing reaches the disk when the file is refused", async () => {
    const gm = makeGm();
    const before = (await findStrayFiles()).length;

    expect(storeTemplate(gm.id, new File([hdeSource()], "no.txt"))).rejects.toThrow();

    expect((await findStrayFiles()).length).toBe(before);
  });
});

describe("a collection is one game master's own", () => {
  test("two game masters may each keep a template of the same name", async () => {
    const first = makeGm();
    const second = makeGm();

    const mine = await storeTemplate(first.id, hdeFile("t.hde", { name: "Shared Name" }));
    const theirs = await storeTemplate(second.id, hdeFile("t.hde", { name: "Shared Name" }));

    // Two files, two rows, and neither is in the other's way.
    expect(mine.template.id).not.toBe(theirs.template.id);
    expect(templates.listForGm(first.id)).toHaveLength(1);
    expect(templates.listForGm(second.id)).toHaveLength(1);
  });

  test("the same name again is that template being updated", async () => {
    const gm = makeGm();
    const first = await storeTemplate(gm.id, hdeFile("v1.hde", { name: "Mine", marker: "one" }));
    gms.update(gm.id, { templateId: first.template.id });

    const again = await storeTemplate(
      gm.id,
      hdeFile("v2.hde", { name: "Mine", marker: "two-and-longer" }),
    );

    // The same row, so a template that was in use is still in use — which is the
    // whole point: the one a game master edits most is the one they are using,
    // and a re-export must not cost them their choice.
    expect(again.replaced).toBe(true);
    expect(again.template.id).toBe(first.template.id);
    expect(templates.listForGm(gm.id)).toHaveLength(1);
    expect(gms.byId(gm.id)!.template_id).toBe(first.template.id);

    // And it is the new file, on disk and in the row.
    expect(await Bun.file(templatePath(first.template.id)).text()).toContain("two-and-longer");
    expect(again.template.sha256).not.toBe(first.template.sha256);
    expect(again.template.byte_size).not.toBe(first.template.byte_size);
  });

  test("a replacement is what the next sheet is drawn through", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(gm.id, hdeFile("v1.hde", { marker: "before" }));
    gms.update(gm.id, { templateId: template.id });
    expect(await templateSourceForGm(gm.id, "16x9")).toContain("before");

    await storeTemplate(gm.id, hdeFile("v2.hde", { marker: "after" }));

    // The cache is per template rather than per process, so a replaced file has
    // to be forgotten — otherwise every sheet would go on being drawn through
    // the version that was replaced until the server restarted.
    expect(await templateSourceForGm(gm.id, "16x9")).toContain("after");
    expect(await templateSourceForGm(gm.id, "16x9")).not.toContain("before");
  });
});

describe("which template a sheet is drawn through", () => {
  test("is the one this app ships until a game master says otherwise", async () => {
    const gm = makeGm();

    expect(gms.byId(gm.id)!.template_id).toBeNull();
    expect(await templateSourceForGm(gm.id, "16x9")).toBe(await builtInSource("16x9"));
  });

  test("is whichever shape of the built-in the reader's window asks for", async () => {
    const gm = makeGm();

    // Three files, one entry. Each says which layout it is in the banner comment
    // it writes into every sheet drawn through it, which is how a test — and a
    // reader looking at a sheet — can tell them apart.
    for (const layout of SHEET_LAYOUTS) {
      expect(await templateSourceForGm(gm.id, layout)).toContain(`Layout: ${layout}`);
    }
  });

  test("but a game master's own template is their own whatever shape the window is", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(gm.id, hdeFile("mine.hde", { marker: "mine-only" }));
    gms.update(gm.id, { templateId: template.id });

    // Automatic is a property of the built-in alone: a template somebody
    // uploaded is the one they uploaded, and nothing here second-guesses its
    // layout.
    for (const layout of SHEET_LAYOUTS) {
      expect(await templateSourceForGm(gm.id, layout)).toContain("mine-only");
    }
  });

  test("is theirs once they have chosen one", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(gm.id, hdeFile("mine.hde", { marker: "mine-only" }));
    gms.update(gm.id, { templateId: template.id });

    expect(await templateSourceForGm(gm.id, "16x9")).toContain("mine-only");
  });

  test("falls back to the built-in when the file behind it has gone", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(gm.id, hdeFile("mine.hde", { marker: "gone" }));
    gms.update(gm.id, { templateId: template.id });

    await unlink(templatePath(template.id));
    // What a server that has not read this template yet would find — a template
    // already in hand goes on being drawn from memory, which is its own small
    // mercy. This is the cold start after a botched restore.
    forgetTemplate(template.id);

    // Every character at that table being unopenable is a worse answer than the
    // right character in the wrong frame.
    expect(await templateSourceForGm(gm.id, "16x9")).toBe(await builtInSource("16x9"));

    // And the failed read is not remembered as the answer, or one missing file
    // would cost that game master their template until the server restarted.
    await Bun.write(templatePath(template.id), hdeSource({ marker: "gone" }));
    expect(await templateSourceForGm(gm.id, "16x9")).toContain("gone");
  });

  test("falls back when the row itself has gone", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(gm.id, hdeFile("mine.hde"));
    gms.update(gm.id, { templateId: template.id });
    templates.remove(template.id);

    expect(await templateSourceForGm(gm.id, "16x9")).toBe(await builtInSource("16x9"));
  });
});

describe("housekeeping", () => {
  test("a filed template is never mistaken for a stray file", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(gm.id, hdeFile("kept.hde"));

    // The regression that would cost every game master their collection: the
    // sweep walks the template directory now, so it has to read the table that
    // claims what is in it.
    expect(await findStrayFiles()).not.toContain(templatePath(template.id));

    await collectStrayFiles();
    expect(await Bun.file(templatePath(template.id)).exists()).toBe(true);
  });

  test("a file in the template directory that no row claims is a stray", async () => {
    const stray = join(TEMPLATE_DIR, "not-a-row");
    await Bun.write(stray, hdeSource());

    expect(await findStrayFiles()).toContain(stray);
    await collectStrayFiles();
    expect(await Bun.file(stray).exists()).toBe(false);
  });

  test("the sweep that runs on every character edit leaves templates alone", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(gm.id, hdeFile("kept.hde"));

    // `collectOrphanedUploads` reads the `uploads` table, which a template is
    // deliberately not in — it runs on nearly every character and campaign write,
    // and a template caught by it would be gone within minutes of being uploaded.
    await collectOrphanedUploads();

    expect(templates.byId(template.id)).not.toBeNull();
    expect(await Bun.file(templatePath(template.id)).exists()).toBe(true);
  });

  test("deleting a template takes its file with it", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(gm.id, hdeFile("bye.hde"));

    await deleteTemplate(template);

    expect(templates.byId(template.id)).toBeNull();
    expect(await Bun.file(templatePath(template.id)).exists()).toBe(false);
  });

  test("deleting a template whose file has already gone is not an error", async () => {
    const gm = makeGm();
    const { template } = await storeTemplate(gm.id, hdeFile("bye.hde"));
    await unlink(templatePath(template.id));

    expect(deleteTemplate(template)).resolves.toBeUndefined();
  });

  test("a game master's whole collection goes with them", async () => {
    const gm = makeGm();
    const first = await storeTemplate(gm.id, hdeFile("a.hde", { name: "A" }));
    const second = await storeTemplate(gm.id, hdeFile("b.hde", { name: "B" }));

    // Before the account rather than after: the database cascade takes the rows,
    // and once they are gone nothing on the instance can name the files.
    expect(await deleteTemplatesForGm(gm.id)).toBe(2);

    expect(await Bun.file(templatePath(first.template.id)).exists()).toBe(false);
    expect(await Bun.file(templatePath(second.template.id)).exists()).toBe(false);
    expect(templates.listForGm(gm.id)).toHaveLength(0);
  });
});
