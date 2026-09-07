/**
 * Browser tests for the behaviour that only exists in a real page: the segment
 * panel and its segment filter, and player screens updating live without a
 * refresh.
 *
 * These start their own server and drive a real Chromium, so they are slower than
 * the rest of the suite. They are skipped automatically when Playwright's browser
 * binaries aren't installed (`bunx playwright install chromium`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright";
import { serverOptions } from "../src/server/app.ts";
import { registerServer } from "../src/server/ws.ts";
import { gms } from "../src/db/queries.ts";
import { CARD_IMAGE_PX } from "../src/lib/cards.ts";
import { hdcBytes, rulesAvailable, unique } from "./helpers.ts";

const PASSWORD = "a-sufficiently-long-password";
const email = `${unique("gm")}@example.com`;

let browser: Browser | null = null;
let server: ReturnType<typeof Bun.serve>;
let base: string;

/** Playwright is optional; without its browsers these tests sit out. */
async function launch(): Promise<Browser | null> {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch();
  } catch {
    return null;
  }
}

beforeAll(async () => {
  gms.create(email, await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }));
  server = Bun.serve({ ...serverOptions, port: 0, development: false });
  registerServer(server as never);
  base = server.url.origin.replace(/\/$/, "");
  browser = await launch();
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

/** A fresh browser signed in as the game master, on the library. */
async function signedInGm(): Promise<Page> {
  const page = await (await browser!.newContext()).newPage();
  await page.goto(base);

  await page.getByRole("tab", { name: "Game master" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/gm");
  return page;
}

/** Signs in and builds a campaign with three characters, all through the UI. */
async function gmWithSession(): Promise<{ page: Page; code: string; campaignName: string }> {
  const page = await signedInGm();

  // A campaign and three characters, created through the dialogs.
  const campaignName = unique("Campaign");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Campaign name").fill(campaignName);
  await page.getByRole("button", { name: "Create campaign" }).click();
  // The panel of *this* campaign: an account with campaigns already has one on
  // screen, and it blinks out while the new campaign is being fetched.
  await page.getByText(`Characters in ${campaignName}`).waitFor();

  // SPD and DEX are what the segment panel is built out of. The two heroes are
  // SPD 12 and so act in every segment, which keeps the turn walk in these tests
  // one press per character; Strahd is SPD 2 and acts only in segments 6 and 12,
  // which is what the segment filter has to have something to hide.
  //
  // Thorin carries an INIT bonus as well, so the character panel has a number
  // there that is not the zero every unfilled character reads as. It is small on
  // purpose: DEX+INIT orders them Elara 20, Thorin 18, Strahd 10, which is the
  // order the turn walk below is written against.
  const cast = [
    ["Thorin", "pc", 12, 15, 3],
    ["Elara", "pc", 12, 20, 0],
    ["Strahd", "npc", 2, 10, 0],
  ] as const;

  for (const [name, kind, speed, dexterity, initiative] of cast) {
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Type").selectOption(kind);
    await page.getByLabel(/Character file/).setInputFiles({
      name: "sheet.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name }) as Uint8Array<ArrayBuffer>),
    });
    // Characteristics, so the session screens have totals to count down from.
    await page.getByLabel("SPD", { exact: true }).fill(String(speed));
    await page.getByLabel("DEX", { exact: true }).fill(String(dexterity));
    await page.getByLabel("INIT", { exact: true }).fill(String(initiative));
    await page.getByLabel("CON", { exact: true }).fill("20");
    await page.getByLabel("REC", { exact: true }).fill("8");
    await page.getByLabel("END", { exact: true }).fill("30");
    await page.getByLabel("STUN", { exact: true }).fill("25");
    await page.getByLabel("BODY", { exact: true }).fill("12");
    await page.getByRole("button", { name: "Add character" }).last().click();
    await page.getByRole("button", { name, exact: true }).waitFor();
  }

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.waitForURL("**/gm/sessions/**");
  const code = (await page.locator("code").first().innerText()).trim();

  // Starting a session brings the campaign's player characters in by itself, so
  // only the NPC is added by hand. DEX puts them in the order Elara, Thorin,
  // Strahd whichever way round they arrived.
  await page.getByRole("listitem").filter({ hasText: "Strahd" })
    .getByRole("button", { name: "Add" }).click();
  await stageCount(page, 3);

  return { page, code, campaignName };
}

/** Joins as a player and claims Thorin. */
async function playerIn(code: string, name: string, campaignName?: string): Promise<Page> {
  const page = await (await browser!.newContext()).newPage();
  await page.goto(`${base}/join?code=${encodeURIComponent(code)}`);
  await page.getByLabel("Player name").fill(name);
  await page.getByRole("button", { name: "Join session" }).click();
  await page.getByText("Choose your character").waitFor();
  await page.getByRole("button", { name: "Thorin" }).click();
  // The session page is headed by the campaign, the same as the console is; who
  // the player is and who they are playing are on their own panel below.
  if (campaignName) {
    await page.getByRole("heading", { name: campaignName, exact: true }).waitFor();
  }
  // The players panel names the character each player holds, which is a different
  // id from the slot it sits in and was once matched against the wrong one.
  await page
    .locator("section", { hasText: /Players \(/ })
    .getByText("Playing Thorin")
    .waitFor();
  // The character they hold has a panel of its own, which is where their sheet
  // is reached from.
  const mine = page.locator("section", { hasText: /My character/ });
  await mine.getByText("Thorin", { exact: true }).waitFor();
  await mine.getByRole("button", { name: "My sheet" }).waitFor();
  // The five characteristics that are looked up rather than spent, in the order
  // the sheet reads them. INIT is the one that would go unnoticed if it were
  // dropped, since every character the rest of the suite makes has it at zero.
  await mine.getByText("SPD 12 · DEX 15 · INIT 3 · CON 20 · REC 8").waitFor();
  return page;
}

/**
 * The stage panel, which both screens head the same way.
 *
 * Matched on the panel's own heading rather than on any text inside it: the log
 * names segments too, now that the clock writes a line each time the fight
 * reaches one, and a panel is what this wants rather than whatever mentions the
 * stage.
 */
const stagePanel = (page: Page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: /^Stage$/ }) });

/**
 * The clock, which both screens head with the turn and the segment together.
 *
 * A pattern rather than a string because the two numbers are one line now, and
 * every caller here is asking after one of them. Matched on the bar itself
 * rather than on the words anywhere: the log writes the same sentence each time
 * the fight reaches a segment, and an open log would otherwise answer for the
 * clock.
 */
const clock = (page: Page, pattern: RegExp) =>
  page.locator('p[aria-live="polite"]').filter({ hasText: pattern });

/**
 * The row whose turn it is.
 *
 * Which is how either screen says who is up, now that the bar says only where
 * the clock stands: both screens banner the row across its corner, and both
 * mark it `aria-current`, which is the part that means it rather than draws it.
 */
const onTurn = (page: Page) => stagePanel(page).locator('li[aria-current="true"]');

/**
 * Waits for the panel to hold `count` characters.
 *
 * Counted off the rows themselves, since the heading says only which segment the
 * fight is on. That makes this "how many rows are drawn" rather than "how many
 * are on the stage" — the two are the same only while the segment filter is
 * off, which every caller here is; the filter test does its own counting with
 * `namesIn`.
 *
 * Written as a retry loop because the number may still be crossing a socket and
 * bun:test's `expect` does not retry on its own. On timeout it asserts what it
 * last saw, so a failure says how many rows there actually were.
 */
