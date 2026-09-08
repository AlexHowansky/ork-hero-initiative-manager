/**
 * End-to-end checks against a real server.
 *
 * These cover the boundaries that matter most: nothing is reachable without
 * signing in, one game master cannot see another's material, a player can only
 * open the sheet of the character they are actually playing, and a cross-site
 * request cannot change anything.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serverOptions } from "../src/server/app.ts";
import { registerServer } from "../src/server/ws.ts";
import sharp from "sharp";
import { gms } from "../src/db/queries.ts";
import { db } from "../src/db/index.ts";
import { CARD_IMAGE_PX } from "../src/lib/cards.ts";
import { config, limits } from "../src/lib/config.ts";
import { hdcBytes, hdcFile, hdeFile, hdeSource, rulesAvailable, unique } from "./helpers.ts";
import { BUILT_IN_TEMPLATE_ID } from "../src/lib/templates.ts";
import {
  LOG_CLEARED,
  SESSION_STARTED,
  gmAddedToScene,
  gmAssigned,
  gmKicked,
  gmReassigned,
  gmRemovedFromScene,
  gmUnassigned,
  playerDisconnected,
  playerJoined,
  playerLeft,
  playerSelected,
  segmentBegan,
  tagsAdded,
  tagsRemoved,
  actionHeld,
  becameStunned,
  knockedOut,
  GAME_MASTER,
} from "../src/server/events.ts";

let base: string;
let server: ReturnType<typeof Bun.serve>;

const ORIGIN_HEADER = () => ({ Origin: base });

beforeAll(async () => {
  server = Bun.serve({ ...serverOptions, port: 0 });
  registerServer(server as never);
  base = server.url.origin.replace(/\/$/, "");
});

afterAll(() => server.stop(true));

/** A signed-in game master, represented by the cookie their browser would hold. */
async function signIn(): Promise<{ cookie: string; email: string }> {
  const email = `${unique("gm")}@example.com`;
  const password = "a-sufficiently-long-password";
  gms.create(email, await Bun.password.hash(password, { algorithm: "argon2id" }));

  const response = await fetch(`${base}/api/auth/gm/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);

  const cookie = response.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
  return { cookie, email };
}

function authed(cookie: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { Cookie: cookie, Origin: base, ...(init.headers ?? {}) } };
}

/** Creates a campaign with one PC and one NPC, and starts a session with both. */
async function makeTable(cookie: string) {
  const campaignForm = new FormData();
  campaignForm.set("name", unique("Campaign"));
  const campaign = await (
    await fetch(`${base}/api/campaigns`, authed(cookie, { method: "POST", body: campaignForm }))
  ).json();

  // SPD 12 and a DEX apiece: everyone acts in every segment, so the clock walks
  // one character per press and these tests can talk about steps rather than
  // about the Speed Chart. The chart itself is exercised in `initiative.test.ts`.
  const addCharacter = async (kind: "pc" | "npc", dexterity = 20) => {
    const form = new FormData();
    form.set("campaignId", campaign.campaign.id);
    form.set("kind", kind);
    form.set("name", unique(kind));
    form.set("speed", "12");
    form.set("dexterity", String(dexterity));
    form.set("sheet", hdcFile());
    const response = await fetch(
      `${base}/api/characters`,
      authed(cookie, { method: "POST", body: form }),
    );
    return (await response.json()).character;
  };

  // The PC leads on DEX, so the order is the same one the old fixture had.
  const pc = await addCharacter("pc", 20);
  const npc = await addCharacter("npc", 10);

  const session = (
    await (
      await fetch(
        `${base}/api/sessions`,
        authed(cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId: campaign.campaign.id }),
        }),
      )
    ).json()
  ).session;

  for (const character of [pc, npc]) {
    await fetch(
      `${base}/api/sessions/${session.id}/stage`,
      authed(cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: character.id }),
      }),
    );
  }

  return { campaign: campaign.campaign, pc, npc, session };
}

/**
 * A real 1x1 PNG, with a distinguishing byte appended so that two calls never
 * produce the same file — the app stores an upload per row, and a test about who
 * may read which picture needs them to be different pictures.
 */
function cardImage(tag: number): File {
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  return new File([pixel, new Uint8Array([tag])], `card-${tag}.png`, { type: "image/png" });
}

/** A character carrying a card image, which `makeTable` does not give them. */
async function addCardedCharacter(
  cookie: string,
  campaignId: string,
  kind: "pc" | "npc",
  tag: number,
) {
  const form = new FormData();
  form.set("campaignId", campaignId);
  form.set("kind", kind);
  form.set("name", unique(kind));
  form.set("sheet", hdcFile());
  form.set("card", cardImage(tag));
  const response = await fetch(
    `${base}/api/characters`,
    authed(cookie, { method: "POST", body: form }),
  );
  return (await response.json()).character;
}

/** Joins a session as a player and returns their cookie. */
async function joinAs(code: string, name: string): Promise<string> {
  const response = await fetch(`${base}/api/sessions/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ code, name }),
  });
  expect(response.status).toBe(201);
  return response.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
}

/* -------------------------------------------------------------------------- */

describe("nothing is reachable without signing in", () => {
  const guarded = [
    "/api/campaigns",
    "/api/characters",
    "/api/sessions",
  ];

  test.each(guarded)("%s refuses an anonymous caller", async (path) => {
    const response = await fetch(base + path);
    expect(response.status).toBe(401);
  });

  test("an anonymous caller cannot reach a sheet or an image", async () => {
    const { cookie } = await signIn();
    const { pc } = await makeTable(cookie);

    expect((await fetch(`${base}/characters/${pc.id}`)).status).toBe(404);
    expect((await fetch(`${base}/uploads/images/anything`)).status).toBe(401);
  });

  test("an unknown path is a 404, not the application", async () => {
    expect((await fetch(`${base}/not-a-page`)).status).toBe(404);
  });
});

describe("one game master cannot see another's material", () => {
  test("a campaign, its characters and its sessions are all invisible", async () => {
    const owner = await signIn();
    const stranger = await signIn();
    const { campaign, pc, session } = await makeTable(owner.cookie);

    const campaigns = await (
      await fetch(`${base}/api/campaigns`, authed(stranger.cookie))
    ).json();
    expect(campaigns.campaigns.find((entry: { id: string }) => entry.id === campaign.id))
      .toBeUndefined();

    // Probing by id reveals nothing either.
    expect(
      (await fetch(`${base}/api/sessions/${session.id}`, authed(stranger.cookie))).status,
    ).toBe(404);
    expect((await fetch(`${base}/characters/${pc.id}`, authed(stranger.cookie))).status).toBe(404);
    expect(
      (await fetch(
        `${base}/api/campaigns/${campaign.id}`,
        authed(stranger.cookie, { method: "DELETE" }),
      )).status,
    ).toBe(404);
  });

  /**
   * A card image is reachable by entitlement rather than by merely being signed
   * in. The ids are random, so nobody guesses one; what this is about is an id
   * that gets out — a screenshot, a browser history, a proxy log — which used to
   * be readable by every account on the instance.
   */
  test("a card image is invisible to a game master with no claim on it", async () => {
    const owner = await signIn();
    const stranger = await signIn();

    const campaignForm = new FormData();
    campaignForm.set("name", unique("Campaign"));
    campaignForm.set("card", cardImage(1));
    const campaign = (
      await (await fetch(
        `${base}/api/campaigns`,
        authed(owner.cookie, { method: "POST", body: campaignForm }),
      )).json()
    ).campaign;

    const character = await addCardedCharacter(owner.cookie, campaign.id, "npc", 2);

    // The owner sees both, whether or not either is in a fight.
    expect((await fetch(`${base}${campaign.cardUrl}`, authed(owner.cookie))).status).toBe(200);
    expect((await fetch(`${base}${character.cardUrl}`, authed(owner.cookie))).status).toBe(200);

    // The other game master sees neither, and gets the same 404 an id that never
    // existed would give.
    expect((await fetch(`${base}${campaign.cardUrl}`, authed(stranger.cookie))).status).toBe(404);
    expect((await fetch(`${base}${character.cardUrl}`, authed(stranger.cookie))).status).toBe(404);
  });

  test("a player sees the cards of their own table and no others", async () => {
    const gm = await signIn();

    const campaignForm = new FormData();
    campaignForm.set("name", unique("Campaign"));
    campaignForm.set("card", cardImage(3));
    const campaign = (
      await (await fetch(
        `${base}/api/campaigns`,
        authed(gm.cookie, { method: "POST", body: campaignForm }),
      )).json()
    ).campaign;

    const staged = await addCardedCharacter(gm.cookie, campaign.id, "pc", 4);
    // Cast on the same campaign, but never brought into the fight.
    const offstage = await addCardedCharacter(gm.cookie, campaign.id, "npc", 5);

    const session = (
      await (await fetch(`${base}/api/sessions`, authed(gm.cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: campaign.id }),
      }))).json()
    ).session;
    await fetch(`${base}/api/sessions/${session.id}/stage`, authed(gm.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characterId: staged.id }),
    }));

    const player = await joinAs(session.code, "Pat");

    // Their own table: the campaign they are sitting at, and whoever is standing
    // on the stage.
    expect((await fetch(`${base}${campaign.cardUrl}`, { headers: { Cookie: player } })).status)
      .toBe(200);
    expect((await fetch(`${base}${staged.cardUrl}`, { headers: { Cookie: player } })).status)
      .toBe(200);
    // A monster the game master has not brought on is not theirs to look at,
    // even though it belongs to the campaign they are playing in.
    expect((await fetch(`${base}${offstage.cardUrl}`, { headers: { Cookie: player } })).status)
      .toBe(404);
  });
});

