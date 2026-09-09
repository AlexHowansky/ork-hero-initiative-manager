/**
 * The stage's order and the turn tracker.
 *
 * These are the invariants the segment panel and the turn buttons depend on: the
 * order follows DEX+INIT rather than the order characters arrived, stored
 * positions stay dense so the tiebreak stays meaningful, and stepping through the
 * HERO clock walks the segments a SPD actually gives someone.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { gameSessions, players, sessionCharacters, sessionEvents } from "../src/db/queries.ts";
import { becameUnstunned, segmentBegan } from "../src/server/events.ts";
import { advanceTurn } from "../src/server/routes/sessions.ts";
import {
  copiesOf,
  makeCharacter,
  makePlayer,
  makeSession,
  orderOf,
  positionsOf,
  slotsOf,
} from "./helpers.ts";

describe("the stage", () => {
  // The fixture leaves every characteristic at zero, so DEX+INIT ties across the
  // whole stage and `position` — the order they arrived — is what shows through.
  test("characters are appended in the order they are added", () => {
    const { session, characters } = makeSession(3);
    expect(orderOf(session.id)).toEqual(characters.map((c) => c.name));
    expect(positionsOf(session.id)).toEqual([0, 1, 2]);
  });

  test("an NPC can be brought on more than once", () => {
    const { session, campaign } = makeSession(1);
    const goblin = makeCharacter(campaign.id, "npc", "Goblin");

    sessionCharacters.add(session.id, goblin.id, "npc");
    sessionCharacters.add(session.id, goblin.id, "npc");
    sessionCharacters.add(session.id, goblin.id, "npc");

    expect(orderOf(session.id).filter((name) => name === "Goblin")).toHaveLength(3);
    expect(positionsOf(session.id)).toEqual([0, 1, 2, 3]);
    // Each copy is a slot of its own, which is what gives it its own turn.
    expect(new Set(slotsOf(session.id)).size).toBe(4);
  });

  test("copies are numbered in the order they arrive", () => {
    const { session, campaign } = makeSession(0);
    const goblin = makeCharacter(campaign.id, "npc", "Goblin");
    for (let i = 0; i < 3; i += 1) sessionCharacters.add(session.id, goblin.id, "npc");

    expect(copiesOf(session.id)).toEqual([1, 2, 3]);
  });

  test("a copy keeps its number when another is taken off", () => {
    const { session, campaign } = makeSession(0);
    const goblin = makeCharacter(campaign.id, "npc", "Goblin");
    for (let i = 0; i < 3; i += 1) sessionCharacters.add(session.id, goblin.id, "npc");

    // Goblin 2 leaves; the other two are still Goblin 1 and Goblin 3, because a
    // number is a name for the whole fight rather than a place in the list.
    sessionCharacters.remove(session.id, slotsOf(session.id)[1]!);
    expect(copiesOf(session.id)).toEqual([1, 3]);

    // And the next one along is 4, not the 2 that just came free.
    sessionCharacters.add(session.id, goblin.id, "npc");
    expect(copiesOf(session.id)).toEqual([1, 3, 4]);
  });

  test("a player character is only ever on the stage once", () => {
    const { session, characters } = makeSession(2);
    const pc = characters.find((character) => character.kind === "pc")!;

    sessionCharacters.add(session.id, pc.id, "pc");

    expect(orderOf(session.id)).toHaveLength(2);
    expect(positionsOf(session.id)).toEqual([0, 1]);
  });

  test("removing from the middle closes the gap", () => {
    const { session, characters } = makeSession(4);
    sessionCharacters.remove(session.id, slotsOf(session.id)[1]!);

    expect(positionsOf(session.id)).toEqual([0, 1, 2]);
    expect(orderOf(session.id)).toEqual([
      characters[0]!.name,
      characters[2]!.name,
      characters[3]!.name,
    ]);
  });

  test("a character added after a removal lands at the end", () => {
    const { session, campaign } = makeSession(3);
    sessionCharacters.remove(session.id, slotsOf(session.id)[0]!);
    const late = makeCharacter(campaign.id, "npc");
    sessionCharacters.add(session.id, late.id, "npc");

    expect(positionsOf(session.id)).toEqual([0, 1, 2]);
    expect(orderOf(session.id).at(-1)).toBe(late.name);
  });

  test("removing a character releases the player holding it", () => {
    const { session, characters } = makeSession(2);
    const player = makePlayer(session.id);
    players.setClaim(player.id, characters[0]!.id);

    sessionCharacters.remove(session.id, slotsOf(session.id)[0]!);

    expect(players.byId(player.id)!.claimed_character_id).toBeNull();
  });

  test("removing the character whose turn it is clears the turn", () => {
    const { session } = makeSession(3);
    const slots = slotsOf(session.id);
    gameSessions.setTurn(session.id, slots[1]!, 1, 12);

    sessionCharacters.remove(session.id, slots[1]!);

    expect(gameSessions.byId(session.id)!.active_slot_id).toBeNull();
  });

  test("removing a different character leaves the turn alone", () => {
    const { session } = makeSession(3);
    const slots = slotsOf(session.id);
    gameSessions.setTurn(session.id, slots[0]!, 1, 12);

    sessionCharacters.remove(session.id, slots[2]!);

    expect(gameSessions.byId(session.id)!.active_slot_id).toBe(slots[0]!);
  });

  test("one copy leaving does not take its twin's turn with it", () => {
    const { session, campaign } = makeSession(0);
    const goblin = makeCharacter(campaign.id, "npc", "Goblin");
    sessionCharacters.add(session.id, goblin.id, "npc");
    sessionCharacters.add(session.id, goblin.id, "npc");

    const [first, second] = slotsOf(session.id);
    gameSessions.setTurn(session.id, second!, 1, 12);

    sessionCharacters.remove(session.id, first!);

    // Same character, different slot: the marker stays where it was.
    expect(gameSessions.byId(session.id)!.active_slot_id).toBe(second!);
    expect(orderOf(session.id)).toEqual(["Goblin"]);
  });
});

describe("the order on the stage", () => {
  test("DEX plus INIT decides it, not the order characters arrived", () => {
    const { session, campaign } = makeSession(0);
    const slow = makeCharacter(campaign.id, "pc", "Slow", { dexterity: 10 });
    const quick = makeCharacter(campaign.id, "pc", "Quick", { dexterity: 30 });
    const middling = makeCharacter(campaign.id, "pc", "Middling", { dexterity: 20 });
    for (const character of [slow, quick, middling]) {
      sessionCharacters.add(session.id, character.id, "pc");
    }

    expect(orderOf(session.id)).toEqual(["Quick", "Middling", "Slow"]);
  });

  test("the INIT bonus counts towards it", () => {
    const { session, campaign } = makeSession(0);
    // Lower DEX, but Combat Reflexes and the like put them first anyway.
    const reflexes = makeCharacter(campaign.id, "pc", "Reflexes", {
      dexterity: 18,
      initiative: 5,
    });
    const plain = makeCharacter(campaign.id, "pc", "Plain", { dexterity: 20 });
    for (const character of [plain, reflexes]) {
      sessionCharacters.add(session.id, character.id, "pc");
    }

    expect(orderOf(session.id)).toEqual(["Reflexes", "Plain"]);
  });

  test("a tie is broken by the order they came on stage", () => {
    const { session, campaign } = makeSession(0);
    const first = makeCharacter(campaign.id, "npc", "First", { dexterity: 15 });
    const second = makeCharacter(campaign.id, "npc", "Second", { dexterity: 15 });
    sessionCharacters.add(session.id, first.id, "npc");
    sessionCharacters.add(session.id, second.id, "npc");

    expect(orderOf(session.id)).toEqual(["First", "Second"]);
  });

  test("a character arriving mid-fight lands in its place, not at the end", () => {
    const { session, campaign } = makeSession(0);
    for (const dex of [30, 10]) {
      const character = makeCharacter(campaign.id, "npc", `Dex ${dex}`, { dexterity: dex });
      sessionCharacters.add(session.id, character.id, "npc");
    }

    const late = makeCharacter(campaign.id, "npc", "Dex 20", { dexterity: 20 });
    sessionCharacters.add(session.id, late.id, "npc");

    expect(orderOf(session.id)).toEqual(["Dex 30", "Dex 20", "Dex 10"]);
  });
});

describe("advancing the turn", () => {
  /**
   * A stage with one of each interesting SPD, and DEX chosen so the order within
   * a segment is not the order they were added:
   *
   *   Sleeper  SPD 0   DEX 40   no phases at all
   *   Ace      SPD 4   DEX 30   segments 3, 6, 9, 12
   *   Swift    SPD 12  DEX 20   every segment
   *   Slow     SPD 2   DEX 10   segments 6 and 12
   */
  let sessionId: string;

  const clock = () => {
    const session = gameSessions.byId(sessionId)!;
    return {
      turn: session.turn,
      segment: session.segment,
      on: sessionCharacters
        .list(sessionId)
        .find((row) => row.slot_id === session.active_slot_id)?.name ?? null,
    };
  };

  beforeEach(() => {
    const { session, campaign } = makeSession(0);
    sessionId = session.id;
    const cast: [string, number, number][] = [
      ["Sleeper", 0, 40],
      ["Ace", 4, 30],
      ["Swift", 12, 20],
      ["Slow", 2, 10],
    ];
    for (const [name, speed, dexterity] of cast) {
      const character = makeCharacter(campaign.id, "npc", name, { speed, dexterity });
      sessionCharacters.add(sessionId, character.id, "npc");
    }
  });

  const next = () => advanceTurn(sessionId, "next");
  const prev = () => advanceTurn(sessionId, "prev");

  test("a fresh session sits at turn 1, segment 12, with nobody on turn", () => {
    expect(clock()).toEqual({ turn: 1, segment: 12, on: null });
  });

  test("the fight opens on segment 12 of turn 1, in DEX order", () => {
    next();
    expect(clock()).toEqual({ turn: 1, segment: 12, on: "Ace" });
    next();
    expect(clock()).toEqual({ turn: 1, segment: 12, on: "Swift" });
    next();
    expect(clock()).toEqual({ turn: 1, segment: 12, on: "Slow" });
  });

  describe("and a held action taken out of order", () => {
    /**
     * What the hold route leaves behind: the holder on turn, and the place the
     * order had reached kept as the resume point. The route itself, and who may
     * press the button, are covered in `http.test.ts`; this is the half of it
     * the clock does.
     */
    const takeHeldAction = (name: string) => {
      const session = gameSessions.byId(sessionId)!;
      // Whose turn it is, kept so the clock can hand it back after the cut-in.
      const holder = sessionCharacters.list(sessionId).find((row) => row.name === name)!;
      gameSessions.setResume(sessionId, session.active_slot_id);
      gameSessions.setTurn(sessionId, holder.slot_id, session.turn, session.segment);
    };

    test("the next step hands the turn back to whoever was interrupted", () => {
      // Segment 12: Ace, then Swift, then Slow.
      next();
      expect(clock()).toEqual({ turn: 1, segment: 12, on: "Ace" });

      // Slow was waiting, and cuts into Ace's phase.
      takeHeldAction("Slow");
      expect(clock()).toEqual({ turn: 1, segment: 12, on: "Slow" });

      // Back to Ace, whose phase the interjection came out of rather than
      // finished, and only then on down the order.
      next();
      expect(clock()).toEqual({ turn: 1, segment: 12, on: "Ace" });
      next();
      expect(clock()).toEqual({ turn: 1, segment: 12, on: "Swift" });
    });

    test("the phase to return to is spent by the step that uses it", () => {
      next();
      takeHeldAction("Slow");
      next();

      expect(gameSessions.byId(sessionId)!.resume_slot_id).toBeNull();
      // And the step after it is an ordinary one, walking on from Ace.
      next();
      expect(clock()).toEqual({ turn: 1, segment: 12, on: "Swift" });
    });

    test("stepping back out of an interjection returns to it too", () => {
      next();
      next();
      expect(clock()).toEqual({ turn: 1, segment: 12, on: "Swift" });

      takeHeldAction("Ace");
      prev();

      // The marker was standing on Ace rather than anywhere in the order, so
      // there is nowhere to walk backwards to but the phase they cut into.
      expect(clock()).toEqual({ turn: 1, segment: 12, on: "Swift" });
      expect(gameSessions.byId(sessionId)!.resume_slot_id).toBeNull();
    });

    test("a holder cutting in with nobody on turn leaves nothing to resume from", () => {
      // Straight off a Restart: no marker, so there is no place to go back to,
      // and the fight simply starts from the holder and walks on normally.
      const ace = sessionCharacters.list(sessionId).find((row) => row.name === "Ace")!;
      gameSessions.setTurn(sessionId, ace.slot_id, 1, 12);

      expect(gameSessions.byId(sessionId)!.resume_slot_id).toBeNull();
      next();
      expect(clock()).toEqual({ turn: 1, segment: 12, on: "Swift" });
    });
  });

  test("segment 1 is where the turn counter goes up", () => {
    for (let i = 0; i < 3; i += 1) next();
    expect(clock()).toEqual({ turn: 1, segment: 12, on: "Slow" });

    // Off the end of segment 12 and round to segment 1, which belongs to turn 2.
    next();
    expect(clock()).toEqual({ turn: 2, segment: 1, on: "Swift" });
  });

  test("a new segment is written to the log, and a step inside one is not", () => {
    const log = () => sessionEvents.list(sessionId).map((event) => event.message);

    // The first press opens the fight in the segment the clock already sat in,
    // and the two after it walk Ace, Swift and Slow through that one segment.
    // The marker moves and the clock does not, so the log says nothing — the
    // opening segment was announced where the fight was put there, which for a
    // real session is the transaction that created it and for this fixture is
    // nowhere at all.
    for (let i = 0; i < 3; i += 1) next();
    expect(log()).toEqual([]);

    // This one crosses into segment 1 — a new segment, and a new turn with it.
    next();
    expect(log()).toEqual([segmentBegan(2, 1)]);

    // Every segment the walk lands in gets a line, including the ones it reaches
    // by stepping over the empty ones between.
    next();
    next();
    expect(log()).toEqual([segmentBegan(2, 1), segmentBegan(2, 2), segmentBegan(2, 3)]);

    // Stepping back is the clock arriving somewhere too: `Previous` is how a
    // game master corrects a click, and the log should show where the fight
    // actually went rather than only where it went forwards.
    prev();
    expect(log()).toEqual([
      segmentBegan(2, 1),
      segmentBegan(2, 2),
      segmentBegan(2, 3),
      segmentBegan(2, 2),
    ]);
  });

  test("a marker cleared mid-fight does not announce the segment twice", () => {
    const log = () => sessionEvents.list(sessionId).map((event) => event.message);

    // Into segment 3 of turn 2, then the character who is up walks off the
    // stage, which is what clears the marker.
    for (let i = 0; i < 6; i += 1) next();
    const on = gameSessions.byId(sessionId)!.active_slot_id!;
    sessionCharacters.remove(sessionId, on);
    expect(gameSessions.byId(sessionId)!.active_slot_id).toBe(null);
    const before = log();

    // The next press picks the segment up where it was. The clock never left it,
    // and it was announced on the way in, so it is not announced again.
    next();
    expect(gameSessions.byId(sessionId)!.segment).toBe(3);
    expect(log()).toEqual(before);
  });

  test("only the characters whose SPD gives them a phase come up", () => {
    // Segments 1 and 2 are the SPD 12 character's alone; Ace joins at 3.
    for (let i = 0; i < 4; i += 1) next();
    expect(clock()).toEqual({ turn: 2, segment: 1, on: "Swift" });
    next();
    expect(clock()).toEqual({ turn: 2, segment: 2, on: "Swift" });
    next();
    expect(clock()).toEqual({ turn: 2, segment: 3, on: "Ace" });
    next();
    expect(clock()).toEqual({ turn: 2, segment: 3, on: "Swift" });
  });

  test("a SPD of nought never comes up", () => {
    // Two whole turns of the clock: the highest DEX on the stage never acts.
    const seen = new Set<string | null>();
    for (let i = 0; i < 40; i += 1) {
      next();
      seen.add(clock().on);
    }
    expect(seen.has("Sleeper")).toBe(false);
    expect(seen).toContain("Swift");
  });

  test("segments nobody acts in are stepped straight over", () => {
    const { session, campaign } = makeSession(0);
    // SPD 2 acts in segments 6 and 12 and nowhere else.
    const plodder = makeCharacter(campaign.id, "npc", "Plodder", { speed: 2, dexterity: 10 });
    sessionCharacters.add(session.id, plodder.id, "npc");

    advanceTurn(session.id, "next");
    expect(gameSessions.byId(session.id)!.segment).toBe(12);
    advanceTurn(session.id, "next");
    // Straight from 12 to 6, not through five empty segments one press at a time.
    expect(gameSessions.byId(session.id)!.segment).toBe(6);
    expect(gameSessions.byId(session.id)!.turn).toBe(2);
  });

  test("stepping back retraces the same path", () => {
    const forward = [];
    for (let i = 0; i < 8; i += 1) {
      next();
      forward.push(clock());
    }

    for (let i = forward.length - 1; i > 0; i -= 1) {
      prev();
      expect(clock()).toEqual(forward[i - 1]!);
    }
  });

  test("stepping back off the first phase puts the fight back to unstarted", () => {
    next();
    expect(clock()).toEqual({ turn: 1, segment: 12, on: "Ace" });

    prev();
    expect(clock()).toEqual({ turn: 1, segment: 12, on: null });
  });

  test("there is nothing before the start of the fight", () => {
    for (let i = 0; i < 5; i += 1) prev();
    expect(clock()).toEqual({ turn: 1, segment: 12, on: null });
  });

  test("every copy of an NPC gets its own phase", () => {
    const { session, campaign } = makeSession(0);
    const goblin = makeCharacter(campaign.id, "npc", "Goblin", { speed: 2, dexterity: 10 });
    for (let i = 0; i < 3; i += 1) sessionCharacters.add(session.id, goblin.id, "npc");

    const slots = slotsOf(session.id);
    const visited: (string | null)[] = [];
    for (let i = 0; i < 3; i += 1) {
      advanceTurn(session.id, "next");
      visited.push(gameSessions.byId(session.id)!.active_slot_id);
    }

    // Three goblins, three phases in segment 12. Matching on the character rather
    // than the slot would find the first one every time and the other two would
    // never act.
    expect(visited).toEqual(slots);
    expect(gameSessions.byId(session.id)!.turn).toBe(1);

    // And the fourth press moves the clock on rather than round.
    advanceTurn(session.id, "next");
    expect(gameSessions.byId(session.id)!.active_slot_id).toBe(slots[0]!);
    expect(gameSessions.byId(session.id)!.segment).toBe(6);
    expect(gameSessions.byId(session.id)!.turn).toBe(2);
  });

  test("crossing segment 12 recovers everyone on the stage, once", () => {
    const { session, campaign } = makeSession(0);
    const cast = [
      makeCharacter(campaign.id, "npc", "Bruiser", {
        speed: 2,
        dexterity: 10,
        recovery: 5,
        endurance: 40,
        stun: 30,
      }),
      makeCharacter(campaign.id, "npc", "Scrapper", {
        speed: 4,
        dexterity: 20,
        recovery: 8,
        endurance: 20,
        stun: 20,
      }),
    ];
    for (const character of cast) sessionCharacters.add(session.id, character.id, "npc");

    // Both of them battered, and Scrapper's END within a Recovery of full. The
    // stage is in DEX order, so Scrapper leads it.
    const slots = slotsOf(session.id);
    sessionCharacters.setVitals(session.id, slots[0]!, { endurance: 15, stun: 2 });
    sessionCharacters.setVitals(session.id, slots[1]!, { endurance: 10, stun: 4 });

    const vitals = () =>
      sessionCharacters
        .list(session.id)
        .map((row) => [row.name, row.cur_endurance, row.cur_stun]);

    // Segment 12 itself is not the moment: both of them act in it first.
    expect(advanceTurn(session.id, "next").recovered).toBe(false);
    expect(advanceTurn(session.id, "next").recovered).toBe(false);
    expect(vitals()).toEqual([
      ["Scrapper", 15, 2],
      ["Bruiser", 10, 4],
    ]);

    // And the step that leaves segment 12 behind is. Scrapper's END stops at its
    // total rather than going five over it.
    expect(advanceTurn(session.id, "next").recovered).toBe(true);
    expect(gameSessions.byId(session.id)!.turn).toBe(2);
    expect(vitals()).toEqual([
      ["Scrapper", 20, 10],
      ["Bruiser", 15, 9],
    ]);

    // The segments in between are just segments.
    expect(advanceTurn(session.id, "next").recovered).toBe(false);
    expect(vitals()).toEqual([
      ["Scrapper", 20, 10],
      ["Bruiser", 15, 9],
    ]);
  });

  test("stepping back over segment 12 does not undo the Recovery", () => {
    const { session, campaign } = makeSession(0);
    const character = makeCharacter(campaign.id, "npc", "Plodder", {
      speed: 2,
      dexterity: 10,
      recovery: 5,
      endurance: 40,
      stun: 30,
    });
    sessionCharacters.add(session.id, character.id, "npc");

    const slot = slotsOf(session.id)[0]!;
    sessionCharacters.setVitals(session.id, slot, { endurance: 10, stun: 4 });

    advanceTurn(session.id, "next");
    expect(advanceTurn(session.id, "next").recovered).toBe(true);

    // Back where it was on the clock, with the Recovery it has already taken:
    // `Previous` is the game master correcting a click, not time running backwards.
    expect(advanceTurn(session.id, "prev").recovered).toBe(false);
    expect(gameSessions.byId(session.id)!.segment).toBe(12);
    const row = sessionCharacters.list(session.id)[0]!;
    expect([row.cur_endurance, row.cur_stun]).toEqual([15, 9]);
  });

  test("an empty session cannot track turns", () => {
    const { session } = makeSession(0);
    expect(() => advanceTurn(session.id, "next")).toThrow(
      "Add some characters to the session before tracking turns.",
    );
  });

  test("a stage where nobody has a SPD cannot track turns either", () => {
    const { session, campaign } = makeSession(0);
    // The default: a character nobody has filled in yet.
    const blank = makeCharacter(campaign.id, "npc", "Unfilled");
    sessionCharacters.add(session.id, blank.id, "npc");

    expect(() => advanceTurn(session.id, "next")).toThrow(/SPD above zero/);
  });
});