const stageCount = async (page: Page, count: number) => {
  const deadline = Date.now() + 5000;
  let seen = -1;
  while (Date.now() < deadline) {
    seen = await stagePanel(page).locator("li").count();
    if (seen === count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(seen).toBe(count);
};

/**
 * The side of a library character's card that is facing the reader.
 *
 * A character's card in the library has two of everything the frame draws — the
 * artwork, the name's strip, the name itself — because it has a back with the
 * numbers on it, and both sides are mounted at all times so the far one is there
 * to be turned towards. So anything measured on a card has to say which side it
 * is asking about, or it matches twice. The campaign cards have no back and are
 * not scoped this way.
 */
const CARD_FRONT = ".card-face:not(.card-face-back)";
const CARD_BACK = ".card-face-back";

const namesIn = (page: Page) =>
  stagePanel(page)
    .locator("li")
    .evaluateAll((rows) => rows.map((row) => row.querySelector("span.truncate")?.textContent ?? ""));

/**
 * Drives a real HTML5 drag from one element to another.
 *
 * Playwright's own `dragAndDrop` works in pointer events, which native drag and
 * drop does not see; the sequence has to be dispatched by hand, sharing one
 * `DataTransfer` across it the way the browser would.
 */
async function dragCard(page: Page, from: string, to: string | "the character panel") {
  await page.evaluate(([source, target]: [string, string]) => {
    const panel = () =>
      [...document.querySelectorAll("section")].find((section) =>
        section.querySelector("h2")?.textContent?.startsWith("Characters in"),
      )!.children[1]!;
    const src = document.querySelector(source)!;
    const dst = target === "the character panel" ? panel() : document.querySelector(target)!;
    const dataTransfer = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      dst.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
    src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
  }, [from, to] as [string, string]);
}

/**
 * Drops a picture on an element, as dragging one in from the desktop would.
 *
 * The bytes are a PNG header and nothing else: the server identifies an image by
 * its magic bytes, and stores one it cannot decode exactly as it arrived, so this
 * is a real image as far as every rule on the way in is concerned.
 */
async function dropImage(target: Locator) {
  await target.evaluate((element) => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], "card.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  });
}

describe.skipIf(!process.env.CI && !process.env.E2E)("in a real browser", () => {
  test("a player's screen follows the game master with no refresh", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Alice", campaignName);

    // The player appears on the console without either side reloading.
    await gm.getByText("Alice").first().waitFor({ timeout: 5000 });

    // Turn marker.
    await gm.getByRole("listitem").filter({ hasText: "Strahd" })
      .getByRole("button", { name: /Give .* the turn/ }).click();
    await onTurn(player).filter({ hasText: "Strahd" }).waitFor({ timeout: 5000 });

    // Walking off the end of segment 12 opens turn 2 on both screens.
    for (let i = 0; i < 3; i += 1) {
      await gm.getByRole("button", { name: "Next" }).click();
      await gm.waitForTimeout(120);
    }
    await clock(player, /^Turn 2 Segment \d+$/).waitFor({ timeout: 5000 });

    // Removing an NPC takes it off the player's list.
    await gm.getByRole("listitem").filter({ hasText: "Strahd" })
      .getByRole("button", { name: "Remove" }).click();
    await stageCount(player, 2);
  }, 60_000);

  /**
   * Waits for a box to read a value, since the number may still be crossing a
   * socket. Playwright's own auto-retrying assertions are not bun:test's
   * `expect`, so the retry is written out.
   */
  const waitForValue = async (locator: Locator, expected: string) => {
    const deadline = Date.now() + 5000;
    let seen = "";
    while (Date.now() < deadline) {
      seen = (await locator.innerText()).trim();
      if (seen === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(seen).toBe(expected);
  };

  /** Presses a box and picks a change out of the dialog it opens. */
  const change = async (page: Page, box: Locator, amount: string) => {
    await box.click();
    await page.getByRole("dialog").getByRole("button", { name: amount, exact: true }).click();
  };

  test("what a character has left is edited from either screen", async () => {
    if (!browser) return;
    const { page: gm, code } = await gmWithSession();
    const player = await playerIn(code, "Nia");

    const gmRow = stagePanel(gm)
      .getByRole("listitem").filter({ hasText: "Thorin" });
    const myPanel = player.locator("section", { hasText: /My character/ });

    // The game master's row carries the five looked-up characteristics, in the
    // same line the player reads on their own panel, and does not repeat who is
    // playing what — the players panel beside it already says.
    await gmRow.getByText("SPD 12 · DEX 15 · INIT 3 · CON 20 · REC 8").waitFor();
    expect(await gmRow.innerText()).not.toContain("Played by");

    // The player's scene is the other way round: who holds which character, and
    // nobody's characteristics but their own.
    const playerRow = stagePanel(player)
      .getByRole("listitem").filter({ hasText: "Thorin" });
    await playerRow.getByText("Played by Nia (you)").waitFor();
    expect(await playerRow.innerText()).not.toContain("SPD");

    // Both screens start at the totals the library carries.
    await waitForValue(gmRow.getByLabel("STUN left for Thorin"), "25");
    await waitForValue(myPanel.getByLabel("END left for Thorin"), "30");

    // The game master takes 18 STUN off Thorin — the change, not the total, is
    // what the dialog asks for — and the player's own panel follows.
    await change(gm, gmRow.getByLabel("STUN left for Thorin"), "−18");
    await waitForValue(gmRow.getByLabel("STUN left for Thorin"), "7");
    await waitForValue(myPanel.getByLabel("STUN left for Thorin"), "7");

    // The player spends their own ENDURANCE, and the console follows.
    await change(player, myPanel.getByLabel("END left for Thorin"), "−19");
    await waitForValue(gmRow.getByLabel("END left for Thorin"), "11");

    // An exact value is still reachable, for putting a mistake right.
    await myPanel.getByLabel("END left for Thorin").click();
    await player.getByRole("dialog").getByLabel("Or set it exactly").fill("11");
    await player.getByRole("dialog").getByRole("button", { name: "Set" }).click();
    await waitForValue(gmRow.getByLabel("END left for Thorin"), "11");

    // A Recovery gives REC back to both, and stops at the totals. The library
    // gave everyone REC 8, so 7 STUN comes back to 15 and END is already full.
    await gmRow.getByLabel("Take a Recovery for Thorin").click();
    await waitForValue(gmRow.getByLabel("STUN left for Thorin"), "15");
    await waitForValue(gmRow.getByLabel("END left for Thorin"), "19");

    // The player may take their own, from their own panel, and both screens see it.
    await myPanel.getByLabel("Take a Recovery for Thorin").click();
    await waitForValue(myPanel.getByLabel("END left for Thorin"), "27");
    await waitForValue(gmRow.getByLabel("STUN left for Thorin"), "23");

    // A rest puts both back to full, from either screen, and leaves BODY alone.
    await gmRow.getByLabel("Rest Thorin").click();
    await waitForValue(gmRow.getByLabel("END left for Thorin"), "30");
    await waitForValue(gmRow.getByLabel("STUN left for Thorin"), "25");
    await waitForValue(myPanel.getByLabel("BODY left for Thorin"), "12");

    // The scene carries none of these for a player: someone else's are not
    // theirs to see, and their own are on the panel above rather than twice.
    const scene = stagePanel(player);
    expect((await scene.innerText()).replace(/\s+/g, " ")).not.toContain("STUN");

    // And the game master still sees every row's.
    const strahdOnConsole = stagePanel(gm)
      .getByRole("listitem").filter({ hasText: "Strahd" });
    expect(await strahdOnConsole.getByLabel("STUN left for Strahd").count()).toBe(1);
  }, 60_000);

  test("a hit bigger than CON stuns the character on both screens", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Rae", campaignName);

    const gmRow = stagePanel(gm).getByRole("listitem").filter({ hasText: "Thorin" });
    const myPanel = player.locator("section", { hasText: /My character/ });
    await waitForValue(gmRow.getByLabel("STUN left for Thorin"), "25");

    // Thorin is CON 20, so 21 is the first hit that stuns him. The player takes
    // it on their own panel: the rule is the fight's rather than the console's,
    // and must not depend on which screen pressed.
    await change(player, myPanel.getByLabel("STUN left for Thorin"), "−21");
    await waitForValue(myPanel.getByLabel("STUN left for Thorin"), "4");

    // Nobody pressed the Stunned button, and the pill is on him on both screens.
    await gmRow.getByTitle(/^Stunned/).waitFor({ timeout: 5000 });
    await myPanel.getByTitle(/^Stunned/).waitFor({ timeout: 5000 });

    // Both are told out loud, once. The full stop is what tells the toast from
    // the log line below it, which is a record rather than a sentence said.
    for (const page of [gm, player]) {
      await page
        .getByText("Thorin has become stunned.", { exact: true })
        .waitFor({ timeout: 5000 });
    }

    // And the log carries it as its own line, with nobody's name on the front:
    // the rules did this, not the game master. The line says which rule, since a
    // table reading back will want to know why a condition nobody set appeared.
    const toggle = gm.getByRole("button", { name: "Log", exact: true });
    await toggle.click();
    await gm.waitForTimeout(500);
    const line = gm
      .locator('aside[aria-label="Log"]')
      .getByRole("listitem")
      .filter({ hasText: "has taken more STUN than CON" });
    await line.waitFor({ timeout: 5000 });
    await line.getByText("Thorin has taken more STUN than CON", { exact: true }).waitFor();
    // The condition is drawn as the pill it is on Thorin's row, not as a word.
    await line.getByTitle(/^Stunned/).waitFor();
  }, 60_000);

  test("a hit that takes the last of the STUN knocks the character out", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Wes", campaignName);

    const gmRow = stagePanel(gm).getByRole("listitem").filter({ hasText: "Thorin" });
    const myPanel = player.locator("section", { hasText: /My character/ });
    await waitForValue(gmRow.getByLabel("STUN left for Thorin"), "25");

    // Thorin is CON 20 on STUN 25, so a 25 is both at once: past the CON, and
    // the last of what he had. That is the ordinary way a fight ends.
    await change(gm, gmRow.getByLabel("STUN left for Thorin"), "−25");
    await waitForValue(gmRow.getByLabel("STUN left for Thorin"), "0");

    // Both conditions, on both screens, with nobody having pressed a button.
    for (const row of [gmRow, myPanel]) {
      await row.getByTitle(/^Stunned/).waitFor({ timeout: 5000 });
      await row.getByTitle(/^Unconscious/).waitFor({ timeout: 5000 });
    }

    // And both are said out loud, to the game master and to the one player.
    for (const page of [gm, player]) {
      await page
        .getByText("Thorin has been knocked out.", { exact: true })
        .waitFor({ timeout: 5000 });
    }

    // Two lines in the log, each naming the rule it came from.
    const toggle = gm.getByRole("button", { name: "Log", exact: true });
    await toggle.click();
    await gm.waitForTimeout(500);
    const log = gm.locator('aside[aria-label="Log"]');
    const line = log.getByRole("listitem").filter({ hasText: "has had STUN reduced to zero" });
    await line.waitFor({ timeout: 5000 });
    await line.getByText("Thorin has had STUN reduced to zero", { exact: true }).waitFor();
    await line.getByTitle(/^Unconscious/).waitFor();
    await log.getByText("Thorin has taken more STUN than CON", { exact: true }).waitFor();
  }, 60_000);

  test("Unconscious is a button on the status dialog for both roles", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Tam", campaignName);

    // The game master sets it for anybody in the scene...
    const strahd = stagePanel(gm).getByRole("listitem").filter({ hasText: "Strahd" });
    await strahd.getByRole("button", { name: "Set Strahd's status" }).click();
    await gm.getByRole("button", { name: "Unconscious", exact: true }).click();
    await gm.getByRole("button", { name: "Close" }).click();
    await strahd.getByTitle(/^Unconscious/).waitFor({ timeout: 5000 });

    // ...and a player for the character they are playing, from their own panel.
    await player.getByRole("button", { name: "Set Thorin's status" }).click();
    await player.getByRole("button", { name: "Unconscious", exact: true }).click();
    await player.getByRole("button", { name: "Close" }).click();
    await gm
      .getByRole("listitem")
      .filter({ hasText: "Thorin" })
      .getByTitle(/^Unconscious/)
      .waitFor({ timeout: 5000 });
  }, 60_000);

  test("an exact set is a correction rather than a hit, however big", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    await playerIn(code, "Sim", campaignName);

    const gmRow = stagePanel(gm).getByRole("listitem").filter({ hasText: "Thorin" });
    await waitForValue(gmRow.getByLabel("STUN left for Thorin"), "25");

    // The whole 25 off, written as where the number ends up. A game master
    // putting a total right is not damage, whatever the size of the change.
    await gmRow.getByLabel("STUN left for Thorin").click();
    await gm.getByRole("dialog").getByLabel("Or set it exactly").fill("0");
    await gm.getByRole("dialog").getByRole("button", { name: "Set" }).click();
    await waitForValue(gmRow.getByLabel("STUN left for Thorin"), "0");

    expect(await gmRow.getByTitle(/^Stunned/).count()).toBe(0);
    // Nor knocked out, though the number it left him on is nought: a total put
    // right is not damage, and neither rule is asked about one.
    expect(await gmRow.getByTitle(/^Unconscious/).count()).toBe(0);
    expect(await gm.getByText("has become stunned.", { exact: false }).count()).toBe(0);
    expect(await gm.getByText("has been knocked out.", { exact: false }).count()).toBe(0);
  }, 60_000);

  test("an NPC can be brought on more than once, and each copy acts", async () => {
    if (!browser) return;
    const { page: gm, code } = await gmWithSession();
    const player = await playerIn(code, "Gus");

    // Strahd is already on the stage once; two more makes three.
    const library = gm
      .locator("section")
      .filter({ has: gm.getByRole("heading", { name: "Library" }) });

    // One of them carries no count. The row being lit rather than dimmed already
    // says the monster is in the fight, so a badge reading `1` would be that same
    // sentence a second time — and on a stage of single monsters, a column of
    // `1`s for the eye to learn to skip.
    const strahdRow = library.getByRole("listitem").filter({ hasText: "Strahd" });
    const strahdCount = strahdRow.locator('[title$="in the session"]');
    expect(await strahdCount.count()).toBe(0);

    await library.getByRole("listitem").filter({ hasText: "Strahd" })
      .getByRole("button", { name: "Add" }).click();
    await stageCount(gm, 4);
    await library.getByRole("listitem").filter({ hasText: "Strahd" })
      .getByRole("button", { name: "Add" }).click();
    await stageCount(gm, 5);

    // The NPC stayed in the library — that is what lets it be added again — and
    // says how many of it are out.
    const strahdCard = library.getByRole("listitem").filter({ hasText: "Strahd" });
    expect(await strahdCard.count()).toBe(1);
    // Past one it earns its place, and counts the copies on the stage.
    expect(await strahdCount.textContent()).toBe("3");
    expect((await strahdCard.innerText()).replace(/\s+/g, " ")).toContain("3");

    // Each copy is numbered, and the player sees the same numbers.
    const stage = stagePanel(gm);
    for (const n of ["1", "2", "3"]) {
      await stage.getByRole("listitem").filter({ hasText: `Strahd${n}` }).waitFor({ timeout: 5000 });
    }
    await stageCount(player, 5);

    // A full segment gives every copy its own phase rather than sticking on the first.
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await gm.getByRole("button", { name: "Next" }).click();
      await gm.waitForTimeout(150);
      seen.push((await onTurn(gm).innerText()).replace(/\s+/g, " "));
    }
    expect(seen.filter((line) => line.includes("Strahd"))).toHaveLength(3);
    expect(new Set(seen).size).toBe(5);

    // Removing the middle copy leaves the other two with the numbers they had.
    await stage.getByRole("listitem").filter({ hasText: "Strahd2" })
      .getByRole("button", { name: "Remove" }).click();
    await stageCount(gm, 4);
    await stage.getByRole("listitem").filter({ hasText: "Strahd1" }).waitFor({ timeout: 5000 });
    await stage.getByRole("listitem").filter({ hasText: "Strahd3" }).waitFor({ timeout: 5000 });
    expect(await stage.getByRole("listitem").filter({ hasText: "Strahd2" }).count()).toBe(0);
  }, 60_000);

  test("restarting takes both screens back to turn 1", async () => {
    if (!browser) return;
    const { page: gm, code } = await gmWithSession();
    const player = await playerIn(code, "Fran");

    // Into turn 2, with a phase set, so there is something to go back from.
    for (let i = 0; i < 4; i += 1) {
      await gm.getByRole("button", { name: "Next" }).click();
      await gm.waitForTimeout(120);
    }
    await clock(player, /^Turn 2 Segment \d+$/).waitFor({ timeout: 5000 });

    // Restarting asks first, and backing out of the question changes nothing.
    await gm.getByRole("button", { name: "Restart" }).click();
    await gm.getByRole("dialog", { name: "Start over at turn 1?" })
      .getByRole("button", { name: "Cancel" }).click();
    await gm.waitForTimeout(200);
    expect(await clock(gm, /^Turn 2 Segment \d+$/).count()).toBe(1);

    await gm.getByRole("button", { name: "Restart" }).click();
    await gm.getByRole("dialog", { name: "Start over at turn 1?" })
      .getByRole("button", { name: "Restart" }).click();

    // Turn one, nobody up, and the player sees it without a refresh.
    await clock(gm, /^Turn 1 Segment 12$/).waitFor({ timeout: 5000 });
    await clock(player, /^Turn 1 Segment 12$/).waitFor({ timeout: 5000 });
    expect(await onTurn(gm).count()).toBe(0);
    expect(await onTurn(player).count()).toBe(0);

    // The stage is untouched: the same three are still in the scene.
    expect(await namesIn(gm)).toEqual(["Elara", "Thorin", "Strahd"]);

    // And the next step opens turn one, segment twelve, at the top of the order.
    await gm.getByRole("button", { name: "Next" }).click();
    await onTurn(gm).filter({ hasText: "Elara" }).waitFor({ timeout: 5000 });
    expect(await clock(gm, /^Turn 1 Segment \d+$/).count()).toBe(1);
  }, 60_000);

  test("the player whose turn it is gets told", async () => {
    if (!browser) return;
    const { page: gm, code } = await gmWithSession();
    const player = await playerIn(code, "Dana");

    // Nobody is up yet, so nothing has been announced.
    expect(await player.getByText("It's your turn!").count()).toBe(0);

    // An NPC's turn is not this player's business.
    await gm.getByRole("listitem").filter({ hasText: "Strahd" })
      .getByRole("button", { name: /Give .* the turn/ }).click();
    await onTurn(player).filter({ hasText: "Strahd" }).waitFor({ timeout: 5000 });
    expect(await player.getByText("It's your turn!").count()).toBe(0);

    // Their own character's turn is.
    await gm.getByRole("listitem").filter({ hasText: "Thorin" })
      .getByRole("button", { name: /Give .* the turn/ }).click();
    await player.getByText("It's your turn!").waitFor({ timeout: 5000 });
  }, 60_000);

  test("the log is hidden until asked for, and says when the session began", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Dana", campaignName);

    /*
     * How much room the drawer is taking. Measured rather than asked, because a
     * collapsed drawer is still in the document — it is clipped to nothing by
     * `overflow-hidden`, which is what makes it slide rather than blink, and
     * Playwright's own visibility check does not look through that. The number
     * on screen is the honest question anyway: the whole promise of this drawer
     * is that closed, it costs the console nothing.
     */
    // By name: the console carries a settings drawer as well, built the same way
    // and out of the same markup, so "the aside" is no longer a thing to say.
    const logDrawer = (page: Page) => page.locator('aside[aria-label="Log"]');
    const drawerWidth = async (page: Page) =>
      (await logDrawer(page).boundingBox())?.width ?? 0;

    for (const page of [gm, player]) {
      // A 16:9 default viewport, so the drawer is a column and collapses
      // sideways.
      expect(await drawerWidth(page)).toBe(0);
      // Closed it is `inert` as well as clipped, so nothing in it can be
      // clicked or read out.
      expect(await logDrawer(page).getAttribute("inert")).not.toBeNull();

      // `exact`, because the drawer's own close button is also named for the log.
      const toggle = page.getByRole("button", { name: "Log", exact: true });

      await toggle.click();
      // Opening is a transition, so give it room to finish before measuring.
      await page.waitForTimeout(500);
      expect(await drawerWidth(page)).toBeGreaterThan(200);
      // The line was written before either of these screens existed: the console
      // had not opened its socket and the player had not been given the code. It
      // can only have come out of the database, on the snapshot.
      await logDrawer(page).getByText("Session started").waitFor({ timeout: 5000 });

      // All three ways out close it: the × in the drawer...
      await page.getByRole("button", { name: "Close the log" }).click();
      await page.waitForTimeout(500);
      expect(await drawerWidth(page)).toBe(0);

      // ...Escape, while it is open...
      await toggle.click();
      await page.waitForTimeout(500);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      expect(await drawerWidth(page)).toBe(0);

      // ...and the button that opened it.
      await toggle.click();
      await page.waitForTimeout(500);
      await toggle.click();
      await page.waitForTimeout(500);
      expect(await drawerWidth(page)).toBe(0);
    }
  }, 60_000);

  test("a player arriving writes itself onto the log, with no refresh", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();

    // The drawer is open *before* anybody joins, so what appears in it appears
    // because a snapshot arrived — not because the page was built again.
    await gm.getByRole("button", { name: "Log", exact: true }).click();
    const log = gm.locator('aside[aria-label="Log"]');
    await log.getByText("Session started").waitFor({ timeout: 5000 });
    expect(await log.getByText("Dana joined").count()).toBe(0);

    // `playerIn` joins and then claims Thorin, which is two events.
    await playerIn(code, "Dana", campaignName);

    await log.getByText("Dana joined").waitFor({ timeout: 5000 });
    await log.getByText("Dana selected Thorin").waitFor({ timeout: 5000 });
  }, 60_000);

  test("crossing segment 12 tells the whole table about the Recovery", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Dana", campaignName);

    // Segment 12 holds three phases — Elara, Thorin, Strahd — so the fourth press
    // is the one that leaves it, and nothing is announced before that.
    for (let i = 0; i < 3; i += 1) {
      await gm.getByRole("button", { name: "Next" }).click();
      await gm.waitForTimeout(120);
    }
    expect(await player.getByText("Post-Segment 12 Recovery").count()).toBe(0);
    expect(await gm.getByText("Post-Segment 12 Recovery").count()).toBe(0);

    await gm.getByRole("button", { name: "Next" }).click();
    await gm.getByText("Post-Segment 12 Recovery").waitFor({ timeout: 5000 });
    await player.getByText("Post-Segment 12 Recovery").waitFor({ timeout: 5000 });
  }, 60_000);

  test("a condition set by the game master reaches the players", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Nia", campaignName);

    // Nothing on anybody yet.
    expect(await player.getByTitle("Prone").count()).toBe(0);

    const strahd = gm.getByRole("listitem").filter({ hasText: "Strahd" });
    await strahd.getByRole("button", { name: "Set Strahd's status" }).click();

    // The dialog stays open between presses: one hit commonly leaves a character
    // both prone and stunned.
    await gm.getByRole("button", { name: "Prone", exact: true }).click();
    await gm.getByRole("button", { name: "Stunned", exact: true }).click();
    await gm.getByRole("button", { name: "Close" }).click();

    // `exact`, because the pill's own close control is titled "Remove Prone
    // from Strahd" and would otherwise answer to the same substring.
    await strahd.getByTitle("Prone", { exact: true }).waitFor({ timeout: 5000 });
    await strahd.getByTitle(/^Stunned/).waitFor({ timeout: 5000 });

    // And the player's scene follows without a reload.
    const theirStrahd = player.getByRole("listitem").filter({ hasText: "Strahd" });
    await theirStrahd.getByTitle("Prone").waitFor({ timeout: 5000 });

    // Taking it off again takes it off both screens.
    await strahd.getByRole("button", { name: "Set Strahd's status" }).click();
    await gm.getByRole("button", { name: "Prone", exact: true }).click();
    await gm.getByRole("button", { name: "Close" }).click();
    await theirStrahd.getByTitle("Prone").waitFor({ state: "detached", timeout: 5000 });
  }, 60_000);

  test("a condition can be taken off from the pill that says it is on", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Pen", campaignName);

    const strahd = gm.getByRole("listitem").filter({ hasText: "Strahd" });
    await strahd.getByRole("button", { name: "Set Strahd's status" }).click();
    await gm.getByRole("button", { name: "Prone", exact: true }).click();
    await gm.getByRole("button", { name: "Close" }).click();
    await strahd.getByTitle("Prone", { exact: true }).waitFor({ timeout: 5000 });

    // The close control on the pill itself, rather than a second trip through
    // the dialog. Its name carries the character, so one row's Prone is not the
    // next row's.
    await strahd.getByRole("button", { name: "Remove Prone from Strahd" }).click();

    await strahd.getByTitle("Prone", { exact: true })
      .waitFor({ state: "detached", timeout: 5000 });
    // And it went at the table, not just on the console.
    await player.getByRole("listitem").filter({ hasText: "Strahd" })
      .getByTitle("Prone").waitFor({ state: "detached", timeout: 5000 });

    // A player reading somebody else's row gets the word alone: the conditions
    // on a character they are not playing are not theirs to take off.
    expect(await player.getByRole("button", { name: /^Remove .* from Strahd$/ }).count()).toBe(0);
  }, 60_000);

  test("a player sets their own character's condition, and only theirs", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Omar", campaignName);

    // A player's scene is read-only: no control on anybody's row, their own
    // character included — theirs lives on their own panel.
    expect(await player.getByRole("button", { name: /Set .*'s status/ }).count()).toBe(1);

    await player.getByRole("button", { name: "Set Thorin's status" }).click();
    await player.getByRole("textbox", { name: "Add a tag" }).fill("On fire");
    await player.getByRole("button", { name: "Add", exact: true }).click();
    await player.getByRole("button", { name: "Close" }).click();

    // A typed tag keeps its word — on their own panel, on their row in the scene
    // beside it, and on the game master's row. Asked for exactly wherever the
    // pill carries a close control, since that control's own title names the
    // condition too ("Remove On fire from Thorin").
    await player.locator("section", { hasText: /My character/ })
      .getByTitle("On fire", { exact: true }).waitFor({ timeout: 5000 });
    await player.getByRole("listitem").filter({ hasText: "Thorin" })
      .getByTitle("On fire").waitFor({ timeout: 5000 });
    await gm.getByRole("listitem").filter({ hasText: "Thorin" })
      .getByTitle("On fire", { exact: true }).waitFor({ timeout: 5000 });
  }, 60_000);

  test("taking a played character out of the scene asks first", async () => {
    if (!browser) return;
    const { page: gm, code } = await gmWithSession();
    const player = await playerIn(code, "Ivy");

    const stage = stagePanel(gm);

    // An NPC nobody is playing goes without a question.
    await stage.getByRole("listitem").filter({ hasText: "Strahd" })
      .getByRole("button", { name: /Remove Strahd/ }).click();
    await stageCount(gm, 2);

    // Elara is a player character, but unclaimed — still no question.
    await stage.getByRole("listitem").filter({ hasText: "Elara" })
      .getByRole("button", { name: /Remove Elara/ }).click();
    await stageCount(gm, 1);

    // Thorin is being played, so this one is asked about — and refusing it
    // leaves the scene exactly as it was.
    await stage.getByRole("listitem").filter({ hasText: "Thorin" })
      .getByRole("button", { name: /Remove Thorin/ }).click();
    const asking = gm.getByRole("dialog", { name: "Take Thorin out of the scene?" });
    await asking.getByText("Ivy is playing them").waitFor();
    await asking.getByRole("button", { name: "Cancel" }).click();
    await stageCount(gm, 1);

    // Going through with it drops the player back to choosing a character.
    await stage.getByRole("listitem").filter({ hasText: "Thorin" })
      .getByRole("button", { name: /Remove Thorin/ }).click();
    await gm.getByRole("dialog", { name: "Take Thorin out of the scene?" })
      .getByRole("button", { name: "Remove" }).click();
    await stageCount(gm, 0);
    await player.getByText("Choose your character").waitFor({ timeout: 5000 });
  }, 60_000);

  test("the library keeps every character, blocked by who is in the scene", async () => {
    if (!browser) return;
    const { page: gm } = await gmWithSession();

    const library = gm
      .locator("section")
      .filter({ has: gm.getByRole("heading", { name: "Library" }) });
    const rowFor = (name: string) =>
      library.getByRole("listitem").filter({ hasText: name });

    // The name span, not the placeholder icon's — a character with no picture
    // draws one of those first.
    const namesInLibrary = () =>
      library.locator("li").evaluateAll((rows) =>
        rows.map((row) => row.querySelector("span.truncate")?.textContent ?? ""),
      );

    // Elara and Thorin came on with the session and Strahd was added by hand, so
    // all three are in the scene — and all three are still listed here, in the
    // first two blocks: heroes in the scene, then monsters in the scene.
    expect(await namesInLibrary()).toEqual(["Elara", "Thorin", "Strahd"]);

    // A hero already in the session cannot come on twice, so their Add is quiet.
    // A monster's never is — a fight can always want another goblin.
    const add = (name: string) => rowFor(name).getByRole("button", { name: "Add" });
    expect(await add("Elara").isDisabled()).toBe(true);
    expect(await add("Thorin").isDisabled()).toBe(true);
    expect(await add("Strahd").isDisabled()).toBe(false);

    // Nobody carries a count here, monster or hero. All three are on the stage
    // exactly once, and a lit row already says a character is in the fight — a
    // `1` beside it would be that same sentence again, on every row. The badge
    // comes out at the second copy, which the multi-copy test above is where to
    // see.
    for (const name of ["Elara", "Thorin", "Strahd"]) {
      expect(await rowFor(name).locator('[title$="in the session"]').count()).toBe(0);
    }

    // How bright an element actually renders: opacity composites down the tree,
    // so a dimmed row means every ancestor's opacity multiplied together.
    const brightness = (target: Locator) =>
      target.evaluate((element) => {
        let value = 1;
        for (let node: Element | null = element; node; node = node.parentElement) {
          value *= Number(window.getComputedStyle(node).opacity);
        }
        return value;
      });

    // Everyone is in the scene, so nothing is dimmed yet.
    expect(await brightness(rowFor("Strahd").locator("span.truncate"))).toBe(1);

    // Sheets are opened from here, not from the segment panel, and a character
    // who is not in the scene still has one to read.
    await rowFor("Strahd").getByRole("button", { name: "Sheet" }).click();
    await gm.locator("iframe").waitFor({ timeout: 5000 });
    await gm.keyboard.press("Escape");
    await gm.locator("iframe").waitFor({ state: "detached", timeout: 5000 });
    expect(
      await stagePanel(gm).getByRole("button", { name: "Sheet" }).count(),
    ).toBe(0);

    // Taking a hero off the stage gives their Add back, and drops them out of the
    // blocks that are in the scene — below the monster who still is.
    await stagePanel(gm).getByRole("listitem").filter({ hasText: "Elara" })
      .getByRole("button", { name: /Remove Elara/ }).click();
    await stageCount(gm, 2);
    expect(await add("Elara").isDisabled()).toBe(false);
    expect(await namesInLibrary()).toEqual(["Thorin", "Strahd", "Elara"]);

    // The rule above the first row out of the scene is heavier than the ones
    // between rows, so the boundary between the two halves is found at a glance.
    const ruleAbove = (name: string) =>
      rowFor(name).evaluate((row) => {
        const style = window.getComputedStyle(row);
        return { width: Number.parseFloat(style.borderTopWidth), colour: style.borderTopColor };
      });

    // In both themes, and by colour as well as by weight: a boundary that is only
    // a pixel heavier than the rule below it, in the same shade, is one nobody
    // can see. Checked in dark as well because that is exactly how it was missed.
    for (const theme of ["Light", "Dark"] as const) {
      await gm.getByRole("button", { name: theme, exact: true }).click();
      await gm.waitForTimeout(100);

      const boundary = await ruleAbove("Elara");
      const ordinary = await ruleAbove("Strahd");
      expect(boundary.width).toBeGreaterThan(ordinary.width);
      expect(boundary.colour).not.toBe(ordinary.colour);
    }

    // Out of the scene, so the row is dimmed — but not the control that would
    // bring them back, which is the whole point of a row in this state.
    expect(await brightness(rowFor("Elara").locator("span.truncate"))).toBeLessThan(1);
    expect(await brightness(add("Elara"))).toBe(1);
    expect(await brightness(rowFor("Thorin").locator("span.truncate"))).toBe(1);

    // And bringing them back puts them at the top again.
    await add("Elara").click();
    await stageCount(gm, 3);
    expect(await add("Elara").isDisabled()).toBe(true);
    expect(await namesInLibrary()).toEqual(["Elara", "Thorin", "Strahd"]);
    expect(await brightness(rowFor("Elara").locator("span.truncate"))).toBe(1);
  }, 60_000);

  test("the filter button narrows each screen to whoever is acting", async () => {
    if (!browser) return;
    const { page: gm, code } = await gmWithSession();
    const player = await playerIn(code, "Bob");

    // The fight opens on segment 12, where all three act — DEX orders them.
    expect(await namesIn(gm)).toEqual(["Elara", "Thorin", "Strahd"]);
    expect(await namesIn(player)).toEqual(["Elara", "Thorin", "Strahd"]);

    // Four presses walks segment 12 and opens segment 1 of turn 2, which belongs
    // to the two SPD 12 heroes alone: Strahd is SPD 2 and has no phase there.
    for (let i = 0; i < 4; i += 1) {
      await gm.getByRole("button", { name: "Next" }).click();
      await gm.waitForTimeout(120);
    }
    await clock(gm, /^Turn \d+ Segment 1$/).waitFor({ timeout: 5000 });
    await clock(player, /^Turn \d+ Segment 1$/).waitFor({ timeout: 5000 });

    // Everyone is still listed until the filter button is pressed.
    expect(await namesIn(gm)).toEqual(["Elara", "Thorin", "Strahd"]);

    const filterButton = (page: Page) =>
      stagePanel(page).getByRole("button", { name: /Show All|Show Acting/ });

    await filterButton(gm).click();
    await gm.waitForTimeout(200);
    expect(await namesIn(gm)).toEqual(["Elara", "Thorin"]);

    // One reader's choice is their own: the player still sees everybody.
    expect(await namesIn(player)).toEqual(["Elara", "Thorin", "Strahd"]);

    // And the player has the same button, working the same way.
    await filterButton(player).click();
    await player.waitForTimeout(200);
    expect(await namesIn(player)).toEqual(["Elara", "Thorin"]);

    // It is one setting, not one per segment: walking on to a segment Strahd
    // does act in brings them back without the button being touched.
    // Two heroes a segment, so ten presses walks segments 1 to 5 and opens 6.
    for (let i = 0; i < 10; i += 1) {
      await gm.getByRole("button", { name: "Next" }).click();
      await gm.waitForTimeout(120);
    }
    await clock(gm, /^Turn \d+ Segment 6$/).waitFor({ timeout: 5000 });
    expect(await namesIn(gm)).toEqual(["Elara", "Thorin", "Strahd"]);

    // Remembered across a reload, for the length of the session. Three more
    // presses finish segment 6 — Strahd's second phase is in it — and open 7,
    // which is the heroes' alone again.
    await gm.reload();
    await clock(gm, /^Turn \d+ Segment 6$/).waitFor({ timeout: 5000 });
    for (let i = 0; i < 3; i += 1) {
      await gm.getByRole("button", { name: "Next" }).click();
      await gm.waitForTimeout(120);
    }
    await clock(gm, /^Turn \d+ Segment 7$/).waitFor({ timeout: 5000 });
    expect(await namesIn(gm)).toEqual(["Elara", "Thorin"]);

    // Pressed again, the whole stage comes back.
    await filterButton(gm).click();
    await gm.waitForTimeout(200);
    expect(await namesIn(gm)).toEqual(["Elara", "Thorin", "Strahd"]);
  }, 60_000);

  test("the session console's columns can be dragged to a different balance", async () => {
    if (!browser) return;
    const { page: gm } = await gmWithSession();
    await gm.setViewportSize({ width: 1600, height: 900 });
    await gm.waitForTimeout(150);

    const panelWith = (name: string | RegExp) =>
      gm.locator("section").filter({ has: gm.getByRole("heading", { name }) });
    // Each panel fills the column it is in, so the panels are how the columns are
    // measured: the stage panel is the turn column, and the other two name
    // themselves.
    const turn = panelWith(/^Stage$/);
    const library = panelWith("Library");
    const players = panelWith(/^Players/);
    const widthOf = async (panel: Locator) => (await panel.boundingBox())!.width;
    // Left to right, which on the dashboard is the library, the fight it feeds,
    // and the people playing it.
    const columns = async () =>
      [await widthOf(library), await widthOf(turn), await widthOf(players)];

    const handles = {
      library: gm.getByRole("separator", { name: "Resize the library column" }),
      turn: gm.getByRole("separator", { name: "Resize the turn column" }),
      side: gm.getByRole("separator", { name: "Resize the players and library column" }),
    };
    const drag = async (handle: Locator, by: number) => {
      const box = (await handle.boundingBox())!;
      const y = box.y + box.height / 2;
      await gm.mouse.move(box.x + box.width / 2, y);
      await gm.mouse.down();
      await gm.mouse.move(box.x + box.width / 2 + by, y, { steps: 8 });
      await gm.mouse.up();
      await gm.waitForTimeout(100);
    };

    // Three columns, equal until somebody says otherwise.
    const [wasLibrary, wasTurn, wasPlayers] = await columns();
    expect(Math.abs(wasLibrary! - wasTurn!)).toBeLessThan(2);
    expect(Math.abs(wasTurn! - wasPlayers!)).toBeLessThan(2);
    const total = wasLibrary! + wasTurn! + wasPlayers!;

    // The library's boundary is the first one, and takes from everything to its
    // right — which is still sharing what is left equally, so the two beyond it
    // give up half each.
    await drag(handles.library, 140);
    let [nowLibrary, nowTurn, nowPlayers] = await columns();
    expect(nowLibrary!).toBeCloseTo(wasLibrary! + 140, -1);
    expect(nowLibrary! + nowTurn! + nowPlayers!).toBeCloseTo(total, -1);

    // The turn's boundary is between the last two and leaves the first alone.
    const beforeSecond = nowLibrary!;
    await drag(handles.turn, 90);
    [nowLibrary, nowTurn, nowPlayers] = await columns();
    expect(nowLibrary!).toBeCloseTo(beforeSecond, -1);
    expect(nowTurn!).toBeCloseTo(total - beforeSecond - nowPlayers!, -1);
    expect(nowPlayers!).toBeLessThan(wasPlayers!);

    // Dragged to the edge, the columns beyond keep their floor — a sixth of the
    // console each — rather than being crushed out of existence.
    await drag(handles.library, 2000);
    [nowLibrary, nowTurn, nowPlayers] = await columns();
    expect(nowTurn!).toBeGreaterThan(total / 6 - 2);
    expect(nowPlayers!).toBeGreaterThan(total / 6 - 2);

    // And each boundary gives its column back on a double-click.
    await handles.library.dblclick();
    await handles.turn.dblclick();
    await gm.waitForTimeout(150);
    const [again, andAgain] = await columns();
    expect(again!).toBeCloseTo(wasLibrary!, -1);
    expect(andAgain!).toBeCloseTo(wasTurn!, -1);

    // Two halves rather than a dashboard, and not one of the dashboard's own
    // boundaries survives it: the stack on the left is the code, the players and
    // the library together, so neither of the gutters that stood between those
    // three is a gutter any more. What is left is the one between that stack and
    // the fight.
    await gm.setViewportSize({ width: 900, height: 1200 });
    await gm.waitForTimeout(200);
    expect(await handles.library.isVisible()).toBe(false);
    expect(await handles.turn.isVisible()).toBe(false);
    expect(await handles.side.isVisible()).toBe(true);

    // The library is in that left-hand stack now, so it is how the stack is
    // measured — and the boundary sizes the stack, not the fight beyond it.
    const half = await widthOf(library);
    await drag(handles.side, -80);
    expect(await widthOf(library)).toBeCloseTo(half - 80, -1);

    // Stacked, there is nothing to resize at all.
    await gm.setViewportSize({ width: 500, height: 900 });
    await gm.waitForTimeout(200);
    expect(await handles.side.isVisible()).toBe(false);
  }, 60_000);

  test("the player screen's two columns can be dragged to a different balance", async () => {
    if (!browser) return;
    const { code } = await gmWithSession();
    const player = await playerIn(code, "Vex");
    await player.setViewportSize({ width: 1400, height: 1000 });
    await player.waitForTimeout(200);

    // The panels fill the columns they are in, so they are how the columns are
    // measured: the players list is the first column, the scene the second.
    const panelWith = (name: string | RegExp) =>
      player.locator("section").filter({ has: player.getByRole("heading", { name }) });
    const mine = panelWith(/^Players/);
    const scene = panelWith(/^Stage$/);
    const widthOf = async (panel: Locator) => (await panel.boundingBox())!.width;
    const handle = player.getByRole("separator", { name: "Resize your column" });

    const drag = async (by: number) => {
      const box = (await handle.boundingBox())!;
      const y = box.y + box.height / 2;
      await player.mouse.move(box.x + box.width / 2, y);
      await player.mouse.down();
      await player.mouse.move(box.x + box.width / 2 + by, y, { steps: 8 });
      await player.mouse.up();
      await player.waitForTimeout(100);
    };

    // The scene starts the wider of the two, which is the balance the screen has
    // always drawn.
    const wasMine = await widthOf(mine);
    const wasScene = await widthOf(scene);
    expect(wasScene).toBeGreaterThan(wasMine);
    const total = wasMine + wasScene;

    // Dragging the boundary gives the player's own column what the scene loses.
    await drag(160);
    expect(await widthOf(mine)).toBeCloseTo(wasMine + 160, -1);
    expect((await widthOf(mine)) + (await widthOf(scene))).toBeCloseTo(total, -1);

    // The other way, and the scene grows instead.
    await drag(-260);
    expect(await widthOf(mine)).toBeCloseTo(wasMine - 100, -1);

    // Dragged to either edge neither column is crushed out of existence — a
    // sixth of the split is as narrow as either may be squeezed — and the handle
    // is still there to be taken hold of at both ends, which is only true while
    // a squeezed column keeps its contents to itself.
    await drag(-2000);
    const squeezed = await widthOf(mine);
    expect(squeezed).toBeGreaterThan(total / 6 - 2);
    await drag(2000);
    expect(await widthOf(mine)).toBeGreaterThan(squeezed);
    expect(await widthOf(scene)).toBeGreaterThan(total / 6 - 2);

    // A double-click hands the boundary back to the share it began with.
    await handle.dblclick();
    await player.waitForTimeout(150);
    expect(await widthOf(mine)).toBeCloseTo(wasMine, -1);
    expect(await widthOf(scene)).toBeCloseTo(wasScene, -1);

    // Stacked, the panels are one column and there is no boundary to drag.
    await player.setViewportSize({ width: 700, height: 1000 });
    await player.waitForTimeout(200);
    expect(await handle.isVisible()).toBe(false);

    await player.close();
  }, 60_000);

  test("the library's two columns can be dragged to a different balance", async () => {
    if (!browser) return;
    const gm = await signedInGm();
    await gm.setViewportSize({ width: 1600, height: 900 });

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    const panelWith = (name: string | RegExp) =>
      gm.locator("section").filter({ has: gm.getByRole("heading", { name }) });
    const campaigns = panelWith("Campaigns");
    const characters = panelWith(/^Characters in /);
    const handle = gm.getByRole("separator", { name: "Resize the campaigns column" });
    const widthOf = async (panel: Locator) => (await panel.boundingBox())!.width;

    await handle.waitFor();
    // Where the automatic fit left it: the width that holds a whole number of
    // card columns. Noted so the reset at the end can be checked against it.
    const fitted = await widthOf(campaigns);
    const together = fitted + (await widthOf(characters));

    const drag = async (by: number) => {
      const box = (await handle.boundingBox())!;
      const y = box.y + box.height / 2;
      await gm.mouse.move(box.x + box.width / 2, y);
      await gm.mouse.down();
      await gm.mouse.move(box.x + box.width / 2 + by, y, { steps: 8 });
      await gm.mouse.up();
      await gm.waitForTimeout(100);
    };

    // What the campaign panel takes, the character panel gives up: the two still
    // fill the same room between them.
    await drag(150);
    expect(await widthOf(campaigns)).toBeCloseTo(fitted + 150, -1);
    expect((await widthOf(campaigns)) + (await widthOf(characters))).toBeCloseTo(together, -1);

    // Dragged off the left edge, the panel stops at one whole card rather than
    // collapsing — the minimum is the card track, measured, not a number here.
    const cardWidth = (await gm
      .locator(`article:has(button[aria-label="Select ${campaignName}"])`)
      .boundingBox())!.width;
    await drag(-2000);
    const squeezed = await widthOf(campaigns);
    expect(squeezed).toBeGreaterThan(cardWidth);
    expect(squeezed).toBeLessThan(cardWidth + 100);

    // And the automatic fit takes the width back when the handle is given back.
    await handle.dblclick();
    await gm.waitForTimeout(100);
    expect(await widthOf(campaigns)).toBeCloseTo(fitted, -1);

    // Stacked, there is nothing to resize and no handle to reach.
    await gm.setViewportSize({ width: 800, height: 1400 });
    await gm.waitForTimeout(150);
    expect(await handle.isVisible()).toBe(false);
  }, 60_000);

  test("a card leaves the row only once it no longer fits", async () => {
    if (!browser) return;
    const gm = await signedInGm();
    await gm.setViewportSize({ width: 1600, height: 900 });

    const names = [unique("Campaign"), unique("Campaign"), unique("Campaign")];
    for (const name of names) {
      await gm.getByRole("button", { name: "New", exact: true }).click();
      await gm.getByLabel("Campaign name").fill(name);
      await gm.getByRole("button", { name: "Create campaign" }).click();
      await gm.getByText(`Characters in ${name}`).waitFor();
    }

    const campaigns = gm
      .locator("section")
      .filter({ has: gm.getByRole("heading", { name: "Campaigns" }) });
    const cards = campaigns.locator("article");
    const handle = gm.getByRole("separator", { name: "Resize the campaigns column" });
    await handle.waitFor();

    /** The margins the cards sit in, and how many of them share the top row. */
    const layout = async () => {
      const panel = (await campaigns.boundingBox())!;
      const boxes = await cards.evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top };
        }),
      );
      const top = Math.min(...boxes.map((box) => box.top));
      const row = boxes.filter((box) => Math.abs(box.top - top) < 1);
      return {
        columns: row.length,
        before: Math.min(...row.map((box) => box.left)) - panel.x,
        after: panel.x + panel.width - Math.max(...row.map((box) => box.right)),
      };
    };

    // Flush against the last column, the cards sit in the same margin on both
    // sides. A reserved-but-unused scrollbar gutter used to make the right one
    // twice the left, and cost the next card the room it needed besides.
    const fitted = await layout();
    expect(fitted.columns).toBeGreaterThan(1);
    expect(Math.abs(fitted.after - fitted.before)).toBeLessThan(2);

    // What another column would cost: a card and the gap before it, measured off
    // the two that are on screen rather than assumed, since the deployment picks
    // how large a card is drawn.
    const [first, second] = await cards.evaluateAll((nodes) =>
      nodes.slice(0, 2).map((node) => node.getBoundingClientRect()),
    );
    const step = second!.left - first!.left;

    const drag = async (by: number) => {
      const box = (await handle.boundingBox())!;
      const y = box.y + box.height / 2;
      await gm.mouse.move(box.x + box.width / 2, y);
      await gm.mouse.down();
      await gm.mouse.move(box.x + box.width / 2 + by, y, { steps: 8 });
      await gm.mouse.up();
      await gm.waitForTimeout(100);
    };

    // Room for all but a sliver of another card is not room for another card, and
    // giving nearly all of that room back does not cost the row a card either.
    await drag(step - 24);
    expect((await layout()).columns).toBe(fitted.columns);
    await drag(-(step - 36));
    expect((await layout()).columns).toBe(fitted.columns);

    // Only once the drag passes the width the last card needs does the row lose it.
    await drag(-24);
    expect((await layout()).columns).toBe(fitted.columns - 1);
  }, 60_000);

  test("cards are drawn at the size the deployment asked for", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    // The picture is what the setting measures, so the picture is what is
    // measured here: the square image well of a card, in CSS pixels.
    // The well is found by its own shape rather than through a control inside it.
    // It used to hold a full-bleed select button whose box was the picture's box,
    // but the card tilts now (`HoverCard`) and the whole card is the select
    // control, so that button's box is the card's.
    const campaignCard = `article:has(button[aria-label="Select ${campaignName}"])`;
    const well = gm.locator(`${campaignCard} .aspect-square`).first();
    const box = (await well.boundingBox())!;

    expect(Math.round(box.width)).toBe(CARD_IMAGE_PX.default);
    // Square, and the card around it is taller than its picture — the border and
    // the name below it are extra, as the setting's documentation promises.
    expect(Math.round(box.height)).toBe(CARD_IMAGE_PX.default);
    const card = (await well.locator("xpath=ancestor::article[1]").boundingBox())!;
    expect(card.height).toBeGreaterThan(box.height);

    // And the card is a playing card: five wide by seven tall, with the square
    // picture the top five of those sevens and the name strip the bottom two.
    expect(card.height / card.width).toBeCloseTo(7 / 5, 2);
    expect((card.height - box.height) / card.width).toBeCloseTo(2 / 5, 1);

    // A campaign card is framed too, in its own artwork rather than the
    // character frame — which is how the two kinds of card tell themselves apart.
    const campaignFrame = gm.locator(`${campaignCard} .card-frame`);
    await campaignFrame.waitFor();
    expect(
      await campaignFrame.evaluate((el) => getComputedStyle(el).backgroundImage),
    ).toContain("/frames/campaign.webp");
  }, 60_000);

  test("a narrow window shows fewer cards rather than larger ones", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    // Narrow enough for the stacked layout and for a single column of cards, and
    // still several times a card wide — which is the case that used to go wrong:
    // the lone column took the whole width and the card was drawn across all of
    // it, well past the size anybody had asked for.
    await gm.setViewportSize({ width: 500, height: 900 });

    const card = gm.locator(`article:has(button[aria-label="Select ${campaignName}"])`);
    const well = card.locator(".aspect-square").first();

    const width = async () => Math.round((await well.boundingBox())!.width);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await width()) !== CARD_IMAGE_PX.default) {
      await gm.waitForTimeout(50);
    }

    // The size is a ceiling, not a target.
    expect(await width()).toBe(CARD_IMAGE_PX.default);

    // And the room left over really is room: the card is a fraction of the grid
    // it sits in, rather than the grid having shrunk to the card.
    // Every track is one card wide — none of them stretched to take up the slack —
    // and the slack is left as slack: the row is narrower than the grid holding
    // it, which is the whole of what "fewer cards rather than larger ones" means.
    const gridBox = card.locator("xpath=ancestor::div[contains(@class,'grid-cols-')][1]");
    const grid = (await gridBox.boundingBox())!;
    const laid = await gridBox.evaluate((el) => {
      const style = getComputedStyle(el);
      return { tracks: style.gridTemplateColumns.split(" "), gap: Number.parseFloat(style.columnGap) };
    });

    // The card's border on each side is what the track adds to the picture.
    expect(new Set(laid.tracks)).toEqual(new Set([`${CARD_IMAGE_PX.default + 2}px`]));

    const row = laid.tracks.length * (CARD_IMAGE_PX.default + 2)
      + (laid.tracks.length - 1) * laid.gap;
    expect(grid.width).toBeGreaterThan(row);

    await gm.close();
  }, 60_000);

  test("an NPC card is printed in the NPC cut of the frame", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    await gm.getByRole("button", { name: "Add", exact: true }).click();
    await gm.getByLabel("Name").fill("Goblin");
    await gm.getByLabel("Type").selectOption("npc");
    await gm.getByLabel(/Character file/).setInputFiles({
      name: "sheet.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Goblin" }) as Uint8Array<ArrayBuffer>),
    });
    await gm.getByRole("button", { name: "Add character" }).last().click();
    await gm.getByRole("button", { name: "Goblin", exact: true }).waitFor();

    const card = gm.locator(`article:has(button[aria-label="Goblin"])`);
    const frame = card.locator(`${CARD_FRONT} .card-frame`);
    await frame.waitFor();

    // Asserted on the URL rather than on pixels: which file the card asks for is
    // what pins the wiring, and it stays true however the artwork is redrawn.
    const image = await frame.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(image).toContain("/frames/character-npc.webp");
    expect(image).not.toContain("/frames/character-pc.webp");

    // And it is plain stock: the foil is a player character's card alone, which
    // is the other way the two kinds tell themselves apart.
    expect(await card.locator(".card-foil").count()).toBe(0);
  }, 60_000);

  test("a character card is printed in the frame, with its name on the panel", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    await gm.getByRole("button", { name: "Add", exact: true }).click();
    // Said out loud, because the dialog opens on NPC: this test is about the
    // player character's frame and its foil, so it has to ask for one.
    await gm.getByLabel("Type").selectOption("pc");
    await gm.getByLabel("Name").fill("Framed");
    await gm.getByLabel(/Character file/).setInputFiles({
      name: "sheet.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Framed" }) as Uint8Array<ArrayBuffer>),
    });
    await gm.getByRole("button", { name: "Add character" }).last().click();
    await gm.getByRole("button", { name: "Framed", exact: true }).waitFor();

    const card = gm.locator(`article:has(button[aria-label="Framed"])`);
    const frame = card.locator(`${CARD_FRONT} .card-frame`);
    await frame.waitFor();

    // The artwork is actually resolved rather than left as an unset variable —
    // its address arrives from /appearance.css, so this fails if that is missing.
    const image = await frame.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(image).toContain("/frames/character-pc.webp");

    // A player character's card, and so the one card that is printed on foil.
    expect(await card.locator(".card-foil").count()).toBe(1);

    // It covers the card but for its border, so its window lands where the art
    // expects. The border is deliberately left showing: it is the hover and
    // keyboard-focus highlight, and art painted over it would take that away.
    const cardBox = (await card.boundingBox())!;
    const frameBox = (await frame.boundingBox())!;
    const border = await card
      .locator(".card")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).borderTopWidth));
    expect(border).toBeGreaterThan(0);
    expect(frameBox.width).toBeCloseTo(cardBox.width - 2 * border, 0);
    expect(frameBox.height).toBeCloseTo(cardBox.height - 2 * border, 0);

    // And the name sits centred on the panel the art paints — not in the card's
    // own bottom two sevenths, which would put it over the frame's lower border.
    // The panel runs 72.7% to 96.5% of the card's height, so its centre is 84.6%;
    // what lands here is a whisker above that because the strip is inside the
    // tile, which is inset from this box by the card's hairline border.
    const name = (await card.locator(CARD_FRONT).getByText("Framed", { exact: true })
      .boundingBox())!;
    const centre = (name.y + name.height / 2 - cardBox.y) / cardBox.height;
    expect(centre).toBeCloseTo(0.843, 2);

    // No kind badge on a library card: the frame says which kind it is, so the
    // pill would only repeat the artwork over the top of it.
    expect(await card.locator(CARD_FRONT).getByText("PC", { exact: true }).count()).toBe(0);

    // The corner controls are bare glyphs stacked down the picture's top right,
    // inside the bevel that keeps the window's own corner out of reach: on the
    // darker template the window does not begin until y=5% at x=95.5%.
    const control = async (name: RegExp) =>
      (await card.getByRole("button", { name }).boundingBox())!;
    const view = await control(/^View /);
    const edit = await control(/^Edit /);
    const bin = await control(/^Delete /);

    // The stack is right up against the frame — its right edge is 96% of the way
    // across, which is as far as the bevelled corner allows the glyph to go.
    for (const b of [view, edit, bin]) {
      const right = (b.x + b.width - cardBox.x) / cardBox.width;
      expect(right).toBeGreaterThan(0.94);
      expect(right).toBeLessThan(0.965);
    }
    expect((view.y - cardBox.y) / cardBox.height).toBeGreaterThan(0.05);
    expect((view.y - cardBox.y) / cardBox.height).toBeLessThan(0.10);
    // In that order, top to bottom, in one column.
    expect(view.y).toBeLessThan(edit.y);
    expect(edit.y).toBeLessThan(bin.y);
    expect(edit.x).toBe(view.x);
    expect(bin.x).toBe(view.x);
    // And the whole stack stays inside the window, clear of the divider at 64%.
    expect((bin.y + bin.height - cardBox.y) / cardBox.height).toBeLessThan(0.63);

    // No pill behind them. Without this the placement above would still pass with
    // the old buttons, so this is what pins the look rather than the position.
    const fill = await card
      .getByRole("button", { name: /^Delete / })
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill).toBe("rgba(0, 0, 0, 0)");

    // And the name is drawn in the same ink in both themes, because the panel it
    // is drawn on is the same pale artwork in both. The strip carries a light
    // theme of its own (`CARD_CAPTION_FRAMED`), so switching the page to dark
    // must not touch the name — and must not paint the panel out from under it
    // with that theme's own background either. Left until last, since switching
    // theme reflows the page every measurement above was taken from.
    const caption = card.locator(`${CARD_FRONT} .card-caption`);
    const ink = async () => {
      await gm.waitForTimeout(100);
      return caption.evaluate((el) => {
        const style = getComputedStyle(el);
        return { colour: style.color, background: style.backgroundColor };
      });
    };

    await gm.getByRole("button", { name: "Light", exact: true }).click();
    const light = await ink();
    await gm.getByRole("button", { name: "Dark", exact: true }).click();
    const dark = await ink();

    expect(dark.colour).toBe(light.colour);
    expect(light.background).toBe("rgba(0, 0, 0, 0)");
    expect(dark.background).toBe("rgba(0, 0, 0, 0)");
  }, 60_000);

  test("P and N set the kind of the card the pointer is on", async () => {
    if (!browser) return;
    const gm = await signedInGm();
    // A key goes to the page the browser is typing into, and the tests before
    // this one leave theirs open. A click does not need it and a keystroke does.
    await gm.bringToFront();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    // Two of them, because the point of the keys is that they mean the card
    // under the pointer rather than a selection.
    for (const name of ["Hero", "Bystander"]) {
      await gm.getByRole("button", { name: "Add", exact: true }).click();
      await gm.getByLabel("Name").fill(name);
      await gm.getByLabel(/Character file/).setInputFiles({
      name: "sheet.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name }) as Uint8Array<ArrayBuffer>),
    });
      await gm.getByRole("button", { name: "Add character" }).last().click();
      await gm.getByRole("button", { name, exact: true }).waitFor();
    }

    /** Which frame a card is printed in, which is what says what kind it is. */
    const frameOf = async (name: string) =>
      gm
        .locator(`article:has(button[aria-label="${name}"]) ${CARD_FRONT} .card-frame`)
        .evaluate((el) => getComputedStyle(el).backgroundImage);

    /**
     * Waits for a card to be printed in a given frame.
     *
     * The frame *is* the answer — the key says nothing else, deliberately — so
     * this is both how the test waits and what it is waiting for.
     */
    const framed = async (name: string, kind: "pc" | "npc") => {
      const deadline = Date.now() + 5000;
      let seen = "";
      while (Date.now() < deadline) {
        seen = await frameOf(name);
        if (seen.includes(`/frames/character-${kind}.webp`)) return seen;
        await gm.waitForTimeout(50);
      }
      return seen;
    };

    // A character added without saying otherwise is an NPC, which is the whole
    // reason these keys are worth having.
    expect(await frameOf("Hero")).toContain("/frames/character-npc.webp");

    await gm.locator(`article:has(button[aria-label="Hero"])`).hover();
    await gm.keyboard.press("p");
    expect(await framed("Hero", "pc")).toContain("/frames/character-pc.webp");

    // And only that card: the key means the one under the pointer.
    expect(await frameOf("Bystander")).toContain("/frames/character-npc.webp");

    // Nothing is announced. The card is the answer, and a toast over a change
    // the reader is already looking at is one more thing to dismiss.
    expect(await gm.locator(".alert").count()).toBe(0);

    // Back again, from the same card.
    await gm.keyboard.press("n");
    expect(await framed("Hero", "npc")).toContain("/frames/character-npc.webp");

    // And it survives a reload, so the key really saved rather than only redrew.
    await gm.locator(`article:has(button[aria-label="Bystander"])`).hover();
    await gm.keyboard.press("p");
    expect(await framed("Bystander", "pc")).toContain("/frames/character-pc.webp");
    await gm.reload();
    // A reload does not remember which campaign was open, so it is chosen again.
    await gm.getByRole("button", { name: `Select ${campaignName}` }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();
    expect(await frameOf("Bystander")).toContain("/frames/character-pc.webp");

    await gm.close();
  }, 60_000);

  test("a name being typed is not a hot key", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    await gm.getByRole("button", { name: "Add", exact: true }).click();
    await gm.getByLabel("Name").fill("Pippin");
    await gm.getByLabel(/Character file/).setInputFiles({
      name: "sheet.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Pippin" }) as Uint8Array<ArrayBuffer>),
    });
    await gm.getByRole("button", { name: "Add character" }).last().click();
    await gm.getByRole("button", { name: "Pippin", exact: true }).waitFor();

    // The pointer is on the card and the caret is in a box. The box wins: a `p`
    // typed into a name is a letter of the name.
    await gm.locator(`article:has(button[aria-label="Pippin"])`).hover();
    await gm.getByRole("button", { name: "Add", exact: true }).click();
    await gm.getByLabel("Name").fill("");
    await gm.getByLabel("Name").pressSequentially("pn");

    expect(await gm.getByLabel("Name").inputValue()).toBe("pn");

    await gm.close();
  }, 60_000);

  test("a character's card turns over to show its characteristics", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    // Eight characteristics, all different, so a number read off the back can
    // only have come from the field it belongs to.
    const stats = [
      ["SPD", 5],
      ["DEX", 21],
      ["INIT", 3],
      ["CON", 23],
      ["REC", 9],
      ["END", 47],
      ["STUN", 38],
      ["BODY", 14],
    ] as const;

    await gm.getByRole("button", { name: "Add", exact: true }).click();
    await gm.getByLabel("Name").fill("Turncoat");
    await gm.getByLabel(/Character file/).setInputFiles({
      name: "sheet.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Turncoat" }) as Uint8Array<ArrayBuffer>),
    });
    for (const [label, value] of stats) {
      await gm.getByLabel(label, { exact: true }).fill(String(value));
    }
    await gm.getByRole("button", { name: "Add character" }).last().click();
    await gm.getByRole("button", { name: "Turncoat", exact: true }).waitFor();

    const card = gm.locator(`article:has(button[aria-label="Turncoat"])`);
    const press = card.getByRole("button", { name: "Turncoat", exact: true });

    /**
     * Which way the card is facing once it has finished turning: `1` is face up
     * and `-1` is turned over, read as the first cell of the rotation matrix.
     *
     * Read off the computed transform rather than off a class, because a class
     * says what was asked for and this says what the browser drew — and because
     * the flip has to survive the tilt that is on the element above it.
     *
     * It is told what it is waiting for, and that is not fussiness: the turn
     * takes 0.6s, and for the first frame of it the card is still exactly where
     * it was. A poll that stopped at "settled" would read the side it started on
     * and call it the answer. On timeout it returns whatever it last saw, so a
     * failure says which way the card actually ended up.
     */
    const facing = async (want: 1 | -1) => {
      const deadline = Date.now() + 3000;
      let seen = 0;
      while (Date.now() < deadline) {
        seen = await card.locator(".card-flip").evaluate(
          (el) => new DOMMatrix(getComputedStyle(el).transform).m11,
        );
        if (Math.round(seen) === want) return want;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return seen;
    };

    // It starts face up, and says so: a card with a back is a toggle, and a
    // reader who cannot see it turn is told nothing else by the press.
    expect(await facing(1)).toBe(1);
    expect(await press.getAttribute("aria-pressed")).toBe("false");

    await press.click();
    expect(await facing(-1)).toBe(-1);
    expect(await press.getAttribute("aria-pressed")).toBe("true");

    // All eight characteristics are printed on the back, each against its label.
    const back = (await card.locator(CARD_BACK).innerText()).replace(/\s+/g, " ");
    for (const [label, value] of stats) {
      expect(back).toMatch(new RegExp(`\\b${label} ${value}\\b`));
    }
    // And the name with them, so a library of turned-over cards is still a
    // library rather than seven anonymous stat blocks.
    expect(back).toContain("Turncoat");

    // Printed on stock rather than on a blank panel — and the artwork is actually
    // resolved, like the frame's above: its address arrives from /appearance.css
    // too, so an unset variable is otherwise a silent nothing.
    expect(
      await card
        .locator(".card-back-art")
        .evaluate((el) => getComputedStyle(el).backgroundImage),
    ).toContain("/frames/back.webp");

    // The corner controls are printed on the face that has just turned away.
    // They ride outside the tile and cannot turn with it, so they are faded out
    // instead — and are not clickable while they are gone.
    // Polled to the end of the fade, like the turn above: the two run on
    // different clocks — a 0.25s fade under a 0.6s turn — so the card being over
    // is not the same moment as the controls being gone.
    const actions = card.locator(".card-actions-3d");
    const faded = async () => {
      const deadline = Date.now() + 3000;
      let seen = "";
      while (Date.now() < deadline) {
        seen = await actions.evaluate((el) => getComputedStyle(el).opacity);
        if (seen === "0") return seen;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return seen;
    };
    expect(await faded()).toBe("0");
    expect(
      await card
        .getByRole("button", { name: /^Delete / })
        .evaluate((el) => getComputedStyle(el).pointerEvents),
    ).toBe("none");

    // And it turns back.
    await press.click();
    expect(await facing(1)).toBe(1);
    expect(await press.getAttribute("aria-pressed")).toBe("false");
  }, 60_000);

  test("the corner controls tilt with the card, and still work while it is tilted", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    const card = gm.locator(`article:has(button[aria-label="Select ${campaignName}"])`);
    await card.waitFor();
    const transforms = () =>
      card.evaluate((el) => ({
        tile: getComputedStyle(el.querySelector(".card")!).transform,
        actions: getComputedStyle(el.querySelector(".card-actions-3d")!).transform,
      }));

    // Untouched, both are flat.
    const resting = await transforms();
    expect(resting.tile).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(resting.actions).toBe(resting.tile);

    // Hovered in a corner, the controls take the card's own rotation — exactly,
    // which is what stops them sliding across the face they are printed on. The
    // controls sit outside the tilting element (a transform makes it a stacking
    // context, so nothing inside it can be clicked) and are moved to match.
    await card.locator(".hover-3d > *").nth(1).hover();
    await gm.waitForTimeout(800);
    const tilted = await transforms();
    expect(tilted.tile).toStartWith("matrix3d(");
    expect(tilted.actions).toBe(tilted.tile);

    // And the whole point: a control is still a control at that angle.
    await card.getByRole("button", { name: `Edit ${campaignName}` }).click();
    const dialog = gm.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.isVisible()).toBe(true);
  }, 60_000);

  test("the character form asks for the sheet first", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();
    await gm.getByRole("button", { name: "Add", exact: true }).click();

    // Every field is a label whose first span is its caption, so reading them in
    // document order is reading the form.
    const captions = await gm
      .locator("form label")
      .evaluateAll((labels) =>
        labels.map((label) => label.querySelector("span")?.textContent?.trim() ?? ""),
      );
    expect(captions).toEqual([
      "Character file (.hdc from HERO Designer)",
      "Name",
      "Type",
      "Campaign",
      // The characteristics, read across in the order HERO prints them.
      "SPD",
      "DEX",
      "INIT",
      "CON",
      "REC",
      "END",
      "STUN",
      "BODY",
      "Card image (optional)",
    ]);
  }, 60_000);

  test("sheets dropped on the character panel are filed without a dialog", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    // A real drop on the panel itself. The panel is found and dropped on inside
    // one evaluation: resolving it in an earlier round trip can hand back a node
    // React has since replaced, and an event dispatched at a detached node
    // reaches nothing. Two files, because a drop files everything it carries.
    await gm.evaluate((files: number[][]) => {
      const panel = Array.from(document.querySelectorAll("section")).find((section) =>
        section.textContent?.startsWith("Characters in"),
      );
      if (!panel) throw new Error("the character panel is not on the page");

      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(files[0]!)], "Gimli son of Gloin.hdc"));
      transfer.items.add(new File([new Uint8Array(files[1]!)], "Legolas.hdc"));
      panel.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
      panel.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    }, [[...hdcBytes({ name: "Gimli" })], [...hdcBytes({ name: "Legolas" })]]);

    // Both are filed there and then, each named after its file, with no dialog
    // in the way and nothing left to confirm.
    await gm.getByText("Added 2 characters.").waitFor();
    await gm.getByRole("button", { name: "Gimli son of Gloin", exact: true }).waitFor();
    await gm.getByRole("button", { name: "View Gimli son of Gloin's sheet" }).waitFor();
    await gm.getByRole("button", { name: "Legolas", exact: true }).waitFor();
    expect(await gm.getByRole("dialog").count()).toBe(0);

    // The same names again, which is a re-export being dropped back rather than a
    // collision. This time the files carry characteristics, so there is
    // something to see change.
    await gm.evaluate((files: number[][]) => {
      const panel = Array.from(document.querySelectorAll("section")).find((section) =>
        section.textContent?.startsWith("Characters in"),
      );
      if (!panel) throw new Error("the character panel is not on the page");

      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(files[0]!)], "Gimli son of Gloin.hdc"));
      transfer.items.add(new File([new Uint8Array(files[1]!)], "Legolas.hdc"));
      panel.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
      panel.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    }, [
      // A file stores levels bought, and SPD's base is figured from DEX — so
      // these two reach the same SPD of 6 from different levels.
      [...hdcBytes({ name: "Gimli", characteristics: { DEX: 9, SPD: 4 } })],
      [...hdcBytes({ name: "Legolas", characteristics: { DEX: 14, SPD: 3 } })],
    ]);

    // Updated rather than refused, and said so in those words.
    await gm.getByText("Updated 2 characters.").waitFor({ timeout: 5000 });
    expect(await gm.getByText(/already has a character called/).count()).toBe(0);

    // Still two of them: an update is not a third card.
    expect(await gm.getByRole("button", { name: "Gimli son of Gloin", exact: true }).count())
      .toBe(1);
    expect(await gm.getByRole("button", { name: "Legolas", exact: true }).count()).toBe(1);

    // And the numbers came off the dropped file, which the first ones did not
    // carry at all.
    await gm.getByRole("button", { name: "Edit Legolas" }).click();
    expect(await gm.getByLabel("DEX", { exact: true }).inputValue()).toBe("24");
    expect(await gm.getByLabel("SPD", { exact: true }).inputValue()).toBe("6");
  }, 60_000);

  test("uploading a sheet names the character after the file", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    await gm.getByRole("button", { name: "Add", exact: true }).click();
    await gm.getByLabel(/Character file/).setInputFiles({
      name: "Bilbo Baggins.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Bilbo" }) as Uint8Array<ArrayBuffer>),
    });

    // The name is filled in from the file, extension and all else left behind.
    expect(await gm.getByLabel("Name").inputValue()).toBe("Bilbo Baggins");

    // A second file replaces a name that only came from the first.
    await gm.getByLabel(/Character file/).setInputFiles({
      name: "Frodo Baggins.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Frodo" }) as Uint8Array<ArrayBuffer>),
    });
    expect(await gm.getByLabel("Name").inputValue()).toBe("Frodo Baggins");

    // But not a name the game master typed themselves.
    await gm.getByLabel("Name").fill("Samwise");
    await gm.getByLabel(/Character file/).setInputFiles({
      name: "Meriadoc.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Merry" }) as Uint8Array<ArrayBuffer>),
    });
    expect(await gm.getByLabel("Name").inputValue()).toBe("Samwise");

    await gm.getByRole("button", { name: "Add character" }).last().click();
    await gm.getByRole("button", { name: "Samwise", exact: true }).waitFor();

    // Replacing the sheet of a character that already has a name leaves it alone.
    await gm.getByRole("button", { name: "Edit Samwise" }).click();
    await gm.getByLabel(/Character file/).setInputFiles({
      name: "Peregrin.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Pippin" }) as Uint8Array<ArrayBuffer>),
    });
    expect(await gm.getByLabel("Name").inputValue()).toBe("Samwise");
  }, 60_000);

  test("a picture dropped on a campaign card becomes that campaign's", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    const card = gm.getByRole("button", { name: `Select ${campaignName}` });
    // A card with no picture draws its stand-in icon instead, so there is no
    // image on it to begin with.
    expect(await card.locator("img").count()).toBe(0);

    await dropImage(card);

    await gm.getByText(`Updated the picture for “${campaignName}”.`).waitFor();
    await card.locator("img").waitFor();
  }, 60_000);

  test("a picture dropped on a character card becomes that character's, and nothing else", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    await gm.getByRole("button", { name: "Add", exact: true }).click();
    await gm.getByLabel("Name").fill("Gandalf");
    await gm.getByLabel(/Character file/).setInputFiles({
      name: "sheet.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Gandalf" }) as Uint8Array<ArrayBuffer>),
    });
    await gm.getByRole("button", { name: "Add character" }).last().click();
    await gm.getByRole("button", { name: "Gandalf", exact: true }).waitFor();

    const card = gm.getByRole("button", { name: "Gandalf", exact: true });
    expect(await card.locator("img").count()).toBe(0);

    await dropImage(card);

    await gm.getByText("Updated the picture for “Gandalf”.").waitFor();
    await card.locator("img").waitFor();

    // The card sits inside the panel that files a dropped sheet as a new
    // character. The innermost target takes the drop, so the picture is filed
    // and nothing behind the card sees it — no dialog, and no second character
    // named after the image.
    expect(await gm.getByRole("dialog").count()).toBe(0);
    expect(await gm.getByRole("button", { name: /'s sheet$/ }).count()).toBe(1);
  }, 60_000);

  test("a character sheet can be dropped onto the form instead of picked", async () => {
    if (!browser) return;
    const gm = await signedInGm();

    const campaignName = unique("Campaign");
    await gm.getByRole("button", { name: "New", exact: true }).click();
    await gm.getByLabel("Campaign name").fill(campaignName);
    await gm.getByRole("button", { name: "Create campaign" }).click();
    await gm.getByText(`Characters in ${campaignName}`).waitFor();

    await gm.getByRole("button", { name: "Add", exact: true }).click();
    await gm.getByLabel("Name").fill("Dropped");

    // A real drop, not `setInputFiles`: the point of the feature is that the
    // dropped file ends up in the input the form submits. The event goes to the
    // input and bubbles to the zone around it, as a drop on the zone would.
    const zone = gm.getByLabel(/Character file/);
    await zone.evaluate((element, bytes: number[]) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "dropped.hdc"));
      element.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    }, [...hdcBytes({ name: "Dropped" })]);
    await gm.getByText("Ready to upload: dropped.hdc").waitFor();

    await gm.getByRole("button", { name: "Add character" }).last().click();
    await gm.getByRole("button", { name: "Dropped", exact: true }).waitFor();

    // The sheet went up with it, so the card offers to open one.
    await gm.getByRole("button", { name: "View Dropped's sheet" }).waitFor();
  }, 60_000);

  test("the session list follows a session started and ended in another tab", async () => {
    if (!browser) return;
    // Two tabs of the same game master: one sitting on the library, one working.
    const watcher = await signedInGm();
    const other = await signedInGm();

    const name = unique("Campaign");
    await other.getByRole("button", { name: "New", exact: true }).click();
    await other.getByLabel("Campaign name").fill(name);
    await other.getByRole("button", { name: "Create campaign" }).click();
    await other.getByText(`Characters in ${name}`).waitFor();

    const listed = watcher
      .locator("section", { hasText: "Sessions in progress" })
      .getByText(name);
    expect(await listed.count()).toBe(0);

    // The watching tab is never reloaded, and never touched at all.
    await other.getByRole("button", { name: "Start", exact: true }).click();
    await other.waitForURL("**/gm/sessions/**");
    await listed.waitFor({ timeout: 5000 });

    // Wait for the console's own furniture, not just the URL: the address
    // changes before React swaps the markup, and until it does this tab is still
    // showing the library — where "End" is one button per session in progress
    // rather than the console's single one, and the click below is ambiguous.
    await stagePanel(other).waitFor({ timeout: 5000 });

    await other.getByRole("button", { name: "End", exact: true }).click();
    // The dialog spells the action out where the button on the console is a
    // single word, so the second click is scoped to the dialog either way.
    const ending = other.getByRole("dialog", { name: "End this session?" });
    await ending.getByRole("button", { name: "End session" }).click();
    await other.waitForURL("**/gm");
    await listed.waitFor({ state: "detached", timeout: 5000 });
  }, 60_000);

  test("signing out of the console leaves the session running", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Hana");

    // Signing out is not ending: it is about this browser and nobody else's,
    // which is why the console asks nothing before doing it.
    await gm.getByRole("button", { name: "Sign out" }).click();
    await gm.getByRole("tab", { name: "Game master" }).waitFor({ timeout: 5000 });

    // The player is still at the table, on a session that is still running.
    await player.getByRole("heading", { name: campaignName, exact: true }).waitFor();

    // And signing back in finds it where it was left, still in progress and
    // still waiting to be opened.
    await gm.getByRole("tab", { name: "Game master" }).click();
    await gm.getByLabel("Email").fill(email);
    await gm.getByLabel("Password").fill(PASSWORD);
    await gm.getByRole("button", { name: "Sign in" }).click();
    await gm.waitForURL("**/gm");

    const row = gm.locator("li").filter({ hasText: campaignName });
    await row.getByRole("button", { name: "Open", exact: true }).click();
    await gm.waitForURL("**/gm/sessions/**");
    // The same code, so it is the same session and not a new one.
    await gm.getByText(code).waitFor({ timeout: 5000 });
  }, 60_000);

  test("a session can be ended from the library, without opening its console", async () => {
    if (!browser) return;
    const { page: gm, code, campaignName } = await gmWithSession();
    const player = await playerIn(code, "Hana");

    await gm.getByRole("button", { name: "Library" }).click();
    await gm.waitForURL("**/gm");

    // Other tests of this same game master leave sessions running, so the row has
    // to be found by its own campaign rather than by being the only one.
    const row = gm.locator("li").filter({ hasText: campaignName });
    await row.getByRole("button", { name: "End", exact: true }).click();

    // The question names the campaign, since the library can be showing several.
    const ending = gm.getByRole("dialog", { name: `End the session on “${campaignName}”?` });
    await ending.getByRole("button", { name: "End session" }).click();

    // The row goes on its own — nothing reloads the library.
    await row.waitFor({ state: "detached", timeout: 5000 });

    // And the table really is closed: the player is told, not just left hanging.
    await player.getByText("The session has ended").waitFor({ timeout: 5000 });
  }, 60_000);

  test("backing out of that leaves the session running", async () => {
    if (!browser) return;
    const { page: gm, campaignName } = await gmWithSession();

    await gm.getByRole("button", { name: "Library" }).click();
    await gm.waitForURL("**/gm");

    const row = gm.locator("li").filter({ hasText: campaignName });
    await row.getByRole("button", { name: "End", exact: true }).click();
    await gm.getByRole("dialog", { name: `End the session on “${campaignName}”?` })
      .getByRole("button", { name: "Cancel" }).click();

    await gm.waitForTimeout(300);
    expect(await row.getByRole("button", { name: "Open", exact: true }).count()).toBe(1);
  }, 60_000);

  test("a player who closes their browser leaves the table", async () => {
    if (!browser) return;
    const { page: gm, code } = await gmWithSession();
    const player = await playerIn(code, "Erin");

    // Scoped to the players panel, because the log now names Erin too — and it
    // goes on naming her after she has gone, which is the point of it.
    const seat = gm.locator("section", { hasText: /Players \(/ }).getByText("Erin");
    await seat.first().waitFor({ timeout: 5000 });

    // No goodbye of any kind: the window simply goes, as it does when someone
    // shuts their laptop at the end of the evening.
    await player.context().close();

    // The game master's console empties the seat on its own, and Thorin — the
    // character Erin was holding — is free for someone else to take.
    await seat.first().waitFor({ state: "detached", timeout: 10_000 });
    await gm
      .getByRole("listitem")
      .filter({ hasText: "Thorin" })
      .getByText("Unclaimed")
      .waitFor({ timeout: 10_000 });
  }, 60_000);

  test("a sheet's scripts run but cannot touch the app", async () => {
    if (!browser) return;
    const { page: gm, code } = await gmWithSession();
    const player = await playerIn(code, "Carol");

    await player.getByRole("button", { name: "My sheet" }).click();
    const frame = player.frameLocator("iframe");
    await frame.getByText("Thorin").waitFor({ timeout: 5000 });

    // The sheet's own script executed inside the frame. The template prints both
    // editions' rows and hides the one the character is not, which nothing but
    // its script does — so a hidden row is proof the script ran, and the dice
    // buttons beside it work for the same reason.
    const display = await frame
      .locator(".ed6")
      .first()
      .evaluate((element) => getComputedStyle(element).display);
    expect(display).toBe("none");

    // ...but the frame is an opaque origin. Reading cookies from it does not
    // merely come back empty — the browser refuses outright, which is exactly
    // the boundary the sandbox is there to draw.
    const cookieAccess = await player
      .frames()
      .find((entry) => entry.url().includes("/sheets/"))!
      .evaluate(() => {
        try {
          return { blocked: false, value: document.cookie };
        } catch (error) {
          return { blocked: true, value: (error as Error).name };
        }
      })
      .catch(() => ({ blocked: true, value: "SecurityError" }));

    expect(cookieAccess.blocked).toBe(true);

    await gm.close();
  }, 60_000);

  test("a character is refiled by dragging its card onto a campaign", async () => {
    if (!browser) return;
    const page = await signedInGm();
    await page.setViewportSize({ width: 1600, height: 900 });

    const [alpha, beta] = [unique("Alpha"), unique("Beta")];
    for (const name of [alpha, beta]) {
      await page.getByRole("button", { name: "New", exact: true }).click();
      await page.getByLabel("Campaign name").fill(name);
      await page.getByRole("button", { name: "Create campaign" }).click();
      await page.getByText(`Characters in ${name}`).waitFor();
    }

    await page.getByRole("button", { name: `Select ${alpha}` }).click();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Name").fill("Thorin");
    await page.getByLabel(/Character file/).setInputFiles({
      name: "thorin.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Thorin" }) as Uint8Array<ArrayBuffer>),
    });
    await page.getByRole("button", { name: "Add character" }).last().click();
    await page.getByRole("button", { name: "Thorin", exact: true }).waitFor();

    const card = `article:has(button[aria-label="View Thorin's sheet"])`;
    const cardOf = (name: string) => `article:has(button[aria-label="Select ${name}"])`;

    // The campaign it is already in must not offer to take it.
    await page.evaluate(([source, target]: [string, string]) => {
      const dataTransfer = new DataTransfer();
      document.querySelector(source)!
        .dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      document.querySelector(target)!
        .dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    }, [card, cardOf(alpha)] as [string, string]);
    expect(await page.locator(cardOf(alpha)).getAttribute("class")).not.toContain("ring-offset-2");

    // Another one lights up while the drag is over it.
    await page.evaluate(([source, target]: [string, string]) => {
      const dataTransfer = new DataTransfer();
      document.querySelector(source)!
        .dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      document.querySelector(target)!
        .dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    }, [card, cardOf(beta)] as [string, string]);
    await page.waitForTimeout(100);
    expect(await page.locator(cardOf(beta)).getAttribute("class")).toContain("ring-offset-2");

    // Dropping moves it: it leaves the panel it was in and turns up in the other.
    await dragCard(page, card, cardOf(beta));
    await page.getByText(`Moved “Thorin” to “${beta}”`).waitFor({ timeout: 5000 });
    expect(await page.getByRole("button", { name: "Thorin", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: `Select ${beta}` }).click();
    await page.getByRole("button", { name: "Thorin", exact: true }).waitFor();

    // A card let go over the character panel is not a sheet being uploaded.
    await dragCard(page, card, "the character panel");
    await page.waitForTimeout(400);
    expect(await page.getByLabel("Type").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Thorin", exact: true }).count()).toBe(1);

    // ...and a file let go there still files a character.
    await page.evaluate((bytes: number[]) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([new Uint8Array(bytes)], "Bilbo Baggins.hdc"));
      const panel = [...document.querySelectorAll("section")].find((section) =>
        section.querySelector("h2")?.textContent?.startsWith("Characters in"),
      )!.children[1]!;
      for (const type of ["dragover", "drop"]) {
        panel.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      }
    }, [...hdcBytes({ name: "Bilbo" })]);
    await page.getByRole("button", { name: "Bilbo Baggins", exact: true })
      .waitFor({ timeout: 5000 });

    await page.close();
  }, 60_000);

  test("a sheet opens over the window in the window's own shape", async () => {
    if (!browser) return;
    const page = await signedInGm();
    await page.setViewportSize({ width: 1600, height: 900 });

    const campaign = unique("Campaign");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByLabel("Campaign name").fill(campaign);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await page.getByText(`Characters in ${campaign}`).waitFor();

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Name").fill("Thorin");
    await page.getByLabel(/Character file/).setInputFiles({
      name: "thorin.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: "Thorin" }) as Uint8Array<ArrayBuffer>),
    });
    await page.getByRole("button", { name: "Add character" }).last().click();
    await page.getByRole("button", { name: "Thorin", exact: true }).waitFor();

    await page.getByRole("button", { name: "View Thorin's sheet" }).click();
    await page.locator("iframe").waitFor();

    // Whatever shape the window is, the sheet is the same shape. Nothing of ours
    // is drawn around it.
    for (const [width, height] of [[1600, 900], [1200, 1000], [800, 1400]]) {
      await page.setViewportSize({ width: width!, height: height! });
      await page.waitForTimeout(150);
      const shown = await page.evaluate(() => {
        const frame = document.querySelector("iframe")!;
        const box = frame.getBoundingClientRect();
        const style = getComputedStyle(frame);
        return {
          size: [box.width, box.height],
          window: [window.innerWidth, window.innerHeight],
          border: style.borderTopWidth,
          radius: style.borderTopLeftRadius,
          headings: document.querySelectorAll('[role="dialog"] h2').length,
        };
      });
      // The same ratio as the window, at whatever fraction of it the deployment
      // asked for — asserted as a ratio so the default can move without this
      // test having to know what it is.
      const [frameW, frameH] = shown.size as [number, number];
      const [windowW, windowH] = shown.window as [number, number];
      expect(frameW / frameH).toBeCloseTo(windowW / windowH, 3);
      expect(frameW).toBeLessThanOrEqual(windowW);
      expect(shown.border).toBe("0px");
      expect(shown.radius).toBe("0px");
      expect(shown.headings).toBe(0);
    }

    // The setting is one number and it moves both dimensions together, so the
    // shape survives whatever the deployment picks — including filling the window.
    await page.setViewportSize({ width: 1600, height: 900 });
    for (const [size, expected] of [[80, [1280, 720]], [100, [1600, 900]]] as const) {
      await page.evaluate(
        (value: string) => document.documentElement.style.setProperty("--sheet-size", value),
        String(size),
      );
      await page.waitForTimeout(150);
      const scaled = await page.evaluate(() => {
        const box = document.querySelector("iframe")!.getBoundingClientRect();
        return [box.width, box.height];
      });
      expect(scaled).toEqual([...expected]);
    }

    // The close control sits in the window's corner, not the sheet's, so it does
    // not move when the sheet is drawn at a different size.
    await page.evaluate(() => document.documentElement.style.setProperty("--sheet-size", "90"));
    await page.waitForTimeout(150);
    const corner = await page.evaluate(() => {
      const button = document.querySelector('button[aria-label="Close"]')!.getBoundingClientRect();
      const sheet = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
      return { top: button.top, right: window.innerWidth - button.right, sheetTop: sheet.top };
    });
    expect(corner.top).toBeLessThan(corner.sheetTop);
    expect(corner.right).toBeLessThan(16);

    // Escape closes it, while the keyboard is still this page's to hear. Once a
    // reader clicks into the sheet the focus is inside a sandboxed cross-origin
    // frame and no key reaches us again, which is why the button is always there.
    expect(await page.getByRole("button", { name: "Close" }).count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    expect(await page.locator("iframe").count()).toBe(0);

    // A click on the sheet itself is the sheet's own business...
    await page.getByRole("button", { name: "View Thorin's sheet" }).click();
    await page.locator("iframe").waitFor();
    const sheetBox = (await page.locator('[role="dialog"]').boundingBox())!;
    await page.mouse.click(sheetBox.x + sheetBox.width / 2, sheetBox.y + sheetBox.height / 2);
    await page.waitForTimeout(200);
    expect(await page.locator("iframe").count()).toBe(1);

    // ...but a click on the dimmed page around it closes the sheet.
    await page.mouse.click(4, 4);
    await page.waitForTimeout(200);
    expect(await page.locator("iframe").count()).toBe(0);

    await page.close();
  }, 60_000);

  test("the sign-in page puts the cursor in the field still to be filled in", async () => {
    if (!browser) return;
    const page = await (await browser!.newContext()).newPage();

    /** The caption above whichever field holds the cursor. */
    const focused = () =>
      page.evaluate(
        () => document.activeElement?.closest("label")?.querySelector("span")?.textContent ?? "",
      );

    // Arriving cold, the code is what a player has to type first.
    await page.goto(base);
    await page.getByLabel("Session code").waitFor();
    expect(await focused()).toBe("Session code");

    // The game master's tab is a different form in the same place, so the
    // cursor has to move to it rather than stay where the player's was.
    await page.getByRole("tab", { name: "Game master" }).click();
    await page.getByLabel("Email").waitFor();
    expect(await focused()).toBe("Email");

    // Back to the player's tab, and back to the code.
    await page.getByRole("tab", { name: "Join a session" }).click();
    await page.getByLabel("Session code").waitFor();
    expect(await focused()).toBe("Session code");

    // A join link has already answered the code, so the name is what is left.
    await page.goto(`${base}/?code=ABCD-EFGH-JKMN`);
    await page.getByLabel("Player name").waitFor();
    expect(await focused()).toBe("Player name");

    await page.close();
  }, 60_000);
});

