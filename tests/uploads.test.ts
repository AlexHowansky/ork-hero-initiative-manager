/**
 * Upload intake.
 *
 * What matters here is that a file is checked by its content, capped in size,
 * and stored under a name that cannot be steered by whoever uploaded it — and
 * that a character file is readable before it is kept, since this app has to
 * read it again every time anyone looks at the character.
 */

import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import {
  collectStrayFiles,
  deleteUpload,
  findStrayFiles,
  portraitFromSheet,
  requireTotalWithinLimit,
  storeImage,
  storeSheet,
  uploadPath,
} from "../src/server/uploads.ts";
import { limits } from "../src/lib/config.ts";
import { uploads } from "../src/db/queries.ts";
import { parseHdc } from "../src/server/hero-sheet.ts";
import { hdcBytes, hdcFile } from "./helpers.ts";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0]);

function file(name: string, contents: Uint8Array | string, type = ""): File {
  return new File([contents as BlobPart], name, { type });
}

describe("character files", () => {
  test("are stored exactly as they arrived", async () => {
    const bytes = hdcBytes({ name: "Hero", characteristics: { SPD: 2 } });
    const upload = await storeSheet(new File([bytes as BlobPart], "hero.hdc"));

    const stored = new Uint8Array(await Bun.file(uploadPath(upload)).arrayBuffer());
    expect([...stored]).toEqual([...bytes]);
    expect(upload.mime).toBe("application/x-hero-designer-character");
  });

  test("get a generated name on disk, never the uploaded one", async () => {
    const upload = await storeSheet(hdcFile("../../etc/passwd.hdc"));

    // The uploaded name is kept only as metadata, and sanitised even there.
    expect(basename(upload.disk_path)).not.toContain("passwd");
    expect(upload.disk_path).not.toContain("..");
    expect(upload.original_name).not.toContain("/");
  });

  test("are named on disk after the row that describes them", async () => {
    const upload = await storeSheet(hdcFile());

    // One identifier, not two: a stray file names its own row, and a log line
    // carrying both cannot read as the same id mistyped.
    expect(basename(upload.disk_path)).toBe(upload.id);
  });

  test("must be a .hdc by extension", async () => {
    await expect(storeSheet(file("sheet.html", "<p>x</p>"))).rejects.toThrow(
      "Character files must be .hdc files exported from HERO Designer.",
    );
    await expect(storeSheet(file("sheet.exe", "x"))).rejects.toThrow(/\.hdc/);
  });

  test("must actually be a character file, not merely named like one", async () => {
    // The extension is the claim; parsing it is the check. A file kept without
    // this is a character whose sheet fails to open later, in front of a table.
    await expect(storeSheet(file("hero.hdc", "<html><body>not a character</body></html>")))
      .rejects.toThrow(/CHARACTER/i);
  });

  test("cannot be empty", async () => {
    await expect(storeSheet(file("hero.hdc", ""))).rejects.toThrow("empty");
  });

  test("are capped in size", async () => {
    const tooBig = "x".repeat(limits.uploadBytes + 1);
    await expect(storeSheet(file("big.hdc", tooBig))).rejects.toThrow(/limit/i);
  });

  test("record a hash of what was stored", async () => {
    const bytes = hdcBytes({ name: "Same" });
    const upload = await storeSheet(new File([bytes as BlobPart], "one.hdc"));
    const again = await storeSheet(new File([bytes as BlobPart], "two.hdc"));
    // Identical content hashes identically, which makes duplicates identifiable.
    expect(upload.sha256).toBe(again.sha256);
    expect(upload.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("card images", () => {
  test("are identified by their magic bytes", async () => {
    expect((await storeImage(file("a.png", PNG))).mime).toBe("image/png");
    expect((await storeImage(file("b.gif", GIF))).mime).toBe("image/gif");
  });

  test("reject a file that merely claims to be an image", async () => {
    // An HTML payload with an image name and content type: exactly the trick
    // that turns an "image" upload into stored XSS when only the name is checked.
    const disguised = file("evil.png", "<script>alert(1)</script>", "image/png");
    await expect(storeImage(disguised)).rejects.toThrow(/PNG, JPEG, GIF or WebP/);
  });

  test("are capped in size", async () => {
    const big = new Uint8Array(limits.uploadBytes + 1);
    big.set(PNG);
    await expect(storeImage(file("big.png", big))).rejects.toThrow(/limit|MB/i);
  });
});

describe("a submission carrying more than one file", () => {
  /** Just over half the limit: one fits, two do not. */
  const half = () => file("half.hdc", "x".repeat(Math.floor(limits.uploadBytes / 2) + 1024));

  test("is measured as a whole", () => {
    expect(() => requireTotalWithinLimit(half(), half())).toThrow(/together/i);
  });

  test("passes when the files fit between them", () => {
    expect(() => requireTotalWithinLimit(half(), null)).not.toThrow();
    expect(() => requireTotalWithinLimit(null, null)).not.toThrow();
  });
});

describe("the portrait inside a character file", () => {
  /** A believable image: real magic bytes, padded to a believable size. */
  function image(signature: Uint8Array, bytes: number): Uint8Array {
    const data = new Uint8Array(bytes);
    data.set(signature);
    // Noise after the header, so two images of the same size are still distinct.
    for (let i = signature.length; i < bytes; i += 1) data[i] = (i * 7) % 251;
    return data;
  }

  const fileWith = async (options: Parameters<typeof hdcBytes>[0]) =>
    await storeSheet(hdcFile("Hero.hdc", options));

  test("is lifted out of the file that carried it", async () => {
    const portrait = image(PNG, 4096);
    const sheet = await fileWith({ name: "Hero", image: portrait });

    const found = await portraitFromSheet(sheet);
    expect(found?.mime).toBe("image/png");
    expect(found?.kind).toBe("image");

    // Byte for byte what the file carried, not a re-encoding of it. The base64
    // in a real file is wrapped and indented, so this is also the check that the
    // whitespace never reaches the decoder.
    const stored = new Uint8Array(await Bun.file(uploadPath(found!)).arrayBuffer());
    expect([...stored]).toEqual([...portrait]);
  });

  test("is taken out of the file once it is a card of its own", async () => {
    const portrait = image(PNG, 4096);
    const sheet = await fileWith({ name: "Hero", image: portrait });
    const before = sheet.byte_size;

    expect(await portraitFromSheet(sheet)).not.toBeNull();

    // The picture is gone and the character is not: what is left still parses,
    // and still says everything about the character it said before.
    const stored = new Uint8Array(await Bun.file(uploadPath(sheet)).arrayBuffer());
    const character = parseHdc(stored);
    expect(character.image).toBeUndefined();
    expect(character.info.characterName).toBe("Hero");

    // And the row still describes the file it points at.
    const row = uploads.byId(sheet.id)!;
    expect(row.byte_size).toBe(stored.byteLength);
    expect(row.byte_size).toBeLessThan(before);
    expect(row.sha256).toBe(new Bun.CryptoHasher("sha256").update(stored).digest("hex"));
  });

  test("leaves a file it found nothing in exactly as it arrived", async () => {
    const bytes = hdcBytes({ name: "Plain" });
    const sheet = await storeSheet(new File([bytes as BlobPart], "Plain.hdc"));

    expect(await portraitFromSheet(sheet)).toBeNull();
    const stored = new Uint8Array(await Bun.file(uploadPath(sheet)).arrayBuffer());
    expect([...stored]).toEqual([...bytes]);
    expect(uploads.byId(sheet.id)!.byte_size).toBe(sheet.byte_size);
  });

  test("is identified by its content, not by what the file calls it", async () => {
    // The element says PNG; the bytes are a GIF, and the bytes decide — the same
    // rule every other image upload is held to.
    const sheet = await fileWith({ image: image(GIF, 5000), imageName: "portrait.png" });
    expect((await portraitFromSheet(sheet))?.mime).toBe("image/gif");
  });

  test("is not taken when it is too small to be a portrait", async () => {
    const sheet = await fileWith({ image: image(PNG, 900) });
    expect(await portraitFromSheet(sheet)).toBeNull();
    // And nothing was rewritten in the attempt.
    expect(uploads.byId(sheet.id)!.byte_size).toBe(sheet.byte_size);
  });

  test("is not taken when what it holds is not an image at all", async () => {
    const notAnImage = new TextEncoder().encode("<script>alert(1)</script>".repeat(300));
    const sheet = await fileWith({ image: notAnImage });
    expect(await portraitFromSheet(sheet)).toBeNull();
  });
});

describe("images are stored at the size, and in the format, they are best kept in", () => {
  /** A real picture, not a header with noise behind it: this one gets decoded. */
  const picture = async (width: number, height: number, format: "png" | "gif" = "png") => {
    const image = sharp({
      create: { width, height, channels: 3, background: { r: 160, g: 40, b: 60 } },
    });
    return new Uint8Array(await (format === "gif" ? image.gif() : image.png()).toBuffer());
  };

  /**
   * A shorter side comfortably over the limit, so every fixture here is a
   * picture that actually has to be scaled.
   *
   * Derived rather than written out, because the limit is no longer a number
   * anybody sets — it is twice the largest card the app allows (`lib/cards.ts`),
   * and a fixture with a literal in it goes quietly stale the day that moves:
   * `fitToCard` never enlarges, so a picture that has fallen under the limit
   * passes straight through and every assertion about scaling stops testing
   * anything.
   */
  const OVERSIZE = limits.storedImagePx + 120;

  const sizeOf = async (path: string) => {
    const { width, height, format } = await sharp(await Bun.file(path).arrayBuffer()).metadata();
    return { width, height, format };
  };

  test("a picture larger than a card is scaled down to it", async () => {
    const upload = await storeImage(file("big.png", await picture(2000, 1500)));

    // The shorter side is what has to cover the card, so that is what is fitted.
    expect(await sizeOf(uploadPath(upload))).toEqual({
      width: Math.round((2000 / 1500) * limits.storedImagePx),
      height: limits.storedImagePx,
      // A photograph in a lossless format is the case WebP wins by the most, so
      // this one is kept as WebP however it arrived.
      format: "webp",
    });
    expect(upload.mime).toBe("image/webp");
  });

  test("the shape of the picture is never changed", async () => {
    const tall = await storeImage(file("tall.png", await picture(OVERSIZE, OVERSIZE * 3)));
    const { width, height } = await sizeOf(uploadPath(tall));

    expect(width).toBe(limits.storedImagePx);
    expect(height! / width!).toBeCloseTo(3, 1);
  });

  test("nothing is cropped away", async () => {
    // A panorama keeps its panorama-ness: the card crops at display time, and the
    // rest of the picture is still in the file.
    const wide = await storeImage(file("wide.png", await picture(OVERSIZE * 5, OVERSIZE)));
    const { width, height } = await sizeOf(uploadPath(wide));

    expect(height).toBe(limits.storedImagePx);
    expect(width).toBe(limits.storedImagePx * 5);
  });

  test("a picture already small enough keeps its size, whatever format it ends up in", async () => {
    const original = await picture(300, 200);
    const upload = await storeImage(file("small.png", original));

    // Nothing is enlarged to fill the card — the size it arrived at is the size
    // it is kept at, even though the bytes may now be WebP rather than PNG.
    expect(await sizeOf(uploadPath(upload))).toMatchObject({ width: 300, height: 200 });
    expect(upload.byte_size).toBeLessThanOrEqual(original.byteLength);
  });

  test("a format WebP cannot beat is the one the picture keeps", async () => {
    // Sixteen bytes with a PNG header and nothing decodable behind them: the
    // encoder never gets a chance, so what was uploaded is what is stored.
    const upload = await storeImage(file("tiny.png", PNG));

    expect(upload.mime).toBe("image/png");
    const stored = new Uint8Array(await Bun.file(uploadPath(upload)).arrayBuffer());
    expect([...stored]).toEqual([...PNG]);
  });

  test("a GIF is fitted whole rather than flattened to its first frame", async () => {
    const upload = await storeImage(
      file("moving.gif", await picture(Math.round(OVERSIZE * (4 / 3)), OVERSIZE, "gif")),
    );

    // Whichever format wins, every frame is still there and the picture is the
    // size a card wants — a GIF must never come back as one still frame.
    const { pages, height } = await sharp(await Bun.file(uploadPath(upload)).arrayBuffer())
      .metadata();
    expect(height).toBe(limits.storedImagePx);
    expect(pages ?? 1).toBe(1);
    expect(upload.mime).toBe(`image/${(await sizeOf(uploadPath(upload))).format}`);
  });

  test("a portrait taken out of a character file is scaled like any other picture", async () => {
    const portrait = await picture(Math.round(OVERSIZE * 1.5), OVERSIZE);
    const sheet = await storeSheet(hdcFile("Hero.hdc", { image: portrait }));

    const found = await portraitFromSheet(sheet);
    expect(await sizeOf(uploadPath(found!))).toMatchObject({ height: limits.storedImagePx });
  });
});

describe("housekeeping", () => {
  test("finds and deletes files no row claims, and leaves claimed ones alone", async () => {
    const kept = await storeSheet(hdcFile("Kept.hdc"));
    // A file written straight into the upload directory, as an interrupted
    // upload or an older database would leave behind.
    const stray = join(dirname(uploadPath(kept)), "stray-file");
    await Bun.write(stray, "<p>nobody's</p>");

    expect(await findStrayFiles()).toContain(stray);
    expect(await findStrayFiles()).not.toContain(uploadPath(kept));

    await collectStrayFiles();

    expect(await Bun.file(stray).exists()).toBe(false);
    expect(await Bun.file(uploadPath(kept)).exists()).toBe(true);
  });

  test("deleting an upload whose file has already gone is not an error", async () => {
    const upload = await storeSheet(hdcFile("Gone.hdc"));
    await unlink(uploadPath(upload));

    await expect(deleteUpload(upload.id)).resolves.toBeUndefined();
  });
});