/**
 * The one thing that happens to a character purely by the clock reaching them.
 *
 * Being stunned in HERO costs a character their next phase and ends with it, so
 * there is no button for this anywhere in the app: the game master presses Next
 * and the tag is gone. The route that toasts it is covered in `http.test.ts`;
 * these are the rules the clock itself applies.
 */
describe("coming up on turn while stunned", () => {
  /** One character, one phase per segment, and stunned when the fight opens. */
  const stunnedSolo = (extraTags: string[] = []) => {
    const { session, campaign } = makeSession(0);
    const character = makeCharacter(campaign.id, "pc", "Ace", { speed: 12, dexterity: 20 });
    sessionCharacters.add(session.id, character.id, "pc");
    const slot = slotsOf(session.id)[0]!;
    sessionCharacters.setTag(session.id, slot, "stunned", true);
    for (const tag of extraTags) sessionCharacters.setTag(session.id, slot, tag, true);
    return { session, character, slot };
  };

  const isStunned = (sessionId: string, slot: string) =>
    sessionCharacters.hasTag(sessionId, slot, "stunned");

  test("the stun comes off, and the log says so", () => {
    const { session, slot } = stunnedSolo();

    const step = advanceTurn(session.id, "next");

    expect(isStunned(session.id, slot)).toBe(false);
    expect(step.unstunned).toEqual({ character: "Ace", playerId: null });
    expect(sessionEvents.list(session.id).map((event) => event.message))
      .toContain(becameUnstunned("Ace"));
  });

  test("a character nobody is playing has no player to tell", () => {
    const { session } = stunnedSolo();
    makePlayer(session.id);

    // A player at the table who has claimed nothing is not this character's,
    // and the game master is left the only one told.
    expect(advanceTurn(session.id, "next").unstunned!.playerId).toBeNull();
  });

  test("the player holding the character is the one told", () => {
    const { session, character } = stunnedSolo();
    const player = makePlayer(session.id);
    players.setClaim(player.id, character.id);

    expect(advanceTurn(session.id, "next").unstunned!.playerId).toBe(player.id);
  });

  test("an unconscious character keeps it", () => {
    const { session, slot } = stunnedSolo(["unconscious"]);

    const step = advanceTurn(session.id, "next");

    // Out cold is not a phase spent shaking anything off, and a row that had
    // quietly recovered from the smaller of its two problems would mislead.
    expect(step.unstunned).toBeNull();
    expect(isStunned(session.id, slot)).toBe(true);
    expect(sessionEvents.list(session.id).map((event) => event.message))
      .not.toContain(becameUnstunned("Ace"));
  });

  test("stepping back does not hand the stun back", () => {
    const { session, slot } = stunnedSolo();
    advanceTurn(session.id, "next");
    advanceTurn(session.id, "next");
    sessionCharacters.setTag(session.id, slot, "stunned", true);

    // `Previous` is the game master correcting a click rather than the fight
    // taking its phases again, so it applies no rule on the way.
    const step = advanceTurn(session.id, "prev");

    expect(step.unstunned).toBeNull();
    expect(isStunned(session.id, slot)).toBe(true);
  });

  test("it happens once, on the phase the clock reaches", () => {
    const { session, campaign } = makeSession(0);
    // SPD 2 acts in segments 6 and 12; Quick leads segment 12 on DEX.
    const plodder = makeCharacter(campaign.id, "npc", "Plodder", { speed: 2, dexterity: 10 });
    const quick = makeCharacter(campaign.id, "npc", "Quick", { speed: 2, dexterity: 30 });
    sessionCharacters.add(session.id, plodder.id, "npc");
    sessionCharacters.add(session.id, quick.id, "npc");

    const slotOf = (name: string) =>
      sessionCharacters.list(session.id).find((row) => row.name === name)!.slot_id;
    sessionCharacters.setTag(session.id, slotOf("Plodder"), "stunned", true);

    // Quick's phase is not Plodder's, and leaves the tag where it is.
    expect(advanceTurn(session.id, "next").unstunned).toBeNull();
    expect(isStunned(session.id, slotOf("Plodder"))).toBe(true);

    expect(advanceTurn(session.id, "next").unstunned?.character).toBe("Plodder");
    expect(isStunned(session.id, slotOf("Plodder"))).toBe(false);

    // And the next phase along has nothing left to take off.
    expect(advanceTurn(session.id, "next").unstunned).toBeNull();
  });

  test("returning from a held action is not a phase beginning", () => {
    const { session, campaign } = makeSession(0);
    const cast = [
      makeCharacter(campaign.id, "npc", "Ace", { speed: 12, dexterity: 30 }),
      makeCharacter(campaign.id, "npc", "Slow", { speed: 12, dexterity: 10 }),
    ];
    for (const character of cast) sessionCharacters.add(session.id, character.id, "npc");

    const slotOf = (name: string) =>
      sessionCharacters.list(session.id).find((row) => row.name === name)!.slot_id;

    // Ace is up, and Slow cuts into their phase with a held action.
    advanceTurn(session.id, "next");
    gameSessions.setResume(session.id, slotOf("Ace"));
    gameSessions.setTurn(session.id, slotOf("Slow"), 1, 12);

    // Ace is stunned mid-interjection. The step out of it returns to the phase
    // Ace had already begun rather than starting them a new one, so it applies
    // nothing; the tag waits for the phase that is really theirs.
    sessionCharacters.setTag(session.id, slotOf("Ace"), "stunned", true);
    const step = advanceTurn(session.id, "next");

    expect(step.unstunned).toBeNull();
    expect(isStunned(session.id, slotOf("Ace"))).toBe(true);
  });
});