describe("how big cards are drawn is the reader's own setting", () => {
  test("the slider resizes the library, and the size is still there after a reload", async () => {
    if (!browser) return;

    // Their own account, because the size is stored against it: the game master
    // the rest of this file signs in as must not find their library resized by
    // this test.
    const mine = `${unique("gm")}@example.com`;
    gms.create(mine, await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }));

    const page = await (await browser.newContext()).newPage();
    await page.goto(base);
    await page.getByRole("tab", { name: "Game master" }).click();
    await page.getByLabel("Email").fill(mine);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/gm");

    const campaignName = unique("Campaign");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByLabel("Campaign name").fill(campaignName);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await page.getByText(`Characters in ${campaignName}`).waitFor();

    const well = page
      .locator(`article:has(button[aria-label="Select ${campaignName}"]) .aspect-square`)
      .first();
    const widthOf = async () => Math.round((await well.boundingBox())!.width);

    // A new account starts where the deployment setting used to put everybody.
    expect(await widthOf()).toBe(CARD_IMAGE_PX.default);

    await page.getByRole("button", { name: "Settings" }).click();
    const slider = page.getByRole("slider", { name: "Card size" });
    const wanted = CARD_IMAGE_PX.default + CARD_IMAGE_PX.step * 8;

    // The save is debounced, so the request is what is waited on rather than a
    // guess at how long a drag takes to settle.
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/api/settings") && response.status() === 200,
    );
    await slider.fill(String(wanted));

    // The cards move under the slider, before anything has been saved: the size
    // goes onto the document as an inline custom property and the grid reflows
    // off it, so waiting for the property is waiting for the whole mechanism.
    await page.waitForFunction(
      (px) => document.documentElement.style.getPropertyValue("--card-image-size") === `${px}px`,
      wanted,
    );
    expect(await widthOf()).toBe(wanted);
    await saved;

    // And the size belongs to the account rather than to the page view.
    await page.reload();
    await page.getByText(`Characters in ${campaignName}`).waitFor();
    expect(await widthOf()).toBe(wanted);

    await page.close();
  });
});