describe("character sheets reach only the right people", () => {
  /**
   * A table with two player characters staged, one of them claimed by Alice.
   *
   * Shared because the two tests below are the two halves of one question — who
   * is refused, and who is served — and only the second needs the rules data to
   * render anything.
   */
  const table = async () => {
    const gm = await signIn();
    const { pc, npc, session } = await makeTable(gm.cookie);

    // A second player character, so there is someone else's sheet to try.
    const form = new FormData();
    form.set("campaignId", pc.campaignId);
    form.set("kind", "pc");
    form.set("name", unique("pc"));
    form.set("sheet", hdcFile("Other.hdc"));
    const other = (
      await (await fetch(`${base}/api/characters`, authed(gm.cookie, { method: "POST", body: form }))).json()
    ).character;
    await fetch(
      `${base}/api/sessions/${session.id}/stage`,
      authed(gm.cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: other.id }),
      }),
    );

    const alice = await joinAs(session.code, "Alice");
    await fetch(
      `${base}/api/sessions/${session.id}/claim`,
      authed(alice, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: pc.id }),
      }),
    );

    return { gm, alice, pc, npc, other };
  };

  const status = async (id: string, cookie: string) =>
    (await fetch(`${base}/characters/${id}`, { headers: { Cookie: cookie } })).status;

  test("a player is refused every sheet but their own", async () => {
    const { alice, other, npc } = await table();

    // Another player's character, and an NPC: both hidden, and hidden as "not
    // found" so that probing ids says nothing about what exists.
    expect(await status(other.id, alice)).toBe(404);
    expect(await status(npc.id, alice)).toBe(404);
  });

  test.skipIf(!rulesAvailable)("and served the one they claimed, as the game master is served all of them", async () => {
    const { gm, alice, pc, npc } = await table();

    expect(await status(pc.id, alice)).toBe(200);
    // The game master sees everything in their own campaign.
    expect(await status(npc.id, gm.cookie)).toBe(200);
  });

  test.skipIf(!rulesAvailable)(
    "is drawn through the template of the game master who owns it, not the reader's",
    async () => {
      const { gm, alice, pc } = await table();

      // The game master chooses a template of their own. The player has no such
      // setting — no account to keep one on — so if the sheet were drawn through
      // the *requester's* template they would silently get the built-in, and two
      // people looking at one character would see two different sheets.
      const form = new FormData();
      form.set("template", hdeFile("mine.hde", { name: "Mine", marker: "the-gm-chose-this" }));
      const { template } = await (
        await fetch(`${base}/api/templates`, authed(gm.cookie, { method: "POST", body: form }))
      ).json();
      await fetch(`${base}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: base, Cookie: gm.cookie },
        body: JSON.stringify({ templateId: template.id }),
      });

      // The same shape of window for both, so what is being compared is whose
      // template was used rather than what shape it was drawn in.
      const asPlayer = await (
        await fetch(`${base}/characters/${pc.id}?ratio=1.7778`, { headers: { Cookie: alice } })
      ).text();
      const asGm = await (
        await fetch(`${base}/characters/${pc.id}?ratio=1.7778`, { headers: { Cookie: gm.cookie } })
      ).text();

      expect(asPlayer).toContain("the-gm-chose-this");
      expect(asGm).toContain("the-gm-chose-this");
      // The same sheet for both, which is the whole of what this is about.
      expect(asPlayer).toBe(asGm);
    },
  );

  test.skipIf(!rulesAvailable)("is drawn in the shape the reader's window asked for", async () => {
    const gm = await signIn();
    const { pc } = await makeTable(gm.cookie);

    const sheetAt = async (query: string) =>
      await (
        await fetch(`${base}/characters/${pc.id}${query}`, { headers: { Cookie: gm.cookie } })
      ).text();

    // A phone upright, a window snapped to half a screen, and a maximised one.
    expect(await sheetAt("?ratio=0.4620")).toContain("Layout: 9x16");
    expect(await sheetAt("?ratio=0.8889")).toContain("Layout: 8x9");
    expect(await sheetAt("?ratio=1.7778")).toContain("Layout: 16x9");

    // No ratio at all is the widescreen layout — what `curl` gets, and what
    // every caller got before any of this existed.
    expect(await sheetAt("")).toContain("Layout: 16x9");

    // And so is anything that is not a ratio. A query string somebody typed is
    // never a reason to refuse a character sheet mid-fight.
    for (const junk of ["?ratio=", "?ratio=abc", "?ratio=-3", "?ratio=0", "?ratio=1e400"]) {
      expect(await sheetAt(junk)).toContain("Layout: 16x9");
    }
  });

  test.skipIf(!rulesAvailable)("a sheet is served into an opaque origin", async () => {
    const gm = await signIn();
    const { pc } = await makeTable(gm.cookie);

    const response = await fetch(`${base}/characters/${pc.id}`, { headers: { Cookie: gm.cookie } });
    const policy = response.headers.get("content-security-policy") ?? "";

    // The sheet is this app's own output now, rather than an uploaded document —
    // but it still carries whatever CSS and web fonts the game master wrote into
    // the character, so `sandbox` without `allow-same-origin` is still what
    // denies it access to this app's cookies, storage and DOM.
    expect(policy).toContain("sandbox");
    expect(policy).not.toContain("allow-same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toContain("text/html");
    // Nothing is stored to go stale, and nothing is kept by anything in between.
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("a character filed from an HTML sheet says so rather than 404ing quietly", async () => {
    const gm = await signIn();
    const { pc } = await makeTable(gm.cookie);

    // What a library filed before this app read `.hdc` files looks like. The row
    // is written straight into the database rather than uploaded, because the
    // upload route will not take an HTML sheet any more — which is the point.
    db.query(
      "UPDATE uploads SET mime = 'text/html' " +
        "WHERE id = (SELECT sheet_upload_id FROM characters WHERE id = ?)",
    ).run(pc.id);

    const response = await fetch(`${base}/characters/${pc.id}`, { headers: { Cookie: gm.cookie } });
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toMatch(/\.hdc/);
  });
});

describe("HERO characteristics", () => {
  test("a character carries the numbers the form sent, and a slot starts there", async () => {
    const { cookie } = await signIn();
    const campaignForm = new FormData();
    campaignForm.set("name", unique("Campaign"));
    const campaign = (
      await (
        await fetch(`${base}/api/campaigns`, authed(cookie, { method: "POST", body: campaignForm }))
      ).json()
    ).campaign;

    const form = new FormData();
    form.set("campaignId", campaign.id);
    form.set("kind", "npc");
    form.set("name", unique("Ogre"));
    form.set("sheet", hdcFile());
    form.set("speed", "4");
    form.set("dexterity", "18");
    form.set("initiative", "2");
    form.set("constitution", "20");
    form.set("recovery", "8");
    form.set("endurance", "30");
    form.set("stun", "25");
    form.set("body", "12");
    const created = (
      await (
        await fetch(`${base}/api/characters`, authed(cookie, { method: "POST", body: form }))
      ).json()
    ).character;
    expect(created).toMatchObject({
      speed: 4,
      dexterity: 18,
      initiative: 2,
      constitution: 20,
      recovery: 8,
      endurance: 30,
      stun: 25,
      body: 12,
    });

    const session = (
      await (
        await fetch(
          `${base}/api/sessions`,
          authed(cookie, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaignId: campaign.id }),
          }),
        )
      ).json()
    ).session;
    const staged = (
      await (
        await fetch(
          `${base}/api/sessions/${session.id}/stage`,
          authed(cookie, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ characterId: created.id }),
          }),
        )
      ).json()
    ).snapshot;

    // On the stage it starts at full, as its own number.
    expect(staged.characters[0]).toMatchObject({
      currentEndurance: 30,
      currentStun: 25,
      currentBody: 12,
    });
  });

  test("SPEED is bounded on the server, not only by the form", async () => {
    const { cookie } = await signIn();
    const campaignForm = new FormData();
    campaignForm.set("name", unique("Campaign"));
    const campaign = (
      await (
        await fetch(`${base}/api/campaigns`, authed(cookie, { method: "POST", body: campaignForm }))
      ).json()
    ).campaign;

    // Past the twelve segments of a turn, sent by something that never saw the
    // editor's `max` — which is the only reason the schema's bound matters.
    const form = new FormData();
    form.set("campaignId", campaign.id);
    form.set("kind", "npc");
    form.set("name", unique("Blur"));
    form.set("sheet", hdcFile());
    form.set("speed", "13");
    const response = await fetch(
      `${base}/api/characters`,
      authed(cookie, { method: "POST", body: form }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("SPD must be between 0 and 12.");

    // The far end is refused too, and an unbounded characteristic is not.
    form.set("speed", "-1");
    expect(
      (await fetch(`${base}/api/characters`, authed(cookie, { method: "POST", body: form }))).status,
    ).toBe(400);

    form.set("speed", "12");
    form.set("stun", "60");
    expect(
      (await fetch(`${base}/api/characters`, authed(cookie, { method: "POST", body: form }))).status,
    ).toBe(201);
  });
});

describe("what a character has left", () => {
  const patchVitals = (
    cookie: string,
    sessionId: string,
    slotId: string,
    body: Record<string, number>,
  ) =>
    fetch(
      `${base}/api/sessions/${sessionId}/stage/${slotId}/vitals`,
      authed(cookie, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  /** The stage slot ids, in initiative order, as the game master sees them. */
  const slotsOf = async (cookie: string, sessionId: string) => {
    const snapshot = (
      await (await fetch(`${base}/api/sessions/${sessionId}`, authed(cookie))).json()
    ).snapshot;
    return snapshot.characters as { id: string; characterId: string }[];
  };

  test("the game master may write any slot", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const [first] = await slotsOf(cookie, session.id);

    const response = await patchVitals(cookie, session.id, first!.id, { stun: -6 });
    expect(response.status).toBe(200);
    expect((await response.json()).snapshot.characters[0].currentStun).toBe(-6);
  });

  test("a player may write their own character's, and only theirs", async () => {
    const { cookie } = await signIn();
    const { pc, npc, session } = await makeTable(cookie);
    const player = await joinAs(session.code, "Bob");

    await fetch(
      `${base}/api/sessions/${session.id}/claim`,
      authed(player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: pc.id }),
      }),
    );

    const slots = await slotsOf(cookie, session.id);
    const mine = slots.find((slot) => slot.characterId === pc.id)!;
    const theirs = slots.find((slot) => slot.characterId === npc.id)!;

    const own = await patchVitals(player, session.id, mine.id, { endurance: 7 });
    expect(own.status).toBe(200);

    const other = await patchVitals(player, session.id, theirs.id, { endurance: 7 });
    expect(other.status).toBe(403);

    // The refusal changed nothing.
    const after = (
      await (await fetch(`${base}/api/sessions/${session.id}`, authed(cookie))).json()
    ).snapshot.characters;
    expect(after.find((row: { id: string }) => row.id === theirs.id).currentEndurance).toBe(0);
  });

  test("a player may take a Recovery for their own character only", async () => {
    const { cookie } = await signIn();
    const { pc, npc, session } = await makeTable(cookie);
    const player = await joinAs(session.code, "Cass");

    await fetch(
      `${base}/api/sessions/${session.id}/claim`,
      authed(player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: pc.id }),
      }),
    );

    const slots = await slotsOf(cookie, session.id);
    const mine = slots.find((slot) => slot.characterId === pc.id)!;
    const theirs = slots.find((slot) => slot.characterId === npc.id)!;

    const own = await fetch(
      `${base}/api/sessions/${session.id}/stage/${mine.id}/recover`,
      authed(player, { method: "POST" }),
    );
    expect(own.status).toBe(200);

    const other = await fetch(
      `${base}/api/sessions/${session.id}/stage/${theirs.id}/recover`,
      authed(player, { method: "POST" }),
    );
    expect(other.status).toBe(403);
  });

  test("a player may rest their own character only", async () => {
    const { cookie } = await signIn();
    const { pc, npc, session } = await makeTable(cookie);
    const player = await joinAs(session.code, "Dov");

    await fetch(
      `${base}/api/sessions/${session.id}/claim`,
      authed(player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: pc.id }),
      }),
    );

    const slots = await slotsOf(cookie, session.id);
    const mine = slots.find((slot) => slot.characterId === pc.id)!;
    const theirs = slots.find((slot) => slot.characterId === npc.id)!;

    const own = await fetch(
      `${base}/api/sessions/${session.id}/stage/${mine.id}/rest`,
      authed(player, { method: "POST" }),
    );
    expect(own.status).toBe(200);

    const other = await fetch(
      `${base}/api/sessions/${session.id}/stage/${theirs.id}/rest`,
      authed(player, { method: "POST" }),
    );
    expect(other.status).toBe(403);
  });

  test("a player of another session is refused", async () => {
    const { cookie } = await signIn();
    const mine = await makeTable(cookie);
    const other = await makeTable(cookie);
    const stranger = await joinAs(other.session.code, "Eve");

    const [slot] = await slotsOf(cookie, mine.session.id);
    const response = await patchVitals(stranger, mine.session.id, slot!.id, { stun: 1 });
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(500);
  });

  describe("and a hit big enough to stun them", () => {
    /**
     * Gives a character a CON and its slot some STUN to lose.
     *
     * CON and the STUN total are edited in the library rather than seeded on the
     * slot, because that is where they live. What this copy has left is set
     * through the same route the rules are being tested on, as a total, which is
     * the path that never stuns and never knocks anybody out.
     *
     * A STUN total as well as a CON because both rules refuse to fire on a
     * character nobody has filled in, and `makeTable` fills in neither.
     */
    const arm = async (
      cookie: string,
      characterId: string,
      sessionId: string,
      slotId: string,
      constitution: number,
    ) => {
      const form = new FormData();
      form.set("constitution", String(constitution));
      form.set("stun", "30");
      const patched = await fetch(
        `${base}/api/characters/${characterId}`,
        authed(cookie, { method: "PATCH", body: form }),
      );
      expect(patched.status).toBe(200);
      expect((await patchVitals(cookie, sessionId, slotId, { stun: 30 })).status).toBe(200);
    };

    /** The tags on one slot, as the snapshot carries them. */
    const tagsOnSlot = async (cookie: string, sessionId: string, slotId: string) => {
      const snapshot = (
        await (await fetch(`${base}/api/sessions/${sessionId}`, authed(cookie))).json()
      ).snapshot;
      return snapshot.characters.find((row: { id: string }) => row.id === slotId).statusTags;
    };

    test("the server does the subtraction, so two hits at once both land", async () => {
      const { cookie } = await signIn();
      const { pc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);
      await arm(cookie, pc.id, session.id, slot!.id, 30);

      // Both computed from 30 had the browser been doing it, and the second
      // would have written the first one out of existence.
      await Promise.all([
        patchVitals(cookie, session.id, slot!.id, { stunTaken: 4 }),
        patchVitals(cookie, session.id, slot!.id, { stunTaken: 5 }),
      ]);

      const snapshot = (
        await (await fetch(`${base}/api/sessions/${session.id}`, authed(cookie))).json()
      ).snapshot;
      expect(snapshot.characters[0].currentStun).toBe(21);
    });

    test("more STUN than the CON stuns the character, and says so", async () => {
      const { cookie } = await signIn();
      const { pc, npc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);
      await arm(cookie, pc.id, session.id, slot!.id, 10);

      expect(
        (await patchVitals(cookie, session.id, slot!.id, { stunTaken: 11 })).status,
      ).toBe(200);

      expect(await tagsOnSlot(cookie, session.id, slot!.id)).toContain("stunned");
      // Nobody's line: the rules did this, not the game master.
      expect(await messages(cookie, session.id)).toEqual([
        ...opening(npc),
        becameStunned(pc.name),
      ]);
    });

    test("a hit no bigger than the CON does not", async () => {
      const { cookie } = await signIn();
      const { pc, npc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);
      await arm(cookie, pc.id, session.id, slot!.id, 10);

      // Exactly the CON, which is the edge the rule is written on: *more* than.
      await patchVitals(cookie, session.id, slot!.id, { stunTaken: 10 });

      expect(await tagsOnSlot(cookie, session.id, slot!.id)).toEqual([]);
      expect(await messages(cookie, session.id)).toEqual(opening(npc));
    });

    test("a character nobody has filled in is never stunned by one", async () => {
      const { cookie } = await signIn();
      const { npc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);

      // CON 0 is a sheet nobody typed, not a threshold of nought, so a hit of
      // any size at all must not stun them.
      await patchVitals(cookie, session.id, slot!.id, { stunTaken: 99 });

      expect(await tagsOnSlot(cookie, session.id, slot!.id)).toEqual([]);
      expect(await messages(cookie, session.id)).toEqual(opening(npc));
    });

    test("a character already stunned is not stunned again", async () => {
      const { cookie } = await signIn();
      const { pc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);
      await arm(cookie, pc.id, session.id, slot!.id, 10);

      await patchVitals(cookie, session.id, slot!.id, { stunTaken: 11 });
      const after = await messages(cookie, session.id);

      // The tag is on, so a second qualifying hit has nothing to add. A
      // character being beaten on would otherwise fill the log with one line.
      await patchVitals(cookie, session.id, slot!.id, { stunTaken: 11 });
      expect(await messages(cookie, session.id)).toEqual(after);
      expect(await tagsOnSlot(cookie, session.id, slot!.id)).toEqual(["stunned"]);
    });

    test("an exact set is a correction rather than a hit", async () => {
      const { cookie } = await signIn();
      const { pc, npc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);
      await arm(cookie, pc.id, session.id, slot!.id, 10);

      // The same 30 points off, written as where the number ends up. A game
      // master fixing a total is not damage, whatever the size of the change.
      await patchVitals(cookie, session.id, slot!.id, { stun: 0 });

      expect(await tagsOnSlot(cookie, session.id, slot!.id)).toEqual([]);
      expect(await messages(cookie, session.id)).toEqual(opening(npc));
    });

    test("a hit that takes the last of the STUN knocks the character out", async () => {
      const { cookie } = await signIn();
      const { pc, npc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);
      // A CON no hit here will beat, so this is the knockout on its own.
      await arm(cookie, pc.id, session.id, slot!.id, 40);

      // Exactly nought, which is the edge: reduced *to* zero is out cold.
      await patchVitals(cookie, session.id, slot!.id, { stunTaken: 30 });

      expect(await tagsOnSlot(cookie, session.id, slot!.id)).toEqual(["unconscious"]);
      expect(await messages(cookie, session.id)).toEqual([
        ...opening(npc),
        knockedOut(pc.name),
      ]);
    });

    test("and a hit that leaves them any STUN at all does not", async () => {
      const { cookie } = await signIn();
      const { pc, npc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);
      await arm(cookie, pc.id, session.id, slot!.id, 40);

      await patchVitals(cookie, session.id, slot!.id, { stunTaken: 29 });

      expect(await tagsOnSlot(cookie, session.id, slot!.id)).toEqual([]);
      expect(await messages(cookie, session.id)).toEqual(opening(npc));
    });

    test("one hit can do both, and says both", async () => {
      const { cookie } = await signIn();
      const { pc, npc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);
      await arm(cookie, pc.id, session.id, slot!.id, 10);

      // Past the CON and past the last of the STUN in one blow, which is the
      // ordinary way a fight ends: stunned by it and then out cold from it.
      await patchVitals(cookie, session.id, slot!.id, { stunTaken: 31 });

      expect((await tagsOnSlot(cookie, session.id, slot!.id)).sort())
        .toEqual(["stunned", "unconscious"]);
      // Two lines rather than one: a character can be stunned without going
      // down and can go down without ever being stunned, so which happened is
      // what the log is read back for.
      expect(await messages(cookie, session.id)).toEqual([
        ...opening(npc),
        becameStunned(pc.name),
        knockedOut(pc.name),
      ]);
    });

    test("a character already out cold is not knocked out again", async () => {
      const { cookie } = await signIn();
      const { pc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);
      await arm(cookie, pc.id, session.id, slot!.id, 40);

      await patchVitals(cookie, session.id, slot!.id, { stunTaken: 30 });
      const after = await messages(cookie, session.id);

      // Still being hit while down, which happens, and says nothing new.
      await patchVitals(cookie, session.id, slot!.id, { stunTaken: 5 });
      expect(await messages(cookie, session.id)).toEqual(after);
      expect(await tagsOnSlot(cookie, session.id, slot!.id)).toEqual(["unconscious"]);
    });

    test("a character with no STUN total is never knocked out by one", async () => {
      const { cookie } = await signIn();
      const { npc, session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);

      // They start at nought because nobody typed a total, not because they are
      // down, so the first scratch of the fight must not knock them out.
      await patchVitals(cookie, session.id, slot!.id, { stunTaken: 1 });

      expect(await tagsOnSlot(cookie, session.id, slot!.id)).toEqual([]);
      expect(await messages(cookie, session.id)).toEqual(opening(npc));
    });

    test("the knockout is toasted to the game master and that player only", async () => {
      const { cookie } = await signIn();
      const { pc, session } = await makeTable(cookie);
      const holder = await joinAs(session.code, "Down");
      const bystander = await joinAs(session.code, "Standing");
      await claimAs(holder, session.id, pc.id);

      const slots = await slotsOf(cookie, session.id);
      const slot = slots.find((row) => row.characterId === pc.id)!;
      await arm(cookie, pc.id, session.id, slot.id, 10);

      const [gmSocket, holderSocket, bystanderSocket] = await Promise.all([
        watchSession(cookie, session.id),
        watchSession(holder, session.id),
        watchSession(bystander, session.id),
      ]);

      const notices = (socket: WebSocket) => {
        const seen: { type: string; message: string; tone?: string }[] = [];
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "notice") seen.push(frame);
        });
        return seen;
      };
      const [toGm, toHolder, toBystander] =
        [gmSocket, holderSocket, bystanderSocket].map(notices);

      await patchVitals(cookie, session.id, slot.id, { stunTaken: 31 });
      await Bun.sleep(200);

      // Both consequences, in the order they happened to the character.
      expect(toGm).toEqual([
        { type: "notice", message: `${pc.name} has become stunned.`, tone: "error" },
        { type: "notice", message: `${pc.name} has been knocked out.`, tone: "error" },
      ]);
      expect(toHolder).toEqual(toGm);
      expect(toBystander).toEqual([]);

      for (const socket of [gmSocket, holderSocket, bystanderSocket]) socket.close();
    });

    test("a total and a hit cannot arrive together", async () => {
      const { cookie } = await signIn();
      const { session } = await makeTable(cookie);
      const [slot] = await slotsOf(cookie, session.id);

      // They are two different requests — where the number ends up, and what
      // happened to it — and a body with both in it has not said which.
      const response = await patchVitals(cookie, session.id, slot!.id, {
        stun: 12,
        stunTaken: 4,
      });
      expect(response.status).toBe(400);
    });

    test("the toast goes to the game master and that character's player only", async () => {
      const { cookie } = await signIn();
      const { pc, session } = await makeTable(cookie);
      const holder = await joinAs(session.code, "Held");
      const bystander = await joinAs(session.code, "Watching");
      await claimAs(holder, session.id, pc.id);

      const slots = await slotsOf(cookie, session.id);
      const slot = slots.find((row) => row.characterId === pc.id)!;
      await arm(cookie, pc.id, session.id, slot.id, 10);

      const [gmSocket, holderSocket, bystanderSocket] = await Promise.all([
        watchSession(cookie, session.id),
        watchSession(holder, session.id),
        watchSession(bystander, session.id),
      ]);

      /** Every notice a socket is sent while the hit is being applied. */
      const notices = (socket: WebSocket) => {
        const seen: { type: string; message: string; tone?: string }[] = [];
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "notice") seen.push(frame);
        });
        return seen;
      };
      const [toGm, toHolder, toBystander] =
        [gmSocket, holderSocket, bystanderSocket].map(notices);

      await patchVitals(cookie, session.id, slot.id, { stunTaken: 11 });
      // The snapshot and the notice are two frames on the same socket; this is
      // long enough for both, and the assertion below is what fails if it is not.
      await Bun.sleep(200);

      expect(toGm).toEqual([
        { type: "notice", message: `${pc.name} has become stunned.`, tone: "error" },
      ]);
      expect(toHolder).toEqual(toGm);
      // A monster's misfortune is not everyone's business, and the numbers
      // behind it are not this player's to see.
      expect(toBystander).toEqual([]);

      for (const socket of [gmSocket, holderSocket, bystanderSocket]) socket.close();
    });

    test("an unclaimed monster leaves the game master the only one told", async () => {
      const { cookie } = await signIn();
      const { npc, session } = await makeTable(cookie);
      const slots = await slotsOf(cookie, session.id);
      const slot = slots.find((row) => row.characterId === npc.id)!;
      await arm(cookie, npc.id, session.id, slot.id, 10);

      // Nothing to send to nobody: the notice goes out with no player named and
      // the route neither throws nor waits for one.
      expect(
        (await patchVitals(cookie, session.id, slot.id, { stunTaken: 11 })).status,
      ).toBe(200);
      expect(await tagsOnSlot(cookie, session.id, slot.id)).toContain("stunned");
    });
  });

  describe("and what condition they are in", () => {
    const patchTag = (
      cookie: string,
      sessionId: string,
      slotId: string,
      tag: string,
      active: boolean,
    ) =>
      fetch(
        `${base}/api/sessions/${sessionId}/stage/${slotId}/tags`,
        authed(cookie, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tag, active }),
        }),
      );

    test("the game master may tag any slot, and the snapshot carries it", async () => {
      const { cookie } = await signIn();
      const { session, pc, npc } = await makeTable(cookie);
      const [first] = await slotsOf(cookie, session.id);

      const response = await patchTag(cookie, session.id, first!.id, "prone", true);
      expect(response.status).toBe(200);
      expect((await response.json()).snapshot.characters[0].statusTags).toEqual(["prone"]);

      // Idempotent: the same request again is still one prone character.
      expect((await patchTag(cookie, session.id, first!.id, "prone", true)).status).toBe(200);
      const again = await slotsOf(cookie, session.id);
      expect((again[0] as unknown as { statusTags: string[] }).statusTags).toEqual(["prone"]);

      // And clearing it takes it off.
      await patchTag(cookie, session.id, first!.id, "prone", false);
      const cleared = await slotsOf(cookie, session.id);
      expect((cleared[0] as unknown as { statusTags: string[] }).statusTags).toEqual([]);

      // Both changes are written down, and the doubled press in between is not:
      // it left the character exactly as prone as it found them.
      expect(await messages(cookie, session.id)).toEqual([
        ...opening(npc),
        tagsAdded(GAME_MASTER, ["Prone"], pc.name),
        tagsRemoved(GAME_MASTER, ["Prone"], pc.name),
      ]);
    });

    test("a player may tag their own character, and only theirs", async () => {
      const { cookie } = await signIn();
      const { pc, npc, session } = await makeTable(cookie);
      const player = await joinAs(session.code, "Fen");

      await fetch(
        `${base}/api/sessions/${session.id}/claim`,
        authed(player, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characterId: pc.id }),
        }),
      );

      const slots = await slotsOf(cookie, session.id);
      const mine = slots.find((slot) => slot.characterId === pc.id)!;
      const theirs = slots.find((slot) => slot.characterId === npc.id)!;

      expect((await patchTag(player, session.id, mine.id, "stunned", true)).status).toBe(200);
      expect((await patchTag(player, session.id, theirs.id, "dead", true)).status).toBe(403);

      // Whoever acted is the subject: the player's own doing is in their name,
      // and the refusal is nobody's doing, so it is no line at all.
      expect(await messages(cookie, session.id)).toEqual([
        ...opening(npc),
        playerJoined("Fen"),
        playerSelected("Fen", pc.name),
        tagsAdded("Fen", ["Stunned"], pc.name),
      ]);

      // The refusal changed nothing: the NPC is not quietly dead.
      const after = await slotsOf(cookie, session.id);
      const npcRow = after.find((row) => row.id === theirs.id) as unknown as {
        statusTags: string[];
      };
      expect(npcRow.statusTags).toEqual([]);
    });

    test("a tag too long to draw is refused", async () => {
      const { cookie } = await signIn();
      const { session } = await makeTable(cookie);
      const [first] = await slotsOf(cookie, session.id);

      const response = await patchTag(cookie, session.id, first!.id, "x".repeat(40), true);
      expect(response.status).toBe(400);
    });

    test("a typed tag that spells a known one becomes that one", async () => {
      const { cookie } = await signIn();
      const { session, pc, npc } = await makeTable(cookie);
      const [first] = await slotsOf(cookie, session.id);

      await patchTag(cookie, session.id, first!.id, "  Prone  ", true);
      const response = await patchTag(cookie, session.id, first!.id, "On Fire", true);

      expect((await response.json()).snapshot.characters[0].statusTags)
        .toEqual(["prone", "On Fire"]);

      // The log calls a condition what the badge calls it: the known one in the
      // case a person writes it, the typed one exactly as it was typed.
      expect(await messages(cookie, session.id)).toEqual([
        ...opening(npc),
        tagsAdded(GAME_MASTER, ["Prone"], pc.name),
        tagsAdded(GAME_MASTER, ["On Fire"], pc.name),
      ]);
    });

    test("a second copy is tagged by the name the console gives it", async () => {
      const { cookie } = await signIn();
      const { session, npc } = await makeTable(cookie);

      // The same goblin again, so the stage holds two of it.
      const staged = (
        await (
          await fetch(
            `${base}/api/sessions/${session.id}/stage`,
            authed(cookie, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ characterId: npc.id }),
            }),
          )
        ).json()
      ).snapshot;
      const second = staged.characters.find(
        (character: { characterId: string; copyNumber: number }) =>
          character.characterId === npc.id && character.copyNumber === 2,
      );

      await patchTag(cookie, session.id, second.id, "prone", true);

      // "added Prone to Goblin" twice over would tell a table nothing about
      // which goblin went down.
      expect(await messages(cookie, session.id)).toEqual([
        ...opening(npc),
        gmAddedToScene(`${npc.name} 2`),
        tagsAdded(GAME_MASTER, ["Prone"], `${npc.name} 2`),
      ]);
    });

    test("clearing a tag nobody had writes nothing", async () => {
      const { cookie } = await signIn();
      const { session } = await makeTable(cookie);
      const [first] = await slotsOf(cookie, session.id);

      const before = await messages(cookie, session.id);
      expect((await patchTag(cookie, session.id, first!.id, "dead", false)).status).toBe(200);

      // Nothing about the character changed, so the log has nothing to say.
      expect(await messages(cookie, session.id)).toEqual(before);
    });
  });
});

describe("holding an action", () => {
  const patchHold = (cookie: string, sessionId: string, slotId: string, held: boolean) =>
    fetch(
      `${base}/api/sessions/${sessionId}/stage/${slotId}/hold`,
      authed(cookie, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ held }),
      }),
    );

  const step = (cookie: string, sessionId: string, direction: "next" | "prev" = "next") =>
    fetch(
      `${base}/api/sessions/${sessionId}/turn/advance`,
      authed(cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      }),
    ).then((response) => response.json());

  const stageOf = async (cookie: string, sessionId: string) => {
    const { snapshot } = await (
      await fetch(`${base}/api/sessions/${sessionId}`, authed(cookie))
    ).json();
    return snapshot as {
      session: { activeSlotId: string | null };
      characters: { id: string; characterId: string; name: string; isHeld: boolean }[];
    };
  };

  test("the game master may hold a slot, and the snapshot carries it", async () => {
    const { cookie } = await signIn();
    const { session, pc, npc } = await makeTable(cookie);
    const before = await stageOf(cookie, session.id);
    const [first, second] = before.characters;

    expect((await patchHold(cookie, session.id, first!.id, true)).status).toBe(200);

    const held = await stageOf(cookie, session.id);
    expect(held.characters.map((row) => row.isHeld)).toEqual([true, false]);

    // Idempotent, and the second press is not a second line in the log.
    expect((await patchHold(cookie, session.id, first!.id, true)).status).toBe(200);
    expect((await stageOf(cookie, session.id)).characters[0]!.isHeld).toBe(true);
    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      actionHeld(GAME_MASTER, pc.name),
    ]);
    expect(second!.isHeld).toBe(false);
  });

  test("holding from your own phase passes it, and the clock steps on", async () => {
    const { cookie } = await signIn();
    const { session, npc } = await makeTable(cookie);
    const stage = await stageOf(cookie, session.id);
    const [first, second] = stage.characters;

    // The first character is up, and declines the phase.
    expect((await step(cookie, session.id)).snapshot.session.activeSlotId).toBe(first!.id);
    const passing = await (await patchHold(cookie, session.id, first!.id, true)).json();

    expect(passing.snapshot.session.activeSlotId).toBe(second!.id);
    expect(passing.snapshot.characters[0]!.isHeld).toBe(true);

    // The log reads in the order it happened, and the clock's own line is only
    // written when a segment is left behind — this step stayed in segment 12.
    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      actionHeld(GAME_MASTER, first!.name),
    ]);
  });

  test("holding a character who is not up leaves the marker where it is", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const stage = await stageOf(cookie, session.id);
    const [first, second] = stage.characters;

    expect((await step(cookie, session.id)).snapshot.session.activeSlotId).toBe(first!.id);

    // Saying what the second character will do when their phase comes must not
    // cost the first character the phase they are in.
    const marked = await (await patchHold(cookie, session.id, second!.id, true)).json();
    expect(marked.snapshot.session.activeSlotId).toBe(first!.id);
  });

  test("a held character still gets stopped on at their own place in the order", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const stage = await stageOf(cookie, session.id);
    const [first, second] = stage.characters;

    await patchHold(cookie, session.id, second!.id, true);

    // Both characters are SPD 12, so the segment holds them in DEX order and
    // holding changes nothing about who the marker walks onto.
    expect((await step(cookie, session.id)).snapshot.session.activeSlotId).toBe(first!.id);
    expect((await step(cookie, session.id)).snapshot.session.activeSlotId).toBe(second!.id);
  });

  test("taking a held action cuts in, and the turn goes back to whoever was up", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const stage = await stageOf(cookie, session.id);
    const [first, second] = stage.characters;

    // The second character waits; the first opens the segment.
    await patchHold(cookie, session.id, second!.id, true);
    expect((await step(cookie, session.id)).snapshot.session.activeSlotId).toBe(first!.id);

    // Then cuts back in, which gives them the turn and clears the hold.
    const taken = await (await patchHold(cookie, session.id, second!.id, false)).json();
    expect(taken.snapshot.session.activeSlotId).toBe(second!.id);
    expect(taken.snapshot.characters.every((row: { isHeld: boolean }) => !row.isHeld)).toBe(true);

    // And the phase the interjection came out of is handed back rather than
    // walked past: the first character had not finished theirs.
    const back = await step(cookie, session.id);
    expect(back.snapshot.session.activeSlotId).toBe(first!.id);
    expect(back.snapshot.session.segment).toBe(12);

    // Only then does the order carry on.
    const on = await step(cookie, session.id);
    expect(on.snapshot.session.activeSlotId).toBe(second!.id);
  });

  test("stepping back out of an interjection returns to it too", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const stage = await stageOf(cookie, session.id);
    const [first, second] = stage.characters;

    await patchHold(cookie, session.id, second!.id, true);
    await step(cookie, session.id);
    await patchHold(cookie, session.id, second!.id, false);

    const back = await step(cookie, session.id, "prev");
    expect(back.snapshot.session.activeSlotId).toBe(first!.id);
    expect(back.snapshot.session.segment).toBe(12);
  });

  test("restarting the fight leaves nobody waiting", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const stage = await stageOf(cookie, session.id);

    await patchHold(cookie, session.id, stage.characters[0]!.id, true);
    await fetch(
      `${base}/api/sessions/${session.id}/turn/restart`,
      authed(cookie, { method: "POST" }),
    );

    const after = await stageOf(cookie, session.id);
    expect(after.characters.every((row) => !row.isHeld)).toBe(true);
  });

  test("a player may hold their own character, and only theirs", async () => {
    const { cookie } = await signIn();
    const { session, pc, npc } = await makeTable(cookie);
    const player = await joinAs(session.code, "Wren");

    await fetch(
      `${base}/api/sessions/${session.id}/claim`,
      authed(player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: pc.id }),
      }),
    );

    const stage = await stageOf(cookie, session.id);
    const mine = stage.characters.find((row) => row.characterId === pc.id)!;
    const theirs = stage.characters.find((row) => row.characterId === npc.id)!;

    expect((await patchHold(player, session.id, mine.id, true)).status).toBe(200);
    expect((await patchHold(player, session.id, theirs.id, true)).status).toBe(403);

    // Their own doing is in their name, and the refusal is nobody's doing.
    const after = await stageOf(cookie, session.id);
    expect(after.characters.find((row) => row.id === theirs.id)!.isHeld).toBe(false);
    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      playerJoined("Wren"),
      playerSelected("Wren", pc.name),
      actionHeld("Wren", pc.name),
    ]);
  });
});

describe("players are read-only", () => {
  test("a player cannot stage a character, set the turn, or touch the library", async () => {
    const gm = await signIn();
    const { pc, session } = await makeTable(gm.cookie);
    const player = await joinAs(session.code, "Bob");

    const attempts = [
      fetch(
        `${base}/api/sessions/${session.id}/stage`,
        authed(player, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characterId: pc.id }),
        }),
      ),
      fetch(
        `${base}/api/sessions/${session.id}/turn`,
        authed(player, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characterId: pc.id }),
        }),
      ),
      fetch(
        `${base}/api/sessions/${session.id}/turn/restart`,
        authed(player, { method: "POST" }),
      ),
      fetch(`${base}/api/sessions/${session.id}/end`, authed(player, { method: "POST" })),
      fetch(`${base}/api/campaigns`, authed(player)),
      fetch(`${base}/api/characters/${pc.id}`, authed(player, { method: "DELETE" })),
    ];

    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBeGreaterThanOrEqual(401);
      expect(response.status).toBeLessThan(500);
    }
  });

  test("a player cannot read a session they did not join", async () => {
    const gm = await signIn();
    const first = await makeTable(gm.cookie);
    const second = await makeTable(gm.cookie);
    const player = await joinAs(first.session.code, "Carol");

    expect(
      (await fetch(`${base}/api/sessions/${second.session.id}`, { headers: { Cookie: player } }))
        .status,
    ).toBe(401);
  });
});

describe("cross-site requests are refused", () => {
  test("a mutating request from another origin is blocked", async () => {
    const { cookie } = await signIn();
    const form = new FormData();
    form.set("name", unique("Campaign"));

    const response = await fetch(`${base}/api/campaigns`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://evil.example.com" },
      body: form,
    });

    expect(response.status).toBe(403);
  });

  test("a browser's own cross-site marker is enough to block it", async () => {
    const { cookie } = await signIn();
    const response = await fetch(`${base}/api/campaigns`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: base, "Sec-Fetch-Site": "cross-site" },
      body: new FormData(),
    });

    expect(response.status).toBe(403);
  });

  test("reading is unaffected", async () => {
    const { cookie } = await signIn();
    const response = await fetch(`${base}/api/campaigns`, {
      headers: { Cookie: cookie, Origin: "https://evil.example.com" },
    });
    // A cross-origin read cannot see the response body anyway, and blocking it
    // would break nothing an attacker cares about.
    expect(response.status).toBe(200);
  });
});

describe("session cookies", () => {
  test("are http-only and same-site", async () => {
    const email = `${unique("gm")}@example.com`;
    const password = "a-sufficiently-long-password";
    gms.create(email, await Bun.password.hash(password, { algorithm: "argon2id" }));

    const response = await fetch(`${base}/api/auth/gm/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ email, password }),
    });

    const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith("gm_sid="))!;
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie.toLowerCase()).toContain("path=/");
  });

  test("sign-in failures say the same thing whatever the cause", async () => {
    const email = `${unique("gm")}@example.com`;
    gms.create(email, await Bun.password.hash("the-real-password", { algorithm: "argon2id" }));

    const wrongPassword = await (
      await fetch(`${base}/api/auth/gm/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ email, password: "not-the-password" }),
      })
    ).json();

    const unknownEmail = await (
      await fetch(`${base}/api/auth/gm/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ email: "nobody@example.com", password: "not-the-password" }),
      })
    ).json();

    // Identical messages: whether an address has an account is not disclosed.
    expect(wrongPassword.error.message).toBe(unknownEmail.error.message);
  });
});

