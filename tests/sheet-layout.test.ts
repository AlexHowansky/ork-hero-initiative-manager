/**
 * Which layout a window gets.
 *
 * The rule is a handful of comparisons, and the reason it is worth this many
 * tests is that both halves of the app run it: the server to choose a template,
 * the browser to decide whether a resize is worth re-fetching a sheet. If the two
 * ever disagreed about one number, a reader would be stuck looking at a layout
 * their window had already left.
 */

import { describe, expect, test } from "bun:test";
import {
  formatSheetRatio,
  isSettledAt,
  layoutForRatio,
  SHEET_LAYOUTS,
} from "../src/lib/sheetLayout.ts";

/** The shapes the three layouts are named after. */
const WIDESCREEN = 16 / 9; // 1.7778
const HALF_SCREEN = 8 / 9; // 0.8889
const UPRIGHT = 9 / 16; // 0.5625

describe("the layout a window gets", () => {
  test("each layout is what its own shape asks for", () => {
    // The least a rule about three shapes can do is agree with the three shapes.
    expect(layoutForRatio(WIDESCREEN)).toBe("16x9");
    expect(layoutForRatio(HALF_SCREEN)).toBe("8x9");
    expect(layoutForRatio(UPRIGHT)).toBe("9x16");
  });

  test("real windows get the layout a person would have picked", () => {
    expect(layoutForRatio(1920 / 1080)).toBe("16x9");
    // The same monitor with the window snapped to half of it.
    expect(layoutForRatio(960 / 1080)).toBe("8x9");
    expect(layoutForRatio(2560 / 1440)).toBe("16x9");
    // A phone upright, and a tablet upright.
    expect(layoutForRatio(390 / 844)).toBe("9x16");
    expect(layoutForRatio(820 / 1180)).toBe("9x16");
    // A tablet on its side is a wide window like any other.
    expect(layoutForRatio(1180 / 820)).toBe("16x9");
  });

  test("the boundaries fall where the geometric means are", () => {
    // Just inside and just outside each, so a boundary that moved would be
    // caught rather than absorbed.
    expect(layoutForRatio(0.707)).toBe("9x16");
    expect(layoutForRatio(0.708)).toBe("8x9");
    expect(layoutForRatio(1.257)).toBe("8x9");
    expect(layoutForRatio(1.258)).toBe("16x9");
  });

  test("a square window is the half-screen layout", () => {
    // 1:1 sits between the two boundaries, and of the three shapes 8:9 is the
    // one nearest a square.
    expect(layoutForRatio(1)).toBe("8x9");
  });

  test("anything that is not a shape is the widescreen layout", () => {
    // What a caller that is not a browser gets, and what a query string somebody
    // typed by hand gets. Never an error: a ratio is not worth refusing a
    // character sheet over.
    for (const nonsense of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(layoutForRatio(nonsense)).toBe("16x9");
    }
  });

  test("absurd but real shapes still answer", () => {
    // A window one pixel wide, and a wall of monitors.
    expect(layoutForRatio(0.001)).toBe("9x16");
    expect(layoutForRatio(500)).toBe("16x9");
  });

  test("every layout is reachable", () => {
    // Otherwise a layout could ship that no window could ever ask for.
    const reached = new Set(
      [0.1, 0.5, 0.7, 0.9, 1, 1.2, 1.5, 2, 5].map((ratio) => layoutForRatio(ratio)),
    );
    expect([...reached].sort()).toEqual([...SHEET_LAYOUTS].sort());
  });
});

describe("reporting a ratio", () => {
  test("rounding can move a window across a boundary", () => {
    // Which is the whole reason there is one place to round. This measurement is
    // just over the narrow boundary and rounds to just under it, so the raw
    // number and the number that would be sent disagree about the layout.
    const measured = 0.70714999;
    expect(layoutForRatio(measured)).toBe("8x9");
    expect(layoutForRatio(Number(formatSheetRatio(measured)))).toBe("9x16");

    // The contract that makes that harmless: bucket what you send, never the
    // measurement behind it. A browser that bucketed the raw value would believe
    // it was showing 8x9 while the server drew 9x16 — and, believing itself
    // right, would never ask again.
  });

  test("what is sent survives the round trip unchanged", () => {
    // The server parses the string the browser wrote, so formatting has to be
    // stable: format a formatted ratio and nothing moves.
    for (const ratio of [0.70709, 1.25709, 0.99999, 16 / 9]) {
      const sent = formatSheetRatio(ratio);
      expect(formatSheetRatio(Number(sent))).toBe(sent);
      expect(layoutForRatio(Number(sent))).toBe(layoutForRatio(Number(sent)));
    }
  });

  test("is short enough to read in a URL", () => {
    expect(formatSheetRatio(1920 / 1080)).toBe("1.7778");
  });
});

describe("settling", () => {
  test("a window well inside a layout is settled", () => {
    expect(isSettledAt(1.7778, "16x9")).toBe(true);
    expect(isSettledAt(0.8889, "8x9")).toBe(true);
    expect(isSettledAt(0.5625, "9x16")).toBe(true);
  });

  test("a window resting on a boundary is not", () => {
    // The case this exists for: a phone whose URL bar slides in and out moves the
    // page height by a tenth, and a sheet that re-rendered every time it did
    // would be unreadable.
    expect(isSettledAt(1.2571, "16x9")).toBe(false);
    expect(isSettledAt(1.2571, "8x9")).toBe(false);
    expect(isSettledAt(0.7071, "9x16")).toBe(false);
  });

  test("what settles is what the layout rule would have said anyway", () => {
    // A ratio that settles is one the server buckets the same way, which is what
    // makes it safe to send: the server has no memory of where the window was.
    for (const ratio of [0.4, 0.6, 0.9, 1.5, 3]) {
      const layout = layoutForRatio(ratio);
      if (isSettledAt(ratio, layout)) expect(layoutForRatio(ratio)).toBe(layout);
    }
  });
});