describe("the session library can reach past its own campaign", () => {
  test("the setting fills it with every monster, and they can be brought on", async () => {
    if (!browser) return;
    const page = await signedInGm();

    // A monster filed under a campaign this session has nothing to do with.
    const elsewhere = unique("Elsewhere");
    const ogre = unique("Ogre");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByLabel("Campaign name").fill(elsewhere);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await page.getByText(`Characters in ${elsewhere}`).waitFor();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Name").fill(ogre);
    await page.getByLabel(/Character file/).setInputFiles({
      name: "ogre.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(hdcBytes({ name: ogre }) as Uint8Array<ArrayBuffer>),
    });
    await page.getByRole("button", { name: "Add character" }).last().click();
    await page.getByRole("button", { name: ogre, exact: true }).waitFor();

    // And tonight's campaign, with a session running.
    const tonight = unique("Tonight");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByLabel("Campaign name").fill(tonight);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await page.getByText(`Characters in ${tonight}`).waitFor();
    await page.getByRole("button", { name: /^Start/ }).click();
    await page.waitForURL("**/gm/sessions/**");
    await page.getByText("Stage").first().waitFor();

    const libraryPanel = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Library" }),
    });
    const ogreRow = libraryPanel.locator("li").filter({ hasText: ogre });

    // Off, the library is this campaign's own — which has nobody in it at all.
    expect(await ogreRow.count()).toBe(0);

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("checkbox", { name: "Show all NPCs" }).check();

    // On, the monster is there without a reload, and the row says where it came
    // from — two campaigns with the same monster in each would be two identical
    // rows otherwise.
    await ogreRow.waitFor({ timeout: 5000 });
    expect(await ogreRow.textContent()).toContain(elsewhere);

    // And it can actually be brought on, which is the half of this the server has
    // to agree to.
    await ogreRow.getByRole("button", { name: "Add", exact: true }).click();
    const stage = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Stage" }),
    });
    await stage.getByText(ogre, { exact: true }).waitFor({ timeout: 5000 });

    // And now it cannot be switched off, because switching it off is what would
    // take that monster out of the library it is standing on stage from.
    const toggle = page.getByRole("checkbox", { name: "Show all NPCs" });
    expect(await toggle.isEnabled()).toBe(false);
    // The drawer says why, in place of what the setting does.
    expect(await page.locator('aside[aria-label="Settings"]').textContent())
      .toContain("on the stage from another campaign");

    // Off the stage, and the way back out opens.
    await stage.getByRole("listitem").filter({ hasText: ogre })
      .getByRole("button", { name: new RegExp(`Remove ${ogre}`) }).click();
    // The stage arrives over the socket, so the control unlocks a beat later.
    await page.locator("#setting-show-all-npcs:not([disabled])").waitFor({ timeout: 5000 });

    // Switched back off it leaves the library again, still without a reload.
    await toggle.uncheck();
    await page.waitForTimeout(500);
    expect(await ogreRow.count()).toBe(0);

    await page.close();
  }, 60_000);
});

