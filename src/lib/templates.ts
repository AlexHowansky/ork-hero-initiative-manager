/**
 * The one thing both sides need to know about export templates.
 *
 * A game master's active template is a `templates` row, or the one this app
 * ships — which is stored as NULL, because "has never chosen" needs no row to
 * exist. NULL is a poor value to put in a `<select>`, though, so the built-in
 * travels over the wire and through the browser under this id instead, and the
 * server translates at the edge (`presentGm`, and the settings route).
 *
 * It cannot collide with a real template: those are UUIDs (`lib/ids.ts`).
 */
export const BUILT_IN_TEMPLATE_ID = "built-in";