describe("a player leaving", () => {
  test("frees their name and their character so they can come back", async () => {
    const gm = await signIn();
    const { pc, session } = await makeTable(gm.cookie);

    const first = await joinAs(session.code, "Frank");
    await fetch(
      `${base}/api/sessions/${session.id}/claim`,
      authed(first, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: pc.id }),
      }),
    );

    await fetch(`${base}/api/auth/player/leave`, authed(first, { method: "POST" }));

    // The same name works again, and the character they held is free.
    const second = await joinAs(session.code, "Frank");
    const claim = await fetch(
      `${base}/api/sessions/${session.id}/claim`,
      authed(second, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: pc.id }),
      }),
    );
    expect(claim.status).toBe(200);
  });

  test("a refresh keeps the same identity and character", async () => {
    const gm = await signIn();
    const { pc, session } = await makeTable(gm.cookie);
    const player = await joinAs(session.code, "Grace");

    await fetch(
      `${base}/api/sessions/${session.id}/claim`,
      authed(player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: pc.id }),
      }),
    );

    // A reload is just another request carrying the same cookie.
    const me = await (
      await fetch(`${base}/api/auth/me`, { headers: { Cookie: player } })
    ).json();

    expect(me.kind).toBe("player");
    expect(me.player.name).toBe("Grace");
    expect(me.player.claimedCharacterId).toBe(pc.id);
  });
});