describe.skipIf(!rulesAvailable)("a real export, filed the way a game master files one", () => {
  test("splits in the browser, files small, and draws its sheet", async () => {
    if (!browser) return;
    const page = await signedInGm();

    const campaign = unique("Campaign");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByLabel("Campaign name").fill(campaign);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await page.getByText(`Characters in ${campaign}`).waitFor();

    // What actually crosses the wire, measured rather than assumed: the file on
    // disk is 3.7 MB, of which all but about 92 KB is the portrait.
    const uploaded: number[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/characters")) {
        uploaded.push(Number(request.headers()["content-length"] ?? 0));
      }
    });

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel(/Character file/).setInputFiles("./fixtures/Redshift.hdc");

    // The characteristics come back from the server, worked out against the
    // rules — these are the numbers on the sheet HERO Designer exports.
    await page.waitForFunction(
      () => (document.querySelector('input[name="dexterity"]') as HTMLInputElement)?.value === "26",
      undefined,
      { timeout: 10_000 },
    );
    const box = (label: string) => page.getByLabel(label, { exact: true });
    expect(await box("SPD").inputValue()).toBe("5");
    expect(await box("STUN").inputValue()).toBe("35");
    expect(await box("INIT").inputValue()).toBe("4");
    // Named after the file, as any other upload is.
    expect(await page.getByLabel("Name").inputValue()).toBe("Redshift");

    const name = unique("Redshift");
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Add character" }).last().click();
    await page.getByRole("button", { name, exact: true }).waitFor();

    // Both requests carried the split file, not the 3.7 MB original: the
    // characteristics preview, and the upload that filed the character with its
    // portrait already sized for a card.
    expect(uploaded.length).toBe(2);
    for (const bytes of uploaded) expect(bytes).toBeLessThan(1_000_000);

    // The portrait inside the file became the card. The picture is decorative
    // markup — the name is right beside it — so it is found by what it points
    // at, and this campaign has no other picture in it.
    await page.locator('img[src^="/uploads/images/"]').first().waitFor({ timeout: 5000 });

    // And the sheet is drawn from the stored file, on demand.
    await page.getByRole("button", { name: `View ${name}'s sheet` }).click();
    const sheet = page.frameLocator("iframe");
    await sheet.locator("text=Redshift").first().waitFor({ timeout: 10_000 });

    await page.close();
  }, 90_000);
});

