/**
 * Colour theme preference.
 *
 * Three states: follow the system, force light, force dark. "System" is the
 * default and is handled entirely in CSS, so a reader who never touches the
 * toggle gets a correct first paint with no script involved. An explicit choice
 * is written to <html data-theme> and remembered in localStorage.
 *
 * What is stored is the preference — "light" or "dark" — and what is written to
 * the attribute is the daisyUI theme that realises it. The two are kept apart
 * deliberately: `THEMES` is the only place in the app that knows which stock
 * themes we have chosen, so swapping `winter` for another light theme is a
 * one-line change that leaves every reader's stored preference intact.
 */

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "ork-him.theme";

/** The daisyUI theme each explicit preference selects. See `styles.css`. */
const THEMES = { light: "winter", dark: "night" } as const;

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    // Private browsing and blocked site data both throw here.
    return "system";
  }
}

export function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement;
  // No attribute at all is the "follow the system" state: with nothing set, the
  // `--prefersdark` theme takes over inside a dark media query and the default
  // one applies otherwise.
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", THEMES[preference]);

  try {
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // A preference we cannot persist still applies for this page view.
  }
}

/** Applied before React renders, so a stored choice doesn't flash the other theme. */
export function initTheme(): void {
  const preference = readPreference();
  if (preference !== "system") document.documentElement.setAttribute("data-theme", THEMES[preference]);
}