describe("the session list counts the players in each", () => {
  const listSessions = async (cookie: string) =>
    (await (await fetch(`${base}/api/sessions`, authed(cookie))).json()).sessions;

  test("a new session starts at nobody, and the count follows who joins and leaves", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);

    const found = async () =>
      (await listSessions(cookie)).find((entry: { id: string }) => entry.id === session.id);

    expect((await found()).playerCount).toBe(0);

    await joinAs(session.code, "Alice");
    const bob = await joinAs(session.code, "Bob");
    expect((await found()).playerCount).toBe(2);

    await fetch(`${base}/api/auth/player/leave`, authed(bob, { method: "POST" }));
    expect((await found()).playerCount).toBe(1);
  });

  test("each session is counted separately", async () => {
    const { cookie } = await signIn();
    const first = await makeTable(cookie);
    const second = await makeTable(cookie);

    await joinAs(first.session.code, "Alice");

    const byId = new Map(
      (await listSessions(cookie)).map((entry: { id: string; playerCount: number }) => [
        entry.id,
        entry.playerCount,
      ]),
    );
    expect(byId.get(first.session.id)).toBe(1);
    expect(byId.get(second.session.id)).toBe(0);
  });
});

/** The log of a session, as one of its readers sees it. */
async function messages(cookie: string, sessionId: string): Promise<string[]> {
  const body = await (await fetch(`${base}/api/sessions/${sessionId}`, authed(cookie))).json();
  return body.snapshot.events.map((event: { message: string }) => event.message);
}

/**
 * The three lines every fixture table opens with: the session beginning, the
 * segment the fight opens in, and the NPC `makeTable` walks on afterwards. The
 * campaign's PC is on the stage from the moment the session is created, so
 * staging it again is the no-op that writes nothing.
 */
function opening(npc: { name: string }): string[] {
  return [SESSION_STARTED, segmentBegan(1, 12), gmAddedToScene(npc.name)];
}

/** The roster row for a player, which is what the game master's routes name. */
async function playerNamed(cookie: string, sessionId: string, name: string) {
  const body = await (await fetch(`${base}/api/sessions/${sessionId}`, authed(cookie))).json();
  const player = body.snapshot.players.find((entry: { name: string }) => entry.name === name);
  expect(player).toBeTruthy();
  return player as { id: string; name: string };
}

/** A second player character in the campaign, put on the stage. */
async function addPc(cookie: string, campaignId: string, sessionId: string) {
  const form = new FormData();
  form.set("campaignId", campaignId);
  form.set("kind", "pc");
  form.set("name", unique("pc"));
  form.set("speed", "12");
  form.set("dexterity", "15");
  form.set("sheet", hdcFile());
  const character = (
    await (
      await fetch(`${base}/api/characters`, authed(cookie, { method: "POST", body: form }))
    ).json()
  ).character;

  await fetch(
    `${base}/api/sessions/${sessionId}/stage`,
    authed(cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characterId: character.id }),
    }),
  );
  return character as { id: string; name: string };
}

/** A player taking a character for themselves. */
/**
 * A session socket, carrying the cookie a browser would have sent.
 *
 * The only way to watch what the server says *to one screen* rather than what it
 * leaves in the database — a notice is an event and keeps nothing, so a test
 * that asks afterwards is asking too late.
 */
