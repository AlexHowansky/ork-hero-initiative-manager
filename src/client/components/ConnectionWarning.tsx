/**
 * The one place a screen says its live connection is not working.
 *
 * Nothing at all when everything is fine, which is nearly always — so it costs a
 * header nothing to carry one, and every screen that watches something live has
 * one rather than picking and choosing. What it reports is every socket on the
 * page at once (see `liveStatus.ts`), so the library, which holds one for the
 * session list and one for each session in progress, still has a single icon.
 *
 * The message is the point rather than the icon. A red triangle on its own says
 * "something is wrong" to somebody who cannot do anything with that; the hover
 * text says what it means for what they are looking at, and then what actually
 * happened, for whoever is going to fix it.
 */

import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { Icon } from "./ui.tsx";
import { describeTrouble, useLiveTrouble } from "../liveStatus.ts";

export function ConnectionWarning({ className = "" }: { className?: string }) {
  const trouble = useLiveTrouble();
  if (!trouble) return null;

  const { headline, detail } = describeTrouble(trouble);

  return (
    // A status rather than a control: there is nothing to press, and the only
    // thing to do about it is already in the message. `role="status"` is what
    // announces it when it appears, the same way the toasts are announced —
    // which is the whole of what a reader who cannot see it gets, since a native
    // tooltip does not open on keyboard focus.
    //
    // The `title` carries both lines, split by a newline, which is how a browser
    // draws a tooltip on two lines. `sr-only` says the same thing again because
    // `Icon` is `aria-hidden` by policy: the picture is never the only thing
    // saying what something is.
    <span
      role="status"
      title={`${headline}\n${detail}`}
      className={`flex items-center text-error ${className}`}
    >
      <Icon icon={faTriangleExclamation} />
      <span className="sr-only">{`${headline} ${detail}`}</span>
    </span>
  );
}