describe.skipIf(!rulesAvailable)("a character file fills the characteristics in for you", () => {
  /**
   * A character file with the levels behind the numbers this test asserts on.
   *
   * A file stores levels *bought*; what a sheet prints is those plus the game
   * system's base, some of it figured from other characteristics — SPD's base is
   * one plus a tenth of DEX. So `{ DEX: 13, SPD: 2 }` is a DEX of 23 and a SPD
   * of 5, and the two cannot be read apart.
   */
  const characterFile = (values: {
    dex: number;
    spd: number;
    reflexes?: number;
  }) =>
    hdcBytes({
      characteristics: {
        DEX: values.dex,
        CON: 10,
        BODY: 1,
        SPD: values.spd,
        REC: 5,
        END: 13,
        STUN: 7,
      },
      ...(values.reflexes === undefined ? {} : { lightningReflexes: values.reflexes }),
    });

  test("as the file is chosen, and again when it is replaced", async () => {
    if (!browser) return;
    const page = await signedInGm();

    const campaign = unique("Campaign");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByLabel("Campaign name").fill(campaign);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await page.getByText(`Characters in ${campaign}`).waitFor();

    const box = (label: string) => page.getByLabel(label, { exact: true });

    await page.getByRole("button", { name: "Add", exact: true }).click();
    // Typed first, so the file is seen to write over it rather than into a gap.
    await box("DEX").fill("7");
    await page.getByLabel(/Character file/).setInputFiles({
      name: "hero.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(
        characterFile({ dex: 13, spd: 2, reflexes: 4 }) as Uint8Array<ArrayBuffer>,
      ),
    });

    // Splitting the file and asking the server about it are both asynchronous,
    // so the box is waited for rather than read.
    await page.waitForFunction(
      () => (document.querySelector('input[name="dexterity"]') as HTMLInputElement)?.value === "23",
      undefined,
      { timeout: 5000 },
    );
    expect(await box("SPD").inputValue()).toBe("5");
    expect(await box("CON").inputValue()).toBe("20");
    expect(await box("REC").inputValue()).toBe("11");
    expect(await box("END").inputValue()).toBe("53");
    expect(await box("STUN").inputValue()).toBe("33");
    expect(await box("BODY").inputValue()).toBe("11");
    expect(await box("INIT").inputValue()).toBe("4");

    const name = unique("Hero");
    await box("Name").fill(name);
    await page.getByRole("button", { name: "Add character" }).last().click();
    await page.getByRole("button", { name, exact: true }).waitFor();

    // A replacement file overwrites what the character already carries: choosing
    // a file is choosing what this character is.
    await page.getByRole("button", { name: `Edit ${name}` }).click();
    expect(await box("DEX").inputValue()).toBe("23");

    await page.getByLabel(/Character file/).setInputFiles({
      name: "hero-v2.hdc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(characterFile({ dex: 8, spd: 4 }) as Uint8Array<ArrayBuffer>),
    });

    await page.waitForFunction(
      () => (document.querySelector('input[name="dexterity"]') as HTMLInputElement)?.value === "18",
      undefined,
      { timeout: 5000 },
    );
    expect(await box("SPD").inputValue()).toBe("6");
    // No Lightning Reflexes on the new export, which is an answer rather than a
    // gap: the bonus is gone, so INIT goes back to nil.
    expect(await box("INIT").inputValue()).toBe("0");

    await page.close();
  }, 60_000);
});

