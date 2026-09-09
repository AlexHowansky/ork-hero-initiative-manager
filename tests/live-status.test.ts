/**
 * The live-connection warning's logic, without a browser.
 *
 * What the reader is told when a socket fails, and how several failing sockets
 * become one thing to say. The wiring — which socket reports what, and the delay
 * before any of it is drawn — is in `tests/e2e.test.ts`, where there is a real
 * page to fail.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearSocketTrouble,
  currentTrouble,
  describeTrouble,
  reportSocketTrouble,
  type SocketTrouble,
} from "../src/client/liveStatus.ts";

/** A socket in trouble, with only the part a test cares about spelled out. */
function trouble(over: Partial<SocketTrouble> = {}): SocketTrouble {
  return { kind: "unreachable", since: 1000, attempts: 1, code: null, reason: null, ...over };
}

// The store is module state, as it is in the browser, so each test starts by
// emptying it rather than by making a new one.
beforeEach(() => {
  for (const id of ["a", "b", "c"]) clearSocketTrouble(id);
});

describe("what the reader is told", () => {
  test("a socket that never connected is not the same as one that dropped", () => {
    const never = describeTrouble({ worst: trouble({ kind: "unreachable" }), count: 1 });
    const lost = describeTrouble({ worst: trouble({ kind: "dropped" }), count: 1 });

    expect(never.headline).toContain("could not connect");
    expect(lost.headline).toContain("was lost");
    // Both say the same thing about what it means, which is the half that is for
    // whoever is at the table rather than for whoever fixes it.
    expect(never.headline).toContain("may be out of date");
    expect(lost.headline).toContain("may be out of date");
  });

  test("a connection that never answered says so, and invents no code", () => {
    const { detail } = describeTrouble({ worst: trouble({ code: null, attempts: 3 }), count: 1 });
    expect(detail).toContain("never answered");
    expect(detail).toContain("Attempt 3.");
    expect(detail).not.toContain("null");
  });

  test("a close code is printed with what it means", () => {
    const { detail } = describeTrouble({
      worst: trouble({ kind: "dropped", code: 1006, attempts: 2 }),
      count: 1,
    });
    expect(detail).toContain("1006");
    expect(detail).toContain("abnormal close");
    expect(detail).toContain("Attempt 2.");
  });

  test("an unfamiliar code is still a number to search for", () => {
    expect(describeTrouble({ worst: trouble({ code: 3999 }), count: 1 }).detail).toContain("3999");
    expect(describeTrouble({ worst: trouble({ code: 4010 }), count: 1 }).detail)
      .toContain("application's own");
  });

  test("what the server said with the code is quoted when it said anything", () => {
    const spoke = describeTrouble({
      worst: trouble({ code: 1008, reason: "Unauthorized" }),
      count: 1,
    });
    const silent = describeTrouble({ worst: trouble({ code: 1008, reason: null }), count: 1 });

    expect(spoke.detail).toContain("Unauthorized");
    expect(silent.detail).toContain("1008");
    expect(silent.detail).not.toContain("“");
  });

  test("several sockets down are one sentence, counted", () => {
    const { headline } = describeTrouble({ worst: trouble(), count: 4 });
    expect(headline).toContain("4 connections");
    // Not "it could not connect", which is a sentence about one of them.
    expect(headline).not.toContain("could not connect");
  });
});

describe("the store", () => {
  test("the longest-standing trouble is the one described", () => {
    reportSocketTrouble("a", trouble({ since: 5000 }));
    reportSocketTrouble("b", trouble({ since: 3000 }));
    reportSocketTrouble("c", trouble({ since: 9000 }));

    expect(currentTrouble()?.count).toBe(3);
    expect(currentTrouble()?.worst.since).toBe(3000);
  });

  test("a socket reporting twice is still one socket", () => {
    reportSocketTrouble("a", trouble({ attempts: 1 }));
    reportSocketTrouble("a", trouble({ attempts: 2 }));

    expect(currentTrouble()?.count).toBe(1);
    expect(currentTrouble()?.worst.attempts).toBe(2);
  });

  test("clearing the last one leaves nothing to say", () => {
    reportSocketTrouble("a", trouble());
    reportSocketTrouble("b", trouble());

    clearSocketTrouble("a");
    expect(currentTrouble()?.count).toBe(1);

    clearSocketTrouble("b");
    expect(currentTrouble()).toBeNull();
  });

  test("clearing one that was never in trouble changes nothing", () => {
    reportSocketTrouble("a", trouble());
    clearSocketTrouble("b");
    expect(currentTrouble()?.count).toBe(1);
  });

  /**
   * The guard against an infinite render: `useSyncExternalStore` compares what
   * `getSnapshot` returns with what it returned last time, so a summary rebuilt
   * per call would re-render for ever.
   */
  test("the snapshot keeps its identity until something changes", () => {
    reportSocketTrouble("a", trouble());
    const first = currentTrouble();
    expect(currentTrouble()).toBe(first);

    reportSocketTrouble("b", trouble());
    expect(currentTrouble()).not.toBe(first);
  });
});
