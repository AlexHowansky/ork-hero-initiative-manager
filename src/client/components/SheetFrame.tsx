/**
 * Displays an uploaded character sheet.
 *
 * The sheet is the game master's own HTML and keeps its JavaScript, so it is
 * loaded in an iframe with `sandbox` and deliberately *without*
 * `allow-same-origin`. That puts it in an opaque origin: its scripts still run,
 * but it cannot read this page's cookies or storage, reach into the DOM around
 * it, or call the API as the signed-in user. The response carries the same
 * sandbox as a header, so the restriction does not depend on this attribute
 * alone.
 */

import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { useEffect, useRef, useState, type RefObject } from "react";
import { formatSheetRatio, isSettledAt, layoutForRatio } from "../../lib/sheetLayout.ts";
import { Icon, IconButton } from "./ui.tsx";

export function SheetFrame({ src, title }: { src: string; title: string }) {
  return (
    <iframe
      src={src}
      title={`${title} — character sheet`}
      // allow-scripts without allow-same-origin is the isolation boundary.
      // allow-forms and allow-popups let an interactive sheet behave normally.
      sandbox="allow-scripts allow-forms allow-popups"
      referrerPolicy="no-referrer"
      loading="lazy"
      // Nothing of ours around it: no border, no rounding, no padding. A sheet is
      // a whole page of someone else's design and is shown as it was written.
      className="h-full w-full border-0 bg-white"
    />
  );
}

/**
 * A sheet opened over the page, wherever it was opened from.
 *
 * It carries the window's own aspect ratio: `--sheet-size` is one percentage and
 * it sets both dimensions, so at the default of 90 the sheet is nine tenths of the
 * window each way — the same shape, smaller, with the dimmed page still showing
 * around it — and at 100 it fills the viewport outright. The deployment chooses
 * the number (`SHEET_WIDTH_PCT`; see `server/routes/appearance.ts`).
 *
 * There is no title bar, because a sheet already says whose it is and a strip of
 * our own would take the room and change the shape. The one thing over it is the
 * close control, in the window's own top right rather than the sheet's, so it is
 * in the same place whatever size the sheet is drawn at. It is an `IconButton`
 * because that is already built to stay readable over something it knows nothing
 * about, which here is either the dimmed page or the sheet itself.
 *
 * Escape closes it, and so does a click on the dimmed page around it — that is
 * `event.target === event.currentTarget`, so only the backdrop itself counts and
 * a click that started on the sheet or the button does not.
 */
/**
 * The shape of the box a sheet is about to be drawn in, as the server wants it.
 *
 * The template this app ships comes in three layouts and the right one is a
 * matter of the shape of what the reader is looking at, so that shape is measured
 * here and sent with the request. It is measured off the box itself rather than
 * off the window: the box is `--sheet-size` percent of each viewport axis, which
 * today makes its shape the window's own, but the deployment sets that number and
 * an element that is asked how big it is cannot be wrong about it.
 *
 * Seeded on the first render rather than in an effect, because a sheet opened at
 * one shape and corrected to another a frame later is two renders on the server,
 * two fetches, and a visible flash for every sheet anybody opens.
 *
 * It moves only when the answer would change, and then only once the window is
 * clearly past the boundary rather than resting on it. Re-fetching costs the
 * reader their scroll position and whatever they had open on the sheet, so it is
 * worth doing when a tablet is turned over and not worth doing while a window is
 * being dragged, or each time a phone's URL bar slides out of the way.
 */
function useSheetRatio(box: RefObject<HTMLElement | null>): string {
  const [ratio, setRatio] = useState(() => formatSheetRatio(viewportRatio()));

  useEffect(() => {
    const element = box.current;
    if (!element) return;

    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      setRatio((held) => {
        const measured = formatSheetRatio(width / height);
        const layout = layoutForRatio(Number(measured));
        if (layout === layoutForRatio(Number(held))) return held;
        // Bucketed on the number that would be *sent*, never on the measurement
        // behind it: a ratio that rounds across a boundary on its way into the
        // URL would leave this believing one thing and the server drawing
        // another, with nothing to put it right.
        return isSettledAt(Number(measured), layout) ? measured : held;
      });
    };

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);

  return ratio;
}

/** The window's shape, for the first render, before there is a box to measure. */
function viewportRatio(): number {
  return window.innerWidth / window.innerHeight;
}

export function SheetOverlay({
  src,
  title,
  onClose,
}: {
  src: string;
  title: string;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const ratio = useSheetRatio(box);

  // Built rather than concatenated, so a `sheetUrl` that ever carries a query of
  // its own does not come out with two.
  const url = new URL(src, window.location.href);
  url.searchParams.set("ratio", ratio);
  const withRatio = `${url.pathname}${url.search}`;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal modal-open"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} character sheet`}
        ref={box}
        className="h-[calc(var(--sheet-size)*1dvh)] w-[calc(var(--sheet-size)*1dvw)] overflow-hidden bg-base-100"
      >
        {/* Keyed on the address, so a change of layout is a *new* frame rather
            than the old one being navigated. Navigating a live frame pushes an
            entry onto this page's own history, and a reader who turned a tablet
            over twice would then have to press Back three times to leave — the
            first two doing nothing they can see. */}
        <SheetFrame key={withRatio} src={withRatio} title={title} />
      </div>
      <IconButton
        label="Close"
        icon={<Icon icon={faXmark} />}
        onClick={onClose}
        className="absolute top-2 right-2 z-10"
      />
    </div>
  );
}