function watchSession(cookie: string, sessionId: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `${base.replace(/^http/, "ws")}/ws?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: { Cookie: cookie, Origin: base } } as unknown as string[],
  );
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("the socket was refused")), {
      once: true,
    });
  });
}

function claimAs(cookie: string, sessionId: string, characterId: string) {
  return fetch(
    `${base}/api/sessions/${sessionId}/claim`,
    authed(cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characterId }),
    }),
  );
}

/** A game master assigning one, or taking it back with `null`. */
function setClaim(
  cookie: string,
  sessionId: string,
  playerId: string,
  claimedCharacterId: string | null,
) {
  return fetch(
    `${base}/api/sessions/${sessionId}/players/${playerId}`,
    authed(cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimedCharacterId }),
    }),
  );
}

describe("the log", () => {
  test("a new session already says when it began", async () => {
    const { cookie } = await signIn();
    const { session, npc } = await makeTable(cookie);

    const snapshot = (
      await (await fetch(`${base}/api/sessions/${session.id}`, authed(cookie))).json()
    ).snapshot;

    // Written in the same transaction that made the session, so they are there
    // before anybody is watching — which is the only reason they can be seen at
    // all. A notice would have gone out to an empty room. The third line is the
    // fixture putting the NPC on the stage.
    expect(snapshot.events.map((event: { message: string }) => event.message)).toEqual(
      opening(npc),
    );
    expect(snapshot.events[0].message).toBe(SESSION_STARTED);
    expect(Number.isNaN(Date.parse(snapshot.events[0].at))).toBe(false);
  });

  test("a player who joins late still reads what came before them", async () => {
    const { cookie } = await signIn();
    const { session, npc } = await makeTable(cookie);
    const playerCookie = await joinAs(session.code, "Latecomer");

    // Their own arrival is on it too, which is the proof that the line was
    // written to the table's log rather than pushed at whoever was watching.
    expect(await messages(playerCookie, session.id)).toEqual([
      ...opening(npc),
      playerJoined("Latecomer"),
    ]);
  });

  test("the game master and the players read the same log", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const playerCookie = await joinAs(session.code, "Ada");

    expect(await messages(cookie, session.id)).toEqual(await messages(playerCookie, session.id));
  });

  test("a player choosing their own character is written down", async () => {
    const { cookie } = await signIn();
    const { session, pc, npc } = await makeTable(cookie);
    const playerCookie = await joinAs(session.code, "Ada");

    await claimAs(playerCookie, session.id, pc.id);

    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      playerJoined("Ada"),
      playerSelected("Ada", pc.name),
    ]);
  });

  test("a game master handing one out reads as the game master's doing", async () => {
    const { cookie } = await signIn();
    const { session, pc, npc } = await makeTable(cookie);
    await joinAs(session.code, "Ada");
    const ada = await playerNamed(cookie, session.id, "Ada");

    await setClaim(cookie, session.id, ada.id, pc.id);

    // The same character ends up in the same hands as the test above, and the
    // log says so differently — because a different person decided it.
    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      playerJoined("Ada"),
      gmAssigned(pc.name, "Ada"),
    ]);
  });

  test("taking a character back is written down too", async () => {
    const { cookie } = await signIn();
    const { session, pc, npc } = await makeTable(cookie);
    await joinAs(session.code, "Ada");
    const ada = await playerNamed(cookie, session.id, "Ada");

    await setClaim(cookie, session.id, ada.id, pc.id);
    await setClaim(cookie, session.id, ada.id, null);

    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      playerJoined("Ada"),
      gmAssigned(pc.name, "Ada"),
      gmUnassigned(pc.name, "Ada"),
    ]);
  });

  test("moving one between two players is a single line", async () => {
    const { cookie } = await signIn();
    const { session, pc, npc } = await makeTable(cookie);
    await joinAs(session.code, "Ada");
    await joinAs(session.code, "Bram");
    const ada = await playerNamed(cookie, session.id, "Ada");
    const bram = await playerNamed(cookie, session.id, "Bram");

    await setClaim(cookie, session.id, ada.id, pc.id);
    await setClaim(cookie, session.id, bram.id, pc.id);

    // One action by one person, so one line — and no moment in the log where the
    // character was held by nobody, because there never was one.
    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      playerJoined("Ada"),
      playerJoined("Bram"),
      gmAssigned(pc.name, "Ada"),
      gmReassigned(pc.name, "Ada", "Bram"),
    ]);
  });

  test("swapping a character onto someone who already held one writes both halves", async () => {
    const { cookie } = await signIn();
    const { session, pc, npc, campaign } = await makeTable(cookie);
    const second = await addPc(cookie, campaign.id, session.id);
    await joinAs(session.code, "Ada");
    await joinAs(session.code, "Bram");
    const ada = await playerNamed(cookie, session.id, "Ada");
    const bram = await playerNamed(cookie, session.id, "Bram");

    await setClaim(cookie, session.id, ada.id, second.id);
    await setClaim(cookie, session.id, bram.id, pc.id);
    // Ada puts down the one she has and picks up the one Bram was holding.
    await setClaim(cookie, session.id, ada.id, pc.id);

    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      // The second player character, walked on by `addPc` after the session had
      // already begun, so unlike the campaign's own PC it is a line.
      gmAddedToScene(second.name),
      playerJoined("Ada"),
      playerJoined("Bram"),
      gmAssigned(second.name, "Ada"),
      gmAssigned(pc.name, "Bram"),
      gmUnassigned(second.name, "Ada"),
      gmReassigned(pc.name, "Bram", "Ada"),
    ]);
  });

  test("re-picking the character already chosen writes nothing", async () => {
    const { cookie } = await signIn();
    const { session, pc } = await makeTable(cookie);
    await joinAs(session.code, "Ada");
    const ada = await playerNamed(cookie, session.id, "Ada");

    await setClaim(cookie, session.id, ada.id, pc.id);
    const before = await messages(cookie, session.id);
    await setClaim(cookie, session.id, ada.id, pc.id);

    // Nothing about the table changed, so the log has nothing to say.
    expect(await messages(cookie, session.id)).toEqual(before);
  });

  test("walking a character on and off the stage is written down", async () => {
    const { cookie } = await signIn();
    const { session, pc, npc } = await makeTable(cookie);

    // A second goblin, and then the same goblin off again.
    const staged = (
      await (
        await fetch(
          `${base}/api/sessions/${session.id}/stage`,
          authed(cookie, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ characterId: npc.id }),
          }),
        )
      ).json()
    ).snapshot;
    const second = staged.characters.find(
      (character: { characterId: string; copyNumber: number }) =>
        character.characterId === npc.id && character.copyNumber === 2,
    );

    await fetch(
      `${base}/api/sessions/${session.id}/stage/${second.id}`,
      authed(cookie, { method: "DELETE" }),
    );

    // The copy number comes along, because "added Goblin" three times over tells
    // a table which goblin exactly as well as saying nothing would.
    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      gmAddedToScene(`${npc.name} 2`),
      gmRemovedFromScene(`${npc.name} 2`),
    ]);

    // A hero already on the stage cannot be brought on twice, and a stage that
    // did not change is not something to write down.
    const before = await messages(cookie, session.id);
    await fetch(
      `${base}/api/sessions/${session.id}/stage`,
      authed(cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: pc.id }),
      }),
    );
    expect(await messages(cookie, session.id)).toEqual(before);
  });

  test("the game master can throw it away, and it says so afterwards", async () => {
    const { cookie } = await signIn();
    const { session, npc } = await makeTable(cookie);
    await joinAs(session.code, "Ada");
    expect(await messages(cookie, session.id)).toEqual([...opening(npc), playerJoined("Ada")]);

    const response = await fetch(
      `${base}/api/sessions/${session.id}/log/clear`,
      authed(cookie, { method: "POST" }),
    );
    expect(response.status).toBe(200);

    // Everything that came before is gone, and the clearing is the whole of what
    // is left: an empty drawer would read as a fault rather than as somebody's
    // doing. The response carries the same log the next reader gets.
    const { snapshot } = await response.json();
    expect(snapshot.events.map((event: { message: string }) => event.message)).toEqual([
      LOG_CLEARED,
    ]);
    expect(await messages(cookie, session.id)).toEqual([LOG_CLEARED]);
  });

  test("a player reads the cleared log but cannot clear it", async () => {
    const { cookie } = await signIn();
    const { session, npc } = await makeTable(cookie);
    const playerCookie = await joinAs(session.code, "Ada");

    // The log is theirs to read, not theirs to empty.
    const refused = await fetch(
      `${base}/api/sessions/${session.id}/log/clear`,
      authed(playerCookie, { method: "POST" }),
    );
    expect(refused.status).toBeGreaterThanOrEqual(401);
    expect(refused.status).toBeLessThan(500);
    expect(await messages(cookie, session.id)).toEqual([...opening(npc), playerJoined("Ada")]);

    // And when the game master does it, the player is reading the same log
    // afterwards as before: one table, one history.
    await fetch(`${base}/api/sessions/${session.id}/log/clear`, authed(cookie, { method: "POST" }));
    expect(await messages(playerCookie, session.id)).toEqual([LOG_CLEARED]);
  });

  test("one session's log is cleared without touching another's", async () => {
    const { cookie } = await signIn();
    const mine = await makeTable(cookie);
    const theirs = await makeTable(cookie);

    await fetch(
      `${base}/api/sessions/${mine.session.id}/log/clear`,
      authed(cookie, { method: "POST" }),
    );

    expect(await messages(cookie, mine.session.id)).toEqual([LOG_CLEARED]);
    expect(await messages(cookie, theirs.session.id)).toEqual(opening(theirs.npc));
  });

  test("leaving, and being made to leave, read differently", async () => {
    const { cookie } = await signIn();
    const { session, npc } = await makeTable(cookie);
    const adaCookie = await joinAs(session.code, "Ada");
    await joinAs(session.code, "Bram");
    const bram = await playerNamed(cookie, session.id, "Bram");

    await fetch(`${base}/api/auth/player/leave`, authed(adaCookie, { method: "POST" }));
    await fetch(
      `${base}/api/sessions/${session.id}/players/${bram.id}`,
      authed(cookie, { method: "DELETE" }),
    );

    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      playerJoined("Ada"),
      playerJoined("Bram"),
      playerLeft("Ada"),
      gmKicked("Bram"),
    ]);
  });
});

describe("a campaign runs one session at a time", () => {
  const start = (cookie: string, campaignId: string) =>
    fetch(
      `${base}/api/sessions`,
      authed(cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId }),
      }),
    );

  test("starting a second one is refused, and says why", async () => {
    const { cookie } = await signIn();
    const { campaign } = await makeTable(cookie);

    const response = await start(cookie, campaign.id);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toMatch(/already has a session running/i);
  });

  test("ending the first lets the next one start", async () => {
    const { cookie } = await signIn();
    const { campaign, session } = await makeTable(cookie);

    await fetch(`${base}/api/sessions/${session.id}/end`, authed(cookie, { method: "POST" }));

    const response = await start(cookie, campaign.id);
    expect(response.status).toBe(201);
    expect((await response.json()).session.id).not.toBe(session.id);
  });
});

describe("more than one copy of an NPC", () => {
  /** Puts a character on the stage and answers with the new snapshot. */
  async function stage(cookie: string, sessionId: string, characterId: string) {
    const response = await fetch(
      `${base}/api/sessions/${sessionId}/stage`,
      authed(cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId }),
      }),
    );
    return { status: response.status, snapshot: (await response.json()).snapshot };
  }

  test("an NPC added twice stands in two slots, a PC in one", async () => {
    const gm = await signIn();
    const { pc, npc, session } = await makeTable(gm.cookie);

    const { snapshot } = await stage(gm.cookie, session.id, npc.id);
    const npcSlots = snapshot.characters.filter(
      (character: { characterId: string }) => character.characterId === npc.id,
    );
    expect(npcSlots).toHaveLength(2);
    expect(npcSlots.map((slot: { copyNumber: number }) => slot.copyNumber)).toEqual([1, 2]);
    // Two slots, two identities — which is what gives each its own turn.
    expect(new Set(npcSlots.map((slot: { id: string }) => slot.id)).size).toBe(2);

    // The hero is not a monster: asking twice changes nothing.
    const again = await stage(gm.cookie, session.id, pc.id);
    expect(again.status).toBe(200);
    expect(
      again.snapshot.characters.filter(
        (character: { characterId: string }) => character.characterId === pc.id,
      ),
    ).toHaveLength(1);
  });

  test("removing one copy leaves the other where it was", async () => {
    const gm = await signIn();
    const { npc, session } = await makeTable(gm.cookie);
    const { snapshot: staged } = await stage(gm.cookie, session.id, npc.id);

    const copies = staged.characters.filter(
      (character: { characterId: string }) => character.characterId === npc.id,
    );
    const [first, second] = copies;

    // Put the turn on the copy that is staying, so we can see it survive.
    await fetch(
      `${base}/api/sessions/${session.id}/turn`,
      authed(gm.cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotId: second.id }),
      }),
    );

    const response = await fetch(
      `${base}/api/sessions/${session.id}/stage/${first.id}`,
      authed(gm.cookie, { method: "DELETE" }),
    );
    expect(response.status).toBe(200);

    const { snapshot } = await response.json();
    const left = snapshot.characters.filter(
      (character: { characterId: string }) => character.characterId === npc.id,
    );
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(second.id);
    // Copy 2 is still copy 2: a number names the monster, not its place in line.
    expect(left[0].copyNumber).toBe(2);
    expect(snapshot.session.activeSlotId).toBe(second.id);
    // …and the order behind it closed up.
    expect(snapshot.characters.map((c: { position: number }) => c.position)).toEqual(
      snapshot.characters.map((_: unknown, index: number) => index),
    );
  });

});

describe("restarting the turn order", () => {
  /** Walks the tracker forward `steps` times and reports where it ended up. */
  async function advance(cookie: string, sessionId: string, steps: number) {
    let body!: {
      snapshot: { session: { turn: number; segment: number; activeSlotId: string | null } };
    };
    for (let i = 0; i < steps; i += 1) {
      const response = await fetch(
        `${base}/api/sessions/${sessionId}/turn/advance`,
        authed(cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ direction: "next" }),
        }),
      );
      body = await response.json();
    }
    return body.snapshot.session;
  }

  test("goes back to the start of the fight, leaving the stage alone", async () => {
    const gm = await signIn();
    const { session } = await makeTable(gm.cookie);

    const { snapshot: opening } = await (
      await fetch(`${base}/api/sessions/${session.id}`, authed(gm.cookie))
    ).json();
    const staged = opening.characters.map((character: { id: string }) => character.id);
    expect(staged.length).toBeGreaterThan(0);

    // Two SPD 12 characters, so five steps is segment 12 of turn 1 and then two
    // segments of turn 2.
    const before = await advance(gm.cookie, session.id, 5);
    expect(before.turn).toBe(2);
    expect(before.segment).toBe(2);
    expect(before.activeSlotId).not.toBeNull();

    const response = await fetch(
      `${base}/api/sessions/${session.id}/turn/restart`,
      authed(gm.cookie, { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const { snapshot } = await response.json();
    expect(snapshot.session.turn).toBe(1);
    expect(snapshot.session.segment).toBe(12);
    expect(snapshot.session.activeSlotId).toBeNull();
    // The fight restarts, not the session: the same characters are on the stage,
    // in the same order they were in before.
    expect(snapshot.characters.map((character: { id: string }) => character.id)).toEqual(staged);
  });

  test("leaves the next step opening turn 1 segment 12 at the top of the order", async () => {
    const gm = await signIn();
    const { session } = await makeTable(gm.cookie);

    await advance(gm.cookie, session.id, 3);
    await fetch(
      `${base}/api/sessions/${session.id}/turn/restart`,
      authed(gm.cookie, { method: "POST" }),
    );

    const after = await advance(gm.cookie, session.id, 1);
    expect(after.turn).toBe(1);
    expect(after.segment).toBe(12);

    const { snapshot } = await (
      await fetch(`${base}/api/sessions/${session.id}`, authed(gm.cookie))
    ).json();
    expect(after.activeSlotId).toBe(snapshot.characters[0].id);
  });

  test("says in the log that the fight is back at its opening segment", async () => {
    const gm = await signIn();
    const { session, npc } = await makeTable(gm.cookie);

    // Into turn 2, which the clock wrote down on the way.
    await advance(gm.cookie, session.id, 4);
    await fetch(
      `${base}/api/sessions/${session.id}/turn/restart`,
      authed(gm.cookie, { method: "POST" }),
    );

    // The same line the session opened with, because this is the same place: a
    // log that fell silent here would leave everything after it filed under a
    // segment the fight had already left. The press that follows is only the
    // marker taking its first character, so it adds nothing.
    expect(await messages(gm.cookie, session.id)).toEqual([
      ...opening(npc),
      segmentBegan(2, 1),
      segmentBegan(1, 12),
    ]);

    await advance(gm.cookie, session.id, 1);
    expect(await messages(gm.cookie, session.id)).toEqual([
      ...opening(npc),
      segmentBegan(2, 1),
      segmentBegan(1, 12),
    ]);
  });
});

describe("ending a session", () => {
  test("freezes it against every further change", async () => {
    const gm = await signIn();
    const { pc, session } = await makeTable(gm.cookie);
    await fetch(`${base}/api/sessions/${session.id}/end`, authed(gm.cookie, { method: "POST" }));

    // The owner is still the owner, but an ended session accepts nothing.
    const mutations = await Promise.all([
      fetch(
        `${base}/api/sessions/${session.id}/stage/${pc.id}`,
        authed(gm.cookie, { method: "DELETE" }),
      ),
      fetch(
        `${base}/api/sessions/${session.id}/stage`,
        authed(gm.cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characterId: pc.id }),
        }),
      ),
      fetch(
        `${base}/api/sessions/${session.id}/turn/advance`,
        authed(gm.cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ direction: "next" }),
        }),
      ),
      fetch(
        `${base}/api/sessions/${session.id}/turn/restart`,
        authed(gm.cookie, { method: "POST" }),
      ),
    ]);

    for (const response of mutations) expect(response.status).toBe(409);

    // Reading it back still works, so the session stays visible as history.
    expect(
      (await fetch(`${base}/api/sessions/${session.id}`, authed(gm.cookie))).status,
    ).toBe(200);
  });

  test("revokes the code and cuts the player off", async () => {
    const gm = await signIn();
    const { session } = await makeTable(gm.cookie);
    const player = await joinAs(session.code, "Dave");

    await fetch(`${base}/api/sessions/${session.id}/end`, authed(gm.cookie, { method: "POST" }));

    const rejoin = await fetch(`${base}/api/sessions/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ code: session.code, name: "Eve" }),
    });
    expect(rejoin.status).toBe(404);

    // The player's cookie no longer identifies anyone.
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: player } })).json();
    expect(me.kind).toBe("anonymous");
  });
});

describe("the library socket", () => {
  interface SessionList {
    type: string;
    sessions: { id: string; status: string; campaignName: string }[];
  }

  const wsBase = () => base.replace(/^http/, "ws");

  /**
   * Bun's WebSocket client accepts request headers, which is how a socket is
   * given the cookie a browser would have sent. The DOM type in `lib` has no
   * such argument, hence the cast.
   */
  function connect(cookie: string): WebSocket {
    return new WebSocket(`${wsBase()}/ws?scope=library`, {
      headers: { Cookie: cookie, Origin: base },
    } as unknown as string[]);
  }

  /** The next message the socket delivers, parsed. */
  function nextMessage(socket: WebSocket): Promise<SessionList> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the socket sent nothing")), 5000);
      socket.addEventListener(
        "message",
        (event) => {
          clearTimeout(timer);
          resolve(JSON.parse(String((event as MessageEvent).data)));
        },
        { once: true },
      );
    });
  }

  test("sends the session list on open, and again whenever it changes", async () => {
    const { cookie } = await signIn();
    const { campaign, session } = await makeTable(cookie);

    const socket = connect(cookie);

    try {
      const onOpen = await nextMessage(socket);
      expect(onOpen.type).toBe("sessions");
      expect(onOpen.sessions.map((entry) => entry.id)).toContain(session.id);

      // Ending it republishes the list, which is what takes the row off a
      // library open in another tab.
      const afterEnd = nextMessage(socket);
      await fetch(`${base}/api/sessions/${session.id}/end`, authed(cookie, { method: "POST" }));
      expect(
        (await afterEnd).sessions.find((entry) => entry.id === session.id)?.status,
      ).toBe("ended");

      // So does renaming the campaign a session is listed under.
      const afterRename = nextMessage(socket);
      const form = new FormData();
      form.set("name", unique("Renamed"));
      await fetch(
        `${base}/api/campaigns/${campaign.id}`,
        authed(cookie, { method: "PATCH", body: form }),
      );
      expect(
        (await afterRename).sessions.find((entry) => entry.id === session.id)?.campaignName,
      ).toMatch(/^Renamed-/);
    } finally {
      socket.close();
    }
  });

  test("carries one game master's sessions and nobody else's", async () => {
    const mine = await signIn();
    const theirs = await signIn();
    const { session } = await makeTable(theirs.cookie);

    const socket = connect(mine.cookie);
    try {
      const list = await nextMessage(socket);
      expect(list.sessions.map((entry) => entry.id)).not.toContain(session.id);
    } finally {
      socket.close();
    }
  });

  /** Whether a handshake was accepted, without caring how it was turned away. */
  function settles(socket: WebSocket): Promise<string> {
    return new Promise((resolve) => {
      socket.addEventListener("open", () => resolve("open"), { once: true });
      socket.addEventListener("close", () => resolve("closed"), { once: true });
      socket.addEventListener("error", () => resolve("closed"), { once: true });
    });
  }

  test("refuses a caller who is not signed in", async () => {
    // Carries the Origin a browser would send, so what this measures is the
    // missing cookie and not the check below.
    const socket = new WebSocket(`${wsBase()}/ws?scope=library`, {
      headers: { Origin: base },
    } as unknown as string[]);
    expect(await settles(socket)).toBe("closed");
    socket.close();
  });

  /**
   * A handshake is exempt from CORS, so a page on another site can open one and
   * the browser will not stop it. `SameSite=Lax` keeps the cookie off that
   * request, but the server refuses it on the Origin alone — which is what holds
   * even where the cookie policy does not, and is the same rule the JSON API
   * applies to every request that changes something.
   */
  test("refuses a signed-in caller arriving from another site", async () => {
    const { cookie } = await signIn();
    const socket = new WebSocket(`${wsBase()}/ws?scope=library`, {
      headers: { Cookie: cookie, Origin: "https://evil.example" },
    } as unknown as string[]);
    expect(await settles(socket)).toBe("closed");
    socket.close();
  });
});

