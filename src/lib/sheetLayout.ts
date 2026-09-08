/**
 * Which shape of character sheet suits a given window.
 *
 * The template this app ships comes in three layouts — a maximised widescreen
 * monitor, a window snapped to half of one, and a phone held upright — and which
 * of them a sheet is drawn through is not a setting. It is the shape of the
 * window the sheet is being read in, which is why it is worked out from a number
 * rather than chosen from a list.
 *
 * Shared between the browser and the server, and the split matters. The server
 * decides: the sheet URL carries a ratio and nothing else, so a request can never
 * name a layout that does not exist. The browser uses the same buckets for one
 * narrow purpose — knowing whether a resize has changed the answer, and so
 * whether the sheet is worth re-fetching at all. Both must bucket *the same
 * number*, which is what `formatSheetRatio` is for: format first, then bucket
 * what you formatted, or the two can disagree by a rounding and leave a reader
 * looking at the wrong layout with no way to ask for the right one.
 */

/** The layouts the built-in template ships in, widest first. */
export const SHEET_LAYOUTS = ["16x9", "8x9", "9x16"] as const;

export type SheetLayout = (typeof SHEET_LAYOUTS)[number];

/**
 * Where one layout stops suiting a window better than the next.
 *
 * The geometric mean of each adjacent pair of ratios rather than the arithmetic
 * one: these are ratios, so the midpoint between 0.5625 and 0.889 is the one
 * that is the same factor away from both, not the one that is the same distance
 * away. √(0.5625 × 0.889) and √(0.889 × 1.778).
 *
 * (16:9's own reciprocal, 0.5625, is 9:16 — but the two boundaries are not each
 * other's reciprocals, and nothing here claims they are. That would need the
 * middle layout to be square, and 8:9 is not.)
 */
const NARROW_BOUNDARY = 0.7071067811865476;
const WIDE_BOUNDARY = 1.2570787221094177;

/**
 * How precisely a ratio is reported, and the one place it is rounded.
 *
 * Four decimals is finer than any window can be told apart by eye and short
 * enough to read in a URL. It exists so that the browser and the server bucket an
 * identical number: the browser sends what this returns, and buckets what this
 * returns, never the measurement behind it.
 */
export function formatSheetRatio(ratio: number): string {
  return ratio.toFixed(4);
}

/**
 * The layout for a window of this shape.
 *
 * Anything that is not a positive, finite ratio answers with the widescreen
 * layout — the shape this app was designed around, and what a caller that is not
 * a browser gets. A ratio is never a reason to refuse a sheet: a game master who
 * has just clicked a character's name mid-fight must get that character, and a
 * query string they did not type is not worth failing over.
 */
export function layoutForRatio(ratio: number): SheetLayout {
  if (!Number.isFinite(ratio) || ratio <= 0) return "16x9";
  if (ratio < NARROW_BOUNDARY) return "9x16";
  if (ratio < WIDE_BOUNDARY) return "8x9";
  return "16x9";
}

/**
 * Whether a window is far enough past a boundary to be worth acting on.
 *
 * A dead band, because crossing a boundary costs a reader their sheet: it is
 * re-rendered and re-fetched, losing the scroll position and whatever they had
 * open on it. A window resting *on* a boundary must not do that repeatedly — and
 * one will, because a phone's URL bar sliding in and out changes the height of
 * the page by a tenth without anybody touching anything.
 *
 * Asked as "would a window five percent either side of this one give the same
 * answer?", so the caller needs no knowledge of where the boundaries are, and so
 * that a ratio this accepts is one the server will bucket the same way — the
 * server has no hysteresis and cannot have any, being handed one number and no
 * history.
 */
export function isSettledAt(ratio: number, layout: SheetLayout): boolean {
  const margin = 1.05;
  return layoutForRatio(ratio * margin) === layout && layoutForRatio(ratio / margin) === layout;
}