describe("the campaign being worked on is lit", () => {
  test("the selected card wears the aura, and only that card", async () => {
    if (!browser) return;
    const page = await signedInGm();

    const [first, second] = [unique("First"), unique("Second")];
    for (const name of [first, second]) {
      await page.getByRole("button", { name: "New", exact: true }).click();
      await page.getByLabel("Campaign name").fill(name);
      await page.getByRole("button", { name: "Create campaign" }).click();
      await page.getByText(`Characters in ${name}`).waitFor();
    }

    /** The aura wrapper around a campaign's card, if it has one. */
    const auraOn = (name: string) =>
      page.locator(`.aura:has(button[aria-label="Select ${name}"])`);

    // Creating a campaign selects it, so the second one is the lit one.
    await auraOn(second).waitFor({ timeout: 5000 });
    expect(await auraOn(first).count()).toBe(0);

    await page.getByRole("button", { name: `Select ${first}` }).click();
    await auraOn(first).waitFor({ timeout: 5000 });
    expect(await auraOn(second).count()).toBe(0);

    // The glow is the two blurred copies behind the card, which is the half of
    // this component that the development server used to drop on the floor: with
    // the pseudo-elements gone the aura is a gold hairline and reads as nothing.
    const glow = await auraOn(first).evaluate((el) => ({
      before: getComputedStyle(el, "::before").filter,
      after: getComputedStyle(el, "::after").filter,
    }));
    expect(glow.before).toContain("blur");
    expect(glow.after).toContain("blur");

    // And a lit card is exactly as wide as an unlit one. The aura pads outward,
    // so without the negative margin that pulls it back the selected card would
    // be narrower than its neighbours and the row would jump as cards are picked.
    // Off the cards and given time to settle: `hover-3d` tilts whatever the
    // pointer is over, and a tilted card's bounding box is wider than the card.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(500);
    const widthOf = async (name: string) =>
      Math.round((await page.locator(
        `article:has(button[aria-label="Select ${name}"]) .card`,
      ).first().boundingBox())!.width);
    expect(await widthOf(first)).toBe(await widthOf(second));

    await page.close();
  }, 60_000);
});