describe("a player who disconnects gives up their seat", () => {
  const GRACE_MS = Number(process.env.PLAYER_GRACE_MS);

  /** A player's socket, carrying the cookie their browser would have sent. */
  function watch(cookie: string, sessionId: string): Promise<WebSocket> {
    const socket = new WebSocket(
      `${base.replace(/^http/, "ws")}/ws?sessionId=${encodeURIComponent(sessionId)}`,
      { headers: { Cookie: cookie, Origin: base } } as unknown as string[],
    );
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", () => reject(new Error("the socket was refused")), {
        once: true,
      });
    });
  }

  const roster = async (cookie: string, sessionId: string): Promise<string[]> => {
    const body = await (await fetch(`${base}/api/sessions/${sessionId}`, authed(cookie))).json();
    return body.snapshot.players.map((player: { name: string }) => player.name);
  };

  test("closing the last connection removes them, once the grace period is up", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const alice = await joinAs(session.code, "Alice");
    await joinAs(session.code, "Bob");

    const socket = await watch(alice, session.id);
    socket.close();

    // Still seated while the clock runs — closing a socket is not leaving.
    expect(await roster(cookie, session.id)).toContain("Alice");

    await Bun.sleep(GRACE_MS * 3);
    expect(await roster(cookie, session.id)).toEqual(["Bob"]);
  });

  test("the log says so, since nobody at the table saw it happen", async () => {
    const { cookie } = await signIn();
    const { session, npc } = await makeTable(cookie);
    const alice = await joinAs(session.code, "Alice");

    const socket = await watch(alice, session.id);
    socket.close();
    await Bun.sleep(GRACE_MS * 3);

    // Worded apart from `left`: they did not press anything, and a game master
    // reading the log later should be able to tell the two apart.
    expect(await messages(cookie, session.id)).toEqual([
      ...opening(npc),
      playerJoined("Alice"),
      playerDisconnected("Alice"),
    ]);
  });

  test("coming straight back keeps the seat", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const alice = await joinAs(session.code, "Alice");

    // What a reload looks like from here: the socket goes, another arrives.
    const first = await watch(alice, session.id);
    first.close();
    const second = await watch(alice, session.id);

    await Bun.sleep(GRACE_MS * 3);
    expect(await roster(cookie, session.id)).toEqual(["Alice"]);
    second.close();
  });

  test("a second connection of the same player is not one player leaving", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const alice = await joinAs(session.code, "Alice");

    // Two tabs open on the same session; shutting one is not going away.
    const phone = await watch(alice, session.id);
    const laptop = await watch(alice, session.id);
    phone.close();

    await Bun.sleep(GRACE_MS * 3);
    expect(await roster(cookie, session.id)).toEqual(["Alice"]);
    laptop.close();
  });

  test("an ended session keeps the roster it finished with", async () => {
    const { cookie } = await signIn();
    const { session } = await makeTable(cookie);
    const alice = await joinAs(session.code, "Alice");
    await watch(alice, session.id);

    // Ending the session disconnects everyone, which must not then empty it:
    // nobody is coming back, and the game master may still be reading it.
    await fetch(`${base}/api/sessions/${session.id}/end`, authed(cookie, { method: "POST" }));

    await Bun.sleep(GRACE_MS * 3);
    expect(await roster(cookie, session.id)).toEqual(["Alice"]);
  });
});

describe("a sheet's own picture becomes the character's", () => {
  const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
  const GIF_HEADER = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0];

  function image(header: number[], bytes: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(new ArrayBuffer(bytes));
    data.set(header);
    for (let i = header.length; i < bytes; i += 1) data[i] = (i * 7) % 251;
    return data;
  }

  /** A character file as HERO Designer saves one: the picture is inside it. */
  function sheetWithPortrait(): File {
    return hdcFile("Hero.hdc", { name: "Hero", image: image(PNG_HEADER, 4096) });
  }

  async function addCharacter(cookie: string, campaignId: string, fields: FormData) {
    fields.set("campaignId", campaignId);
    fields.set("kind", "pc");
    if (!fields.get("name")) fields.set("name", unique("Hero"));
    const response = await fetch(
      `${base}/api/characters`,
      authed(cookie, { method: "POST", body: fields }),
    );
    expect(response.status).toBe(201);
    return (await response.json()).character;
  }

  /** What the browser would actually receive for that character's picture. */
  const pictureType = async (cookie: string, url: string) =>
    (await fetch(base + url, authed(cookie))).headers.get("Content-Type");

  test("a character uploaded with no image gets the one in its sheet", async () => {
    const { cookie } = await signIn();
    const { campaign } = await makeTable(cookie);

    const form = new FormData();
    form.set("sheet", sheetWithPortrait());
    const character = await addCharacter(cookie, campaign.id, form);

    expect(character.cardUrl).not.toBeNull();
    expect(await pictureType(cookie, character.cardUrl)).toBe("image/png");
  });

  test.skipIf(!rulesAvailable)(
    "and the sheet is rendered without the copy it carried",
    async () => {
      const { cookie } = await signIn();
      const { campaign } = await makeTable(cookie);

      // The same picture the character file is built around, encoded as the file
      // itself stores it.
      const portrait = Buffer.from(image(PNG_HEADER, 4096)).toString("base64");

      const form = new FormData();
      form.set("sheet", sheetWithPortrait());
      const character = await addCharacter(cookie, campaign.id, form);
      expect(character.cardUrl).not.toBeNull();

      const html = await (await fetch(base + character.sheetUrl, authed(cookie))).text();
      // The picture is a card now, so the sheet no longer carries it as well.
      expect(html).not.toContain(portrait.slice(0, 200));
      // And it is still that character's sheet.
      expect(html).toContain("Hero");
    },
  );

  test("a sheet with no picture in it leaves the character without one", async () => {
    const { cookie } = await signIn();
    const { campaign } = await makeTable(cookie);

    const form = new FormData();
    form.set("sheet", hdcFile("Hero.hdc"));
    const character = await addCharacter(cookie, campaign.id, form);

    expect(character.cardUrl).toBeNull();
  });

  test("an image the game master chose is not overruled by the sheet", async () => {
    const { cookie } = await signIn();
    const { campaign } = await makeTable(cookie);

    const form = new FormData();
    form.set("sheet", sheetWithPortrait());
    form.set("card", new File([image(GIF_HEADER, 3000)], "chosen.gif"));
    const character = await addCharacter(cookie, campaign.id, form);

    // The GIF they picked, not the PNG in the sheet.
    expect(await pictureType(cookie, character.cardUrl)).toBe("image/gif");
  });

  test("replacing the sheet fills an empty picture, and only an empty one", async () => {
    const { cookie } = await signIn();
    const { campaign } = await makeTable(cookie);

    const bare = new FormData();
    bare.set("sheet", hdcFile("Hero.hdc"));
    const character = await addCharacter(cookie, campaign.id, bare);
    expect(character.cardUrl).toBeNull();

    const patch = async (body: FormData) =>
      (await (
        await fetch(
          `${base}/api/characters/${character.id}`,
          authed(cookie, { method: "PATCH", body }),
        )
      ).json()).character;

    // Nothing to lose, so the new sheet's portrait is taken.
    const withPortrait = new FormData();
    withPortrait.set("sheet", sheetWithPortrait());
    const filled = await patch(withPortrait);
    expect(filled.cardUrl).not.toBeNull();
    expect(await pictureType(cookie, filled.cardUrl)).toBe("image/png");

    // Now there is a picture, a later sheet must not replace it.
    const gifSheet = new FormData();
    gifSheet.set("sheet", hdcFile("Hero2.hdc", { image: image(GIF_HEADER, 8000) }));
    const kept = await patch(gifSheet);
    expect(kept.cardUrl).toBe(filled.cardUrl);
  });

  test("a character's picture can be taken away, and an upload outranks doing so", async () => {
    const { cookie } = await signIn();
    const { campaign } = await makeTable(cookie);

    const form = new FormData();
    form.set("sheet", sheetWithPortrait());
    const character = await addCharacter(cookie, campaign.id, form);
    expect(character.cardUrl).not.toBeNull();

    const patch = async (body: FormData) =>
      (await (
        await fetch(
          `${base}/api/characters/${character.id}`,
          authed(cookie, { method: "PATCH", body }),
        )
      ).json()).character;

    // The checkbox on the edit dialog, and a new picture in the same submission:
    // choosing one is not a way to lose it.
    const replaced = new FormData();
    replaced.set("removeCard", "true");
    replaced.set("card", new File([image(GIF_HEADER, 3000)], "chosen.gif"));
    expect(await pictureType(cookie, (await patch(replaced)).cardUrl)).toBe("image/gif");

    // On its own, it empties the picture.
    const removal = new FormData();
    removal.set("removeCard", "true");
    expect((await patch(removal)).cardUrl).toBeNull();
  });
});

describe("pictures are stored at the size a card shows them", () => {
  /** A real picture, decodable, in the format the app will keep it in. */
  const picture = async (width: number, height: number) =>
    new Uint8Array(
      await sharp({
        create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } },
      }).png().toBuffer(),
    );

  /** The picture as the browser would actually receive it. */
  const served = async (cookie: string, url: string) => {
    const response = await fetch(base + url, authed(cookie));
    expect(response.status).toBe(200);
    return await sharp(await response.arrayBuffer()).metadata();
  };

  test("a character's uploaded picture comes back scaled, in proportion", async () => {
    const { cookie } = await signIn();
    const { campaign } = await makeTable(cookie);

    const form = new FormData();
    form.set("campaignId", campaign.id);
    form.set("kind", "pc");
    form.set("name", unique("Hero"));
    form.set("sheet", hdcFile());
    form.set("card", new File([await picture(2400, 1800)], "huge.png"));

    const character = (await (
      await fetch(`${base}/api/characters`, authed(cookie, { method: "POST", body: form }))
    ).json()).character;

    const { width, height } = await served(cookie, character.cardUrl);
    expect(height).toBe(limits.storedImagePx);
    expect(width! / height!).toBeCloseTo(2400 / 1800, 2);
  });

  test("a campaign's picture is scaled the same way", async () => {
    const { cookie } = await signIn();

    const form = new FormData();
    form.set("name", unique("Campaign"));
    form.set("card", new File([await picture(3000, 3000)], "square.png"));

    const created = (await (
      await fetch(`${base}/api/campaigns`, authed(cookie, { method: "POST", body: form }))
    ).json()).campaign;

    const { width, height } = await served(cookie, created.cardUrl);
    expect([width, height]).toEqual([limits.storedImagePx, limits.storedImagePx]);
  });
});

/**
 * Runs `expr` in a process of its own with `overrides` applied.
 *
 * `config` reads the environment once, when it is imported, so a setting cannot
 * be tested by reassigning `process.env` here. `--env-file=/dev/null` because
 * Bun would otherwise load the developer's own `.env`, and a value set there
 * would answer for the case where nothing is set at all — quietly turning a
 * test of the default into a test of that file.
 */
const inProcessWith = async (
  overrides: Record<string, string | undefined>,
  expr: string,
): Promise<string> => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const proc = Bun.spawn(["bun", "--env-file=/dev/null", "-e", expr], {
    env,
    stdout: "pipe",
    stderr: "ignore",
  });
  return (await new Response(proc.stdout).text()).trim();
};

const sheenFor = async (value?: string): Promise<number> =>
  Number(
    await inProcessWith(
      { CARD_SHEEN_PCT: value },
      'import("./src/lib/config.ts").then((m) => console.log(m.config.cardSheenPct))',
    ),
  );

/** The stylesheet the route would serve, for a given font configuration. */
const appearanceWith = (url?: string, family?: string): Promise<string> =>
  inProcessWith(
    { CARD_FONT_URL: url, CARD_FONT_FAMILY: family },
    'import("./src/server/routes/appearance.ts").then(async (m) =>' +
      ' console.log(JSON.stringify(await m.appearanceRoutes["/appearance.css"]().text())))',
  ).then((out) => JSON.parse(out) as string);

