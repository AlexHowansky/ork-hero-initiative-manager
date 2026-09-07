/**
 * The game master's settings that are not a matter of CSS.
 *
 * `cardSize.ts` is the other half of this: a setting whose whole effect is a
 * custom property on the document, which nothing needs to re-render for. What is
 * here changes what the console *shows*, so React has to hear about it — hence a
 * store rather than a style.
 *
 * A module-level store rather than a context, for the same reason the card size
 * is one: the settings drawer and the screens that obey the settings are nowhere
 * near each other in the tree, and threading a value through two page components
 * that have no interest in it is a worse trade than a store with two callers.
 *
 * The server is where these live. This holds what it last told us — set from the
 * identity at boot (`app.tsx`) and again by the drawer as a reader changes it —
 * and holds nothing at all for a player, who has no account to keep a setting on.
 */

import { useCallback, useSyncExternalStore } from "react";
import { BUILT_IN_TEMPLATE_ID } from "../lib/templates.ts";

export interface GmSettings {
  /** Whether the session library reaches past the session's own campaign. */
  showAllNpcs: boolean;
  /**
   * The export template their character sheets are drawn through. The one this
   * app ships travels under its own id rather than as a null, so the drawer's
   * `<select>` has one kind of value to hold.
   */
  templateId: string;
}

const DEFAULTS: GmSettings = { showAllNpcs: false, templateId: BUILT_IN_TEMPLATE_ID };

let current: GmSettings = DEFAULTS;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Puts settings in force, or — with `null` — takes them back off, which is what
 * signing out should do: the next person at this browser is not the one whose
 * console this was.
 */
export function applyGmSettings(settings: GmSettings | null): void {
  current = settings ?? DEFAULTS;
  for (const listener of listeners) listener();
}

/** The settings as they stand. Re-renders whoever asks when they change. */
export function useGmSettings(): GmSettings {
  return useSyncExternalStore(subscribe, () => current, () => DEFAULTS);
}

/**
 * One flag, and a way to change it locally.
 *
 * Local only: this puts the new value on the page at once, and saving it is the
 * caller's business — the drawer's, which is the one place a setting is written.
 */
export function useGmSetting<K extends keyof GmSettings>(
  key: K,
): [GmSettings[K], (value: GmSettings[K]) => void] {
  const settings = useGmSettings();
  const set = useCallback(
    (value: GmSettings[K]) => applyGmSettings({ ...current, [key]: value }),
    [key],
  );
  return [settings[key], set];
}