describe("the deployment's card size reaches the browser", () => {
  test("as a stylesheet anyone can load, before the first paint", async () => {
    // No cookie: the document has to be able to lay itself out before anyone has
    // signed in, on the login screen.
    const response = await fetch(`${base}/appearance.css`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toStartWith("text/css");
    const css = await response.text();
    expect(css).toContain(`--sheet-size: ${config.sheetWidthPct}`);
    // A multiplier, so the stylesheet keeps the strengths the sheen was tuned at.
    expect(css).toContain(`--card-sheen-strength: ${config.cardSheenPct / 100}`);
    // The card frames' addresses ride along here because the bundler rewrites
    // every url() it can see in the stylesheet itself.
    expect(css).toContain(`--card-frame-pc: url("/frames/character-pc.webp")`);
    expect(css).toContain(`--card-frame-npc: url("/frames/character-npc.webp")`);
    expect(css).toContain(`--campaign-frame: url("/frames/campaign.webp")`);
    // And the foil, which lies over a picture rather than framing it.
    expect(css).toContain(`--card-foil: url("/frames/sheen.webp")`);
    // And the stock the back of a character's card is printed on.
    expect(css).toContain(`--card-back: url("/frames/back.webp")`);
  });

  test("and the frames themselves are served, cacheably, to anyone", async () => {
    for (const path of [
      "/frames/character-pc.webp",
      "/frames/character-npc.webp",
      "/frames/campaign.webp",
      "/frames/sheen.webp",
      "/frames/back.webp",
    ]) {
      // No cookie: a frame is the same for everyone and gives nothing away.
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/webp");

      const etag = response.headers.get("ETag")!;
      expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
      // WebP's magic bytes, so this is the file rather than an error page. WebP is
      // a RIFF container, so the marker is in two pieces: "RIFF" at 0, then the
      // file size, then "WEBP" at 8.
      const head = new Uint8Array(await response.arrayBuffer()).slice(0, 12);
      const ascii = String.fromCharCode(...head);
      expect(ascii.slice(0, 4)).toBe("RIFF");
      expect(ascii.slice(8, 12)).toBe("WEBP");

      // A browser that already holds it is told so rather than sent it again.
      const again = await fetch(`${base}${path}`, { headers: { "If-None-Match": etag } });
      expect(again.status).toBe(304);
    }
  });

  test("and the stored pictures cover the largest card anyone may ask for", () => {
    // Not twice the reader's own card, which is a per-game-master setting now:
    // one stored picture is looked at by readers who have chosen different
    // sizes, so it is sized for the biggest of them.
    expect(limits.storedImagePx).toBe(CARD_IMAGE_PX.max * 2);
  });


  test("and the sheen's strength is a setting, which zero turns off", async () => {
    expect(await sheenFor()).toBe(25);
    expect(await sheenFor("50")).toBe(50);
    // Zero is the point of the separate helper: `whole` would read it as unset
    // and hand back the default, leaving no way to switch the highlight off.
    expect(await sheenFor("0")).toBe(0);
    // Out of range is clamped, and nonsense falls back, as everywhere else here.
    expect(await sheenFor("900")).toBe(300);
    expect(await sheenFor("-10")).toBe(25);
    expect(await sheenFor("shiny")).toBe(25);
  });
});

describe("the deployment's font for card names", () => {
  const URL = "https://fonts.googleapis.com/css2?family=Rubik+Glitch&display=swap";

  test("is imported and named when both halves are given", async () => {
    const css = await appearanceWith(URL, "Rubik Glitch");
    // `@import` is only valid before every other rule, so it has to lead.
    expect(css.startsWith(`@import url("${URL}");`)).toBe(true);
    // Not `inherit`, which is invalid in a font list and would take the whole
    // declaration down with it, and not `var(--font-sans)`, which this build does
    // not define at run time — either way the name silently keeps the UI font.
    expect(css).toContain(`--card-font-family: "Rubik Glitch", sans-serif;`);
  });

  test("takes neither half on its own, since one without the other does nothing", async () => {
    for (const css of [
      await appearanceWith(undefined, undefined),
      await appearanceWith(URL, undefined),
      await appearanceWith(undefined, "Rubik Glitch"),
    ]) {
      expect(css).not.toContain("@import");
      expect(css).not.toContain("--card-font-family");
    }
  });

  test("refuses a URL the page's own CSP would block, rather than failing silently", async () => {
    for (const bad of [
      "http://fonts.googleapis.com/css2?family=Rubik+Glitch",
      "https://fonts.example.com/css2?family=Rubik+Glitch",
      "not a url at all",
    ]) {
      const css = await appearanceWith(bad, "Rubik Glitch");
      expect(css).not.toContain("@import");
      expect(css).not.toContain("--card-font-family");
    }
  });

  test("refuses a family that could break out of the declaration", async () => {
    // The value is written into a stylesheet every page loads, so a quote or a
    // brace in it would end the declaration and let the rest become CSS.
    for (const bad of ['Rubik";} body{display:none} .x{a:"', "Rubik;", "Rubik}"]) {
      const css = await appearanceWith(URL, bad);
      expect(css).not.toContain("--card-font-family");
      expect(css).not.toContain("display:none");
    }
  });

  test("and the page's CSP admits the hosts the font comes from", async () => {
    const html = await (await fetch(`${base}/`)).text();
    const csp = /content="([^"]*default-src[^"]*)"/.exec(html)?.[1] ?? "";
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("https://fonts.gstatic.com");
  });
});

describe("a character who is playing cannot be deleted", () => {
  const remove = (cookie: string, characterId: string) =>
    fetch(`${base}/api/characters/${characterId}`, authed(cookie, { method: "DELETE" }));

  const idsIn = async (cookie: string, campaignId: string) =>
    (await (await fetch(`${base}/api/characters?campaignId=${campaignId}`, authed(cookie))).json())
      .characters.map((character: { id: string }) => character.id);

  test("refused while they are on the stage of a running session", async () => {
    const { cookie } = await signIn();
    // `makeTable` leaves its campaign with an active session holding both characters.
    const playing = await makeTable(cookie);

    const response = await remove(cookie, playing.pc.id);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");

    // Refused outright: they are still in the library, and still on the stage.
    expect(await idsIn(cookie, playing.campaign.id)).toContain(playing.pc.id);
    const { snapshot } = await (
      await fetch(`${base}/api/sessions/${playing.session.id}`, authed(cookie))
    ).json();
    expect(
      snapshot.characters.map((character: { characterId: string }) => character.characterId),
    ).toContain(playing.pc.id);
  });

  test("allowed once they are taken off the stage", async () => {
    const { cookie } = await signIn();
    const playing = await makeTable(cookie);

    const { snapshot } = await (
      await fetch(`${base}/api/sessions/${playing.session.id}`, authed(cookie))
    ).json();
    const slot = snapshot.characters.find(
      (character: { characterId: string }) => character.characterId === playing.npc.id,
    );
    await fetch(
      `${base}/api/sessions/${playing.session.id}/stage/${slot.id}`,
      authed(cookie, { method: "DELETE" }),
    );

    expect((await remove(cookie, playing.npc.id)).status).toBe(204);
    expect(await idsIn(cookie, playing.campaign.id)).not.toContain(playing.npc.id);
  });

  test("allowed once the session has ended", async () => {
    const { cookie } = await signIn();
    const playing = await makeTable(cookie);
    await fetch(`${base}/api/sessions/${playing.session.id}/end`, authed(cookie, { method: "POST" }));

    // The rule is about sessions that are still running, not about ever having
    // played — an ended session is history and holds nothing back.
    expect((await remove(cookie, playing.pc.id)).status).toBe(204);
    expect(await idsIn(cookie, playing.campaign.id)).not.toContain(playing.pc.id);
  });

  test("a character who never went on stage is deletable while others play", async () => {
    const { cookie } = await signIn();
    const playing = await makeTable(cookie);

    // Filed under a campaign with a session in full swing, but not in it. The
    // rule is about being on the stage, not about the campaign being busy.
    const form = new FormData();
    form.set("campaignId", playing.campaign.id);
    form.set("kind", "npc");
    form.set("name", unique("Understudy"));
    form.set("sheet", hdcFile());
    const { character } = await (
      await fetch(`${base}/api/characters`, authed(cookie, { method: "POST", body: form }))
    ).json();

    expect((await remove(cookie, character.id)).status).toBe(204);
    expect(await idsIn(cookie, playing.campaign.id)).not.toContain(character.id);
  });
});

describe("a character is refiled by being moved to another campaign", () => {
  /** A campaign with nothing running on it, and one character filed under it. */
  async function bareCampaign(cookie: string, characterName?: string) {
    const campaignForm = new FormData();
    campaignForm.set("name", unique("Campaign"));
    const { campaign } = await (
      await fetch(`${base}/api/campaigns`, authed(cookie, { method: "POST", body: campaignForm }))
    ).json();

    const form = new FormData();
    form.set("campaignId", campaign.id);
    form.set("kind", "pc");
    form.set("name", characterName ?? unique("Hero"));
    form.set("sheet", hdcFile());
    const { character } = await (
      await fetch(`${base}/api/characters`, authed(cookie, { method: "POST", body: form }))
    ).json();

    return { campaign, character };
  }

  /** The move as the library sends it: the destination campaign and nothing else. */
  const move = (cookie: string, characterId: string, campaignId: string) => {
    const body = new FormData();
    body.set("campaignId", campaignId);
    return fetch(
      `${base}/api/characters/${characterId}`,
      authed(cookie, { method: "PATCH", body }),
    );
  };

  const namesIn = async (cookie: string, campaignId: string) =>
    (await (await fetch(`${base}/api/characters?campaignId=${campaignId}`, authed(cookie))).json())
      .characters.map((character: { name: string }) => character.name);

  test("the campaign alone is enough to move them", async () => {
    const { cookie } = await signIn();
    const from = await bareCampaign(cookie);
    const to = await bareCampaign(cookie);

    const response = await move(cookie, from.character.id, to.campaign.id);
    expect(response.status).toBe(200);
    expect((await response.json()).character.campaignId).toBe(to.campaign.id);

    expect(await namesIn(cookie, from.campaign.id)).not.toContain(from.character.name);
    expect(await namesIn(cookie, to.campaign.id)).toContain(from.character.name);
  });

  test("but not into a campaign that already has that name", async () => {
    const { cookie } = await signIn();
    const name = unique("Thorin");
    const from = await bareCampaign(cookie, name);
    const to = await bareCampaign(cookie, name);

    const response = await move(cookie, from.character.id, to.campaign.id);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");

    // Refused outright: the character has not gone anywhere.
    expect(await namesIn(cookie, from.campaign.id)).toEqual([name]);
    expect(await namesIn(cookie, to.campaign.id)).toEqual([name]);
  });

  test("and not out of a session that is still running", async () => {
    const { cookie } = await signIn();
    // `makeTable` leaves its campaign with an active session holding both characters.
    const playing = await makeTable(cookie);
    const elsewhere = await bareCampaign(cookie);

    const response = await move(cookie, playing.pc.id, elsewhere.campaign.id);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
    expect(await namesIn(cookie, elsewhere.campaign.id)).not.toContain(playing.pc.name);
  });

  test("though a rename still works while they are playing", async () => {
    const { cookie } = await signIn();
    const playing = await makeTable(cookie);

    const body = new FormData();
    const renamed = unique("Renamed");
    body.set("name", renamed);
    const response = await fetch(
      `${base}/api/characters/${playing.pc.id}`,
      authed(cookie, { method: "PATCH", body }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).character.name).toBe(renamed);
  });
});

describe("the upload limit covers a whole submission", () => {
  /**
   * A character file just over half the limit: two of these are over it, one is
   * not.
   *
   * Padded with a picture, because a character file is parsed before it is
   * stored and a megabyte of filler is not one. The picture's own bytes are
   * roughly a third of what they cost in the file — base64 in UTF-16 — which is
   * what the divisor is for; the assertions keep it honest if that ever changes.
   */
  function half(): Uint8Array {
    const target = Math.floor(limits.uploadBytes / 2) + 1024;
    const picture = new Uint8Array(Math.ceil(target / 2.7));
    picture.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bytes = hdcBytes({ image: picture });
    expect(bytes.byteLength).toBeGreaterThan(Math.floor(limits.uploadBytes / 2));
    expect(bytes.byteLength).toBeLessThan(limits.uploadBytes);
    return bytes;
  }

  test("a sheet and a picture together cannot exceed it", async () => {
    const { cookie } = await signIn();
    const campaignForm = new FormData();
    campaignForm.set("name", unique("Campaign"));
    const campaign = (
      await (
        await fetch(`${base}/api/campaigns`, authed(cookie, { method: "POST", body: campaignForm }))
      ).json()
    ).campaign;

    const picture = new Uint8Array(Math.floor(limits.uploadBytes / 2) + 1024);
    picture.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const form = new FormData();
    form.set("campaignId", campaign.id);
    form.set("kind", "npc");
    form.set("name", unique("Heavy"));
    form.set("sheet", new File([half() as BlobPart], "sheet.hdc"));
    form.set("card", new File([picture], "card.png", { type: "image/png" }));

    const response = await fetch(
      `${base}/api/characters`,
      authed(cookie, { method: "POST", body: form }),
    );

    // Each file is inside the per-file ceiling; together they are not, and the
    // app says so itself rather than leaving it to whatever sits in front.
    expect(response.status).toBe(413);
    expect((await response.json()).error.message).toMatch(/together/i);
  });

  test("either one alone still goes through", async () => {
    const { cookie } = await signIn();
    const campaignForm = new FormData();
    campaignForm.set("name", unique("Campaign"));
    const campaign = (
      await (
        await fetch(`${base}/api/campaigns`, authed(cookie, { method: "POST", body: campaignForm }))
      ).json()
    ).campaign;

    const form = new FormData();
    form.set("campaignId", campaign.id);
    form.set("kind", "npc");
    form.set("name", unique("Heavy"));
    form.set("sheet", new File([half() as BlobPart], "sheet.hdc"));

    const response = await fetch(
      `${base}/api/characters`,
      authed(cookie, { method: "POST", body: form }),
    );
    expect(response.status).toBe(201);
  });
});

describe("a game master's own settings", () => {
  const patch = (cookie: string | null, body: unknown) =>
    fetch(`${base}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });

  const meAs = async (cookie: string) =>
    await (await fetch(`${base}/api/auth/me`, authed(cookie))).json();

  test("a saved card size comes back with the identity", async () => {
    const { cookie } = await signIn();

    // The size a new account starts at is the one the deployment setting used to
    // hand everybody.
    expect((await meAs(cookie)).gm.cardImagePx).toBe(CARD_IMAGE_PX.default);

    const response = await patch(cookie, { cardImagePx: 320 });
    expect(response.status).toBe(200);
    expect((await response.json()).settings.cardImagePx).toBe(320);
    // Every setting comes back, not only the one that moved: the reply is the
    // identity's own shape.
    expect((await meAs(cookie)).gm.showAllNpcs).toBe(false);

    // And it is on the identity the console reads at boot, which is the whole
    // reason it rides along there rather than behind a GET of its own.
    expect((await meAs(cookie)).gm.cardImagePx).toBe(320);
  });

  test("one game master's size is not another's", async () => {
    const mine = await signIn();
    const theirs = await signIn();

    expect((await patch(mine.cookie, { cardImagePx: CARD_IMAGE_PX.max })).status).toBe(200);

    expect((await meAs(mine.cookie)).gm.cardImagePx).toBe(CARD_IMAGE_PX.max);
    expect((await meAs(theirs.cookie)).gm.cardImagePx).toBe(CARD_IMAGE_PX.default);
  });

  test("a size outside the slider's range is refused", async () => {
    const { cookie } = await signIn();

    for (const size of [CARD_IMAGE_PX.min - 1, CARD_IMAGE_PX.max + 1, 0, -40, 12.5, "big"]) {
      expect((await patch(cookie, { cardImagePx: size })).status).toBe(400);
    }

    // Refused means unchanged, not partly written.
    expect((await meAs(cookie)).gm.cardImagePx).toBe(CARD_IMAGE_PX.default);
  });

  test("the library's reach is remembered too", async () => {
    const { cookie } = await signIn();

    // Off for a new account, so a console that has always listed one campaign
    // goes on listing one campaign.
    expect((await meAs(cookie)).gm.showAllNpcs).toBe(false);

    const response = await patch(cookie, { showAllNpcs: true });
    expect(response.status).toBe(200);
    expect((await response.json()).settings.showAllNpcs).toBe(true);
    expect((await meAs(cookie)).gm.showAllNpcs).toBe(true);

    // And it goes back off, which a flag stored as SQLite's 0 or 1 is the easiest
    // thing in the world to get wrong in one direction only.
    expect((await patch(cookie, { showAllNpcs: false })).status).toBe(200);
    expect((await meAs(cookie)).gm.showAllNpcs).toBe(false);
  });

  test("anything but a flag is refused", async () => {
    const { cookie } = await signIn();
    for (const value of ["yes", 1, null]) {
      expect((await patch(cookie, { showAllNpcs: value })).status).toBe(400);
    }
    expect((await meAs(cookie)).gm.showAllNpcs).toBe(false);
  });

  test("an empty change is allowed and changes nothing", async () => {
    // Every field is optional, as on the vitals route: a panel that touches no
    // control sends no control, and that is not an error.
    const { cookie } = await signIn();
    expect((await patch(cookie, {})).status).toBe(200);
    expect((await meAs(cookie)).gm.cardImagePx).toBe(CARD_IMAGE_PX.default);
  });

  test("nobody but a game master may write them", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);
    const player = await joinAs(table.session.code, "Nim");

    expect((await patch(null, { cardImagePx: 320 })).status).toBe(401);
    // A player is signed in, but not as an account — there is no row of theirs
    // for a setting to live on.
    expect((await patch(player, { cardImagePx: 320 })).status).toBe(401);
  });
});

describe("a game master's export templates", () => {
  const list = async (cookie: string) =>
    await (await fetch(`${base}/api/templates`, authed(cookie))).json();

  const upload = (cookie: string | null, file: File) => {
    const form = new FormData();
    form.set("template", file);
    return fetch(`${base}/api/templates`, {
      method: "POST",
      headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: form,
    });
  };

  const remove = (cookie: string | null, id: string) =>
    fetch(`${base}/api/templates/${id}`, {
      method: "DELETE",
      headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    });

  const patch = (cookie: string, body: unknown) =>
    fetch(`${base}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify(body),
    });

  test("a new account has the built-in and nothing else", async () => {
    const { cookie } = await signIn();

    const { templates } = await list(cookie);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ id: BUILT_IN_TEMPLATE_ID, builtIn: true });

    // And it is what their sheets are drawn through, said in the identity so the
    // console has it before its first render.
    const me = await (await fetch(`${base}/api/auth/me`, authed(cookie))).json();
    expect(me.gm.templateId).toBe(BUILT_IN_TEMPLATE_ID);
  });

  test("an uploaded template joins the list and can be chosen", async () => {
    const { cookie } = await signIn();

    const created = await upload(cookie, hdeFile("mine.hde", { name: "Mine" }));
    expect(created.status).toBe(201);
    const { template, replaced } = await created.json();
    expect(replaced).toBe(false);
    expect(template.name).toBe("Mine");

    expect((await list(cookie)).templates).toHaveLength(2);

    const chosen = await patch(cookie, { templateId: template.id });
    expect(chosen.status).toBe(200);
    expect((await chosen.json()).settings.templateId).toBe(template.id);

    // And back again, which is the only way to say "the one this app ships".
    const back = await patch(cookie, { templateId: BUILT_IN_TEMPLATE_ID });
    expect((await back.json()).settings.templateId).toBe(BUILT_IN_TEMPLATE_ID);
  });

  test("the same name again updates the one they have", async () => {
    const { cookie } = await signIn();
    const first = await (await upload(cookie, hdeFile("v1.hde", { name: "Mine" }))).json();

    const again = await upload(cookie, hdeFile("v2.hde", { name: "Mine" }));

    // 200 rather than 201: the same template, exported again, and saying
    // "created" about it would be untrue.
    expect(again.status).toBe(200);
    const { template, replaced } = await again.json();
    expect(replaced).toBe(true);
    expect(template.id).toBe(first.template.id);
    expect((await list(cookie)).templates).toHaveLength(2);
  });

  test("a file that is not a template is refused", async () => {
    const { cookie } = await signIn();

    const response = await upload(cookie, new File([hdeSource()], "notes.txt"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/\.hde/);
    expect((await list(cookie)).templates).toHaveLength(1);
  });

  test("the one in use cannot be deleted, and the built-in never can", async () => {
    const { cookie } = await signIn();
    const { template } = await (await upload(cookie, hdeFile("mine.hde"))).json();
    await patch(cookie, { templateId: template.id });

    const refused = await remove(cookie, template.id);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toMatch(/Choose another one first/);

    expect((await remove(cookie, BUILT_IN_TEMPLATE_ID)).status).toBe(409);

    // Switching away is what makes it deletable, which is the one press the
    // message asks for.
    await patch(cookie, { templateId: BUILT_IN_TEMPLATE_ID });
    expect((await remove(cookie, template.id)).status).toBe(204);
    expect((await list(cookie)).templates).toHaveLength(1);
  });

  test("one game master's collection is not another's", async () => {
    const mine = await signIn();
    const stranger = await signIn();
    const { template } = await (await upload(mine.cookie, hdeFile("mine.hde"))).json();

    // Not in their list, not theirs to choose, and not theirs to delete — and
    // all three said as "not found", so an id reveals nothing about what exists.
    expect((await list(stranger.cookie)).templates).toHaveLength(1);
    expect((await patch(stranger.cookie, { templateId: template.id })).status).toBe(404);
    expect((await remove(stranger.cookie, template.id)).status).toBe(404);

    // And nothing of theirs changed while they tried.
    const me = await (await fetch(`${base}/api/auth/me`, authed(stranger.cookie))).json();
    expect(me.gm.templateId).toBe(BUILT_IN_TEMPLATE_ID);
  });

  test("a template that does not exist is not found", async () => {
    const { cookie } = await signIn();
    expect((await patch(cookie, { templateId: "no-such-template" })).status).toBe(404);
    expect((await remove(cookie, "no-such-template")).status).toBe(404);
  });

  test("none of it is reachable without signing in as a game master", async () => {
    const { cookie } = await signIn();
    const { template } = await (await upload(cookie, hdeFile("mine.hde"))).json();

    expect((await fetch(`${base}/api/templates`)).status).toBe(401);
    expect((await upload(null, hdeFile("theirs.hde"))).status).toBe(401);
    expect((await remove(null, template.id)).status).toBe(401);
  });
});

describe("a monster from another campaign", () => {
  /** One character in a campaign of its own, belonging to `cookie`'s game master. */
  const characterElsewhere = async (cookie: string, kind: "pc" | "npc") => {
    const campaignForm = new FormData();
    campaignForm.set("name", unique("Elsewhere"));
    const campaign = (
      await (
        await fetch(`${base}/api/campaigns`, authed(cookie, { method: "POST", body: campaignForm }))
      ).json()
    ).campaign;

    const form = new FormData();
    form.set("campaignId", campaign.id);
    form.set("kind", kind);
    form.set("name", unique(kind));
    form.set("sheet", hdcFile());
    return (
      await (await fetch(`${base}/api/characters`, authed(cookie, { method: "POST", body: form })))
        .json()
    ).character;
  };

  const meAs = async (cookie: string) =>
    await (await fetch(`${base}/api/auth/me`, authed(cookie))).json();

  const stage = (cookie: string, sessionId: string, characterId: string) =>
    fetch(
      `${base}/api/sessions/${sessionId}/stage`,
      authed(cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId }),
      }),
    );

  test("can be brought into this one's fight", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);
    const ogre = await characterElsewhere(cookie, "npc");

    // The half of `Show All NPCs` the server has to agree to: a good ogre filed
    // under last year's campaign is still a good ogre.
    const response = await stage(cookie, table.session.id, ogre.id);
    expect(response.status).toBe(200);

    const staged = (await response.json()).snapshot.characters;
    expect(staged.some((character: { characterId: string }) => character.characterId === ogre.id))
      .toBe(true);
  });

  test("pins the setting on while it is standing there", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);
    const ogre = await characterElsewhere(cookie, "npc");

    const setting = (on: boolean) =>
      fetch(`${base}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
        body: JSON.stringify({ showAllNpcs: on }),
      });

    expect((await setting(true)).status).toBe(200);
    expect((await stage(cookie, table.session.id, ogre.id)).status).toBe(200);

    // Switching it off is what takes the ogre out of the library it is standing
    // on stage from, so the setting will not go off while it is there.
    const refused = await setting(false);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toMatch(/take it off the stage/i);
    expect((await meAs(cookie)).gm.showAllNpcs).toBe(true);

    // Switching it on again is never refused: only the way back out is closed.
    expect((await setting(true)).status).toBe(200);

    // Off the stage, and the setting is a setting again.
    const slot = (await (await fetch(
      `${base}/api/sessions/${table.session.id}`,
      authed(cookie),
    )).json()).snapshot.characters.find(
      (character: { characterId: string }) => character.characterId === ogre.id,
    );
    expect(
      (await fetch(
        `${base}/api/sessions/${table.session.id}/stage/${slot.id}`,
        authed(cookie, { method: "DELETE" }),
      )).status,
    ).toBe(200);

    expect((await setting(false)).status).toBe(200);
    expect((await meAs(cookie)).gm.showAllNpcs).toBe(false);
  });

  test("but a hero from another campaign cannot", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);
    const hero = await characterElsewhere(cookie, "pc");

    // A player character belongs to a player in a campaign, and the claim they
    // hold is on that. Borrowing one is not a thing the setting offers, and the
    // server does not take it either.
    expect((await stage(cookie, table.session.id, hero.id)).status).toBe(404);
  });

  test("and never another game master's, whatever kind it is", async () => {
    const mine = await signIn();
    const theirs = await signIn();
    const table = await makeTable(mine.cookie);

    for (const kind of ["npc", "pc"] as const) {
      const stranger = await characterElsewhere(theirs.cookie, kind);
      // "Not found" rather than "not yours": one library must not be probed
      // through another's console.
      expect((await stage(mine.cookie, table.session.id, stranger.id)).status).toBe(404);
    }
  });
});

describe.skipIf(!rulesAvailable)("a character file that knows its own characteristics", () => {
  /**
   * A character file with the levels that give the numbers below.
   *
   * A file stores levels *bought*, not the value a sheet prints: the game
   * system's base is added to them, and some of it is figured from other
   * characteristics — SPD's base is one plus a tenth of DEX, so these numbers are
   * only what they are together.
   */
  const character = (options: { speed?: number; reflexes?: number } = {}) =>
    hdcFile("Hero.hdc", {
      characteristics: {
        DEX: 13,
        CON: 0,
        BODY: 2,
        SPD: options.speed ?? 2,
        REC: 4,
        END: 10,
        STUN: 11,
      },
      ...(options.reflexes === undefined ? {} : { lightningReflexes: options.reflexes }),
    });

  /** Files a character the way a dropped folder of them does: no stat fields. */
  const drop = async (cookie: string, campaignId: string, file: File) => {
    const form = new FormData();
    form.set("campaignId", campaignId);
    form.set("kind", "npc");
    form.set("name", unique("Dropped"));
    form.set("sheet", file);
    const response = await fetch(
      `${base}/api/characters`,
      authed(cookie, { method: "POST", body: form }),
    );
    expect(response.status).toBe(201);
    return (await response.json()).character;
  };

  test("fills in a character that arrived with no numbers at all", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);

    // A folder of character files dropped on a campaign sends a name and a file.
    // These characters were filed at zero across the board before the file was
    // read.
    const filed = await drop(cookie, table.campaign.id, character({ reflexes: 4 }));

    expect(filed).toMatchObject({
      dexterity: 23,
      constitution: 10,
      body: 12,
      speed: 5,
      recovery: 8,
      endurance: 30,
      stun: 33,
      initiative: 4,
    });
  });

  test("reads no initiative bonus where the character has no such talent", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);

    // Not a gap: a character without Lightning Reflexes has a bonus of zero, and
    // that is an answer the file gives.
    expect((await drop(cookie, table.campaign.id, character())).initiative).toBe(0);
  });

  test("but never over a number the form actually sent", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);

    const form = new FormData();
    form.set("campaignId", table.campaign.id);
    form.set("kind", "npc");
    form.set("name", unique("Typed"));
    form.set("sheet", character());
    // The dialog sends all eight, having asked the server about the file as it
    // was chosen. What arrives is what the game master saw and could have
    // corrected.
    form.set("speed", "2");
    form.set("dexterity", "11");

    const created = (await (await fetch(
      `${base}/api/characters`,
      authed(cookie, { method: "POST", body: form }),
    )).json()).character;

    expect(created).toMatchObject({ speed: 2, dexterity: 11 });
    // And the ones it did not send still come off the file.
    expect(created).toMatchObject({ constitution: 10, recovery: 8, endurance: 30, stun: 33 });
  });

  test("a file that is not a character file is refused outright", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);

    // Where an HTML sheet this app could not read was filed anyway and left the
    // character at zero, a character file is read before it is kept — so this is
    // said at the upload rather than discovered when someone opens the sheet.
    const form = new FormData();
    form.set("campaignId", table.campaign.id);
    form.set("kind", "npc");
    form.set("name", unique("Bogus"));
    form.set("sheet", new File(["<html>not a character</html>"], "hero.hdc"));
    const response = await fetch(
      `${base}/api/characters`,
      authed(cookie, { method: "POST", body: form }),
    );

    expect(response.status).toBe(400);
  });

  test("a characteristic outside what this app can store is dropped, not fatal", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);

    // SPD runs 0 to 12 here. A file claiming 42 must not put a character on the
    // stage that no form could have produced — nor refuse the upload over a
    // characteristic this table may never look at.
    const filed = await drop(cookie, table.campaign.id, character({ speed: 40 }));

    expect(filed.speed).toBe(0);
    expect(filed.dexterity).toBe(23);
  });
});

describe.skipIf(!rulesAvailable)("a character file dropped over a character that already exists", () => {
  /** A believable PNG: real magic bytes, padded past what a scan calls furniture. */
  const picture = () => {
    const bytes = new Uint8Array(4096);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (let i = 8; i < bytes.length; i += 1) bytes[i] = (i * 7) % 251;
    return bytes;
  };

  /** DEX levels of 4 print as 14 and 11 as 21; SPD and REC come with them. */
  const character = (options: { dex: number; portrait?: boolean }) =>
    hdcFile("Hero.hdc", {
      characteristics: { DEX: options.dex, SPD: 3, REC: 5 },
      ...(options.portrait ? { image: picture() } : {}),
    });

  /** The update a drop sends: the file, and nothing else but the portrait rule. */
  const redrop = async (cookie: string, characterId: string, file: File) => {
    const form = new FormData();
    form.set("sheet", file);
    form.set("portraitFromSheet", "true");
    const response = await fetch(
      `${base}/api/characters/${characterId}`,
      authed(cookie, { method: "PATCH", body: form }),
    );
    expect(response.status).toBe(200);
    return (await response.json()).character;
  };

  const create = async (cookie: string, campaignId: string, file: File) => {
    const form = new FormData();
    form.set("campaignId", campaignId);
    form.set("kind", "npc");
    form.set("name", unique("Rewritten"));
    form.set("sheet", file);
    const response = await fetch(
      `${base}/api/characters`,
      authed(cookie, { method: "POST", body: form }),
    );
    expect(response.status).toBe(201);
    return (await response.json()).character;
  };

  test("brings the characteristics with it", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);

    const filed = await create(cookie, table.campaign.id, character({ dex: 4 }));
    expect(filed.dexterity).toBe(14);

    // Without this the file would be replaced and the numbers left as they were —
    // stale against the very file dropped to update them.
    const updated = await redrop(cookie, filed.id, character({ dex: 11 }));
    expect(updated).toMatchObject({ dexterity: 21, speed: 6, recovery: 9 });
    expect(updated.sheetUrl).toBe(filed.sheetUrl);
  });

  test("but a form that sends a number still outranks the file", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);
    const filed = await create(cookie, table.campaign.id, character({ dex: 4 }));

    // The edit dialog sends all eight boxes, having asked the server about the
    // file already, so what arrives is what the game master saw.
    const form = new FormData();
    form.set("sheet", character({ dex: 11 }));
    form.set("dexterity", "3");
    const updated = (await (await fetch(
      `${base}/api/characters/${filed.id}`,
      authed(cookie, { method: "PATCH", body: form }),
    )).json()).character;

    expect(updated.dexterity).toBe(3);
    // And the ones it did not send still come off the file.
    expect(updated.speed).toBe(6);
  });

  test("and its portrait replaces the picture that was there", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);

    const filed = await create(cookie, table.campaign.id, character({ dex: 4, portrait: true }));
    expect(filed.cardUrl).not.toBeNull();

    const updated = await redrop(cookie, filed.id, character({ dex: 4, portrait: true }));
    expect(updated.cardUrl).not.toBeNull();
    expect(updated.cardUrl).not.toBe(filed.cardUrl);
  });

  test("where the edit dialog leaves a chosen picture alone", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);
    const filed = await create(cookie, table.campaign.id, character({ dex: 4, portrait: true }));

    // The same upload without the flag, which is what the dialog sends: a picture
    // the game master chose is not for a file to overrule.
    const form = new FormData();
    form.set("sheet", character({ dex: 4, portrait: true }));
    const updated = (await (await fetch(
      `${base}/api/characters/${filed.id}`,
      authed(cookie, { method: "PATCH", body: form }),
    )).json()).character;

    expect(updated.cardUrl).toBe(filed.cardUrl);
  });

  test("and a portrait the browser sent alongside is not a picture the game master chose", async () => {
    const { cookie } = await signIn();
    const table = await makeTable(cookie);
    const filed = await create(cookie, table.campaign.id, character({ dex: 4, portrait: true }));
    expect(filed.cardUrl).not.toBeNull();

    // The browser splits the picture out before uploading, so it arrives as its
    // own part. Sent as `card` it would mean "the game master picked this" and
    // would overrule the picture already there; as `sheetPortrait` it means what
    // it is, and the existing card stands.
    const form = new FormData();
    form.set("sheet", character({ dex: 4 }));
    form.set("sheetPortrait", new File([picture() as BlobPart], "portrait.png"));
    const updated = (await (await fetch(
      `${base}/api/characters/${filed.id}`,
      authed(cookie, { method: "PATCH", body: form }),
    )).json()).character;

    expect(updated.cardUrl).toBe(filed.cardUrl);
    // And it is taken when there is nothing to lose.
    const bare = await create(cookie, table.campaign.id, character({ dex: 4 }));
    expect(bare.cardUrl).toBeNull();
    const second = new FormData();
    second.set("sheet", character({ dex: 4 }));
    second.set("sheetPortrait", new File([picture() as BlobPart], "portrait.png"));
    const gained = (await (await fetch(
      `${base}/api/characters/${bare.id}`,
      authed(cookie, { method: "PATCH", body: second }),
    )).json()).character;
    expect(gained.cardUrl).not.toBeNull();
  });
});
