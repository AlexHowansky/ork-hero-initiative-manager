/**
 * Per-reader settings, and the drawer they live in.
 *
 * The log's drawer, mirrored: it pushes the page aside rather than covering it,
 * it is not modal — no backdrop, no focus trap, and the console beside it stays
 * live — and Escape closes it. What differs is the side. The log comes out of
 * the top left because its control is in that corner; these come out of the top
 * right because theirs is, and a reader who has just pressed the gear should
 * find the panel under their finger rather than across the page.
 *
 * What is in it belongs to the game master rather than to the table, and is kept
 * on their row in the database so that it follows them to whichever machine they
 * sign in on. The drawer is on the game master's screens only for that reason: a
 * player has no account to keep a setting against.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { faGear, faXmark } from "@fortawesome/free-solid-svg-icons";
import { CARD_IMAGE_PX } from "../../lib/cards.ts";
import { api } from "../api.ts";
import { useCardSize } from "../cardSize.ts";
import { useGmSetting } from "../gmSettings.ts";
import {
  Button,
  DeleteIcon,
  Icon,
  IconButton,
  Panel,
  PANEL_CAPTION,
  TEXT_MUTED,
} from "./ui.tsx";
import type { TemplateSummary } from "../types.ts";
import { useToast } from "./Toast.tsx";

/* -------------------------------------------------------------------- state */

/**
 * Whether the settings drawer is open, and a way to change it.
 *
 * Not remembered, which is where this parts company with `useLogDrawer`. The log
 * is open *while* a fight runs and should survive a reload mid-turn; settings are
 * something a reader opens, changes and shuts. A drawer that reopened itself on
 * every load would be taking a slice of the console for a visit nobody asked to
 * repeat.
 */
export function useSettingsDrawer(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((was) => !was), []);
  return [open, toggle];
}

/* ------------------------------------------------------------------ control */

/**
 * The control that opens and closes the drawer, for the right of a page header.
 *
 * The gear alone, where the log's control carries its word: this one sits in a
 * run of icon buttons — the theme's three, and the sign-out beside it — and a
 * labelled button in the middle of them would read as the odd one out. The name
 * is in the tooltip and in `sr-only` text, so it is a labelled button to
 * everything that is not the eye.
 */
export function SettingsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onToggle}
      aria-expanded={open}
      title={open ? "Hide settings" : "Settings"}
    >
      <Icon icon={faGear} />
      <span className="sr-only">Settings</span>
    </Button>
  );
}

/* ----------------------------------------------------------------- settings */

/** How long a drag has to settle before it is worth a request. */
const SAVE_DELAY_MS = 400;

/** Ties each control to its label. One drawer to a page, so one id each will do. */
const CARD_SIZE_ID = "setting-card-size";
const SHOW_ALL_NPCS_ID = "setting-show-all-npcs";
const TEMPLATE_ID = "setting-template";

/**
 * Writes one setting, and says so when it cannot.
 *
 * The failure is worth a toast because these are quiet controls: what a reader
 * changed is already on the page and will go on looking right for the rest of the
 * visit, so a save that dropped on the floor would only be discovered on the next
 * sign-in. What is on the page is deliberately left alone either way — taking
 * their choice back off the screen would be a second surprise on top of the
 * first.
 */
function useSaveSetting(): (changes: Record<string, unknown>) => void {
  const toast = useToast();
  return useCallback(
    (changes) => {
      void api.patchJson("/api/settings", changes).catch((error) => toast.showError(error));
    },
    [toast],
  );
}

/**
 * A setting's caption and its control, on one line with the explanation under
 * them.
 *
 * A `label for` rather than a label wrapped around the lot: wrapping hands the
 * control every word inside it as its accessible name — the reading, the units,
 * the sentence underneath — which is a mouthful to hear read out, and matches
 * half the other controls in the app when a test or a screen reader goes looking
 * for one by name. `for` names it what it is called.
 */
function Setting({
  id,
  label,
  control,
  children,
}: {
  id: string;
  label: string;
  /** What sits at the end of the caption line: a reading, or the control itself. */
  control: ReactNode;
  /** The sentence under it, and the control where that is not the `control`. */
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className={`text-sm ${PANEL_CAPTION}`}>
          {label}
        </label>
        {control}
      </div>
      {children}
    </div>
  );
}

/**
 * How big this game master wants cards drawn.
 *
 * The slider moves the cards themselves as it is dragged — `applyCardSize` puts
 * the new value straight onto the page, and the library behind the drawer
 * reflows under the reader's thumb. That is the whole point of a range control
 * here rather than a number field: the answer to "how big should a card be" is
 * something you recognise when you see it, not something you can type.
 *
 * The save is held back until the drag settles, so crossing the track is one
 * request rather than forty. A failed save is said out loud, since the cards
 * would otherwise keep the size the reader chose and quietly lose it on the next
 * sign-in; what is on the page stays either way, because taking their choice
 * back off the screen would be a second surprise on top of the first.
 */
function CardSize() {
  const [size, setSize] = useCardSize();
  const save = useSaveSetting();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A drag left in flight when the drawer closes — or when the page navigates —
  // should not fire afterwards.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const choose = (px: number) => {
    setSize(px);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save({ cardImagePx: px }), SAVE_DELAY_MS);
  };

  return (
    <Setting
      id={CARD_SIZE_ID}
      label="Card size"
      control={
        // The number the slider is on, in the unit the setting is measured in.
        // Tabular, so the reading does not jitter sideways as the digits change
        // under a drag.
        <span className={`text-xs tabular-nums ${TEXT_MUTED}`}>{size}px</span>
      }
    >
      <input
        id={CARD_SIZE_ID}
        type="range"
        className="range range-sm w-full"
        min={CARD_IMAGE_PX.min}
        max={CARD_IMAGE_PX.max}
        step={CARD_IMAGE_PX.step}
        value={size}
        onChange={(event) => choose(Number(event.target.value))}
      />
      <p className={`text-xs ${TEXT_MUTED}`}>
        How large the picture on a card is drawn. The card itself comes out
        taller — its frame and the name underneath are extra.
      </p>
    </Setting>
  );
}

/**
 * Whether the session library reaches past the session's own campaign.
 *
 * Saved the moment it is pressed, where the slider waits for a drag to settle: a
 * toggle is one press and there is nothing to wait for.
 *
 * The console re-reads the library when this changes, so the list under it
 * refills without a reload — which is the point of holding the setting in a store
 * rather than only sending it to the server.
 */
function ShowAllNpcs({ heldOn }: { heldOn: string | null }) {
  const [on, setOn] = useGmSetting("showAllNpcs");
  const save = useSaveSetting();

  const choose = (next: boolean) => {
    setOn(next);
    save({ showAllNpcs: next });
  };

  // Held *on* rather than held: switching it on is always allowed, and a control
  // that refused a press it is perfectly able to take would be making the wrong
  // promise. Only the way back out is closed, and only while something is out
  // there that depends on it.
  const locked = heldOn !== null && on;

  return (
    <Setting
      id={SHOW_ALL_NPCS_ID}
      label="Show all NPCs"
      control={
        <input
          id={SHOW_ALL_NPCS_ID}
          type="checkbox"
          className="toggle toggle-sm"
          checked={on}
          disabled={locked}
          onChange={(event) => choose(event.target.checked)}
        />
      }
    >
      <p className={`text-xs ${TEXT_MUTED}`}>
        {/* Why it will not move, in place of what it does. Somebody looking at a
            control that has stopped taking presses is asking the first question,
            not the second — and the setting is on, so its description is already
            true in front of them. */}
        {locked ? heldOn : "Allow adding NPCs from your other campaigns to the stage."}
      </p>
    </Setting>
  );
}

/**
 * Which export template this game master's character sheets are drawn through.
 *
 * A sheet is not stored — it is built on every request by applying a template to
 * the character file — so this setting is the whole look of every sheet at their
 * table, and it changes on the very next one opened, with nothing to invalidate.
 *
 * Three controls for one idea, which is why they share a section rather than
 * being three settings. The `select` is the setting: it says which template is in
 * force. The list under it is the collection that select is choosing from, and
 * the only thing there is to do to a template besides choose it is remove it. The
 * file input adds to the collection.
 *
 * The template this app ships is in the list and is not in the list of things
 * that can be deleted — a game master who has uploaded nothing still has working
 * sheets, and so does one who has deleted everything they uploaded.
 */
function Template({ open }: { open: boolean }) {
  const [active, setActive] = useGmSetting("templateId");
  const save = useSaveSetting();
  const toast = useToast();
  const [list, setList] = useState<TemplateSummary[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { templates } = await api.get<{ templates: TemplateSummary[] }>("/api/templates");
      setList(templates);
    } catch (error) {
      toast.showError(error);
    }
  }, [toast]);

  // On every opening rather than once. The drawer is always mounted — shut, it
  // is `inert` rather than gone — so fetching on mount would ask on every page
  // load for a panel nobody opened; and a collection can have changed in the
  // other tab since the last look.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const choose = (id: string) => {
    setActive(id);
    save({ templateId: id });
  };

  /**
   * Files a chosen template, and selects it.
   *
   * Selecting it is the point: a game master who uploads a template is telling
   * us what they want their sheets to look like, and the alternative is a second
   * press that reads as the app having ignored the first. A *replacement* is the
   * exception — the same template exported again — because it may well be active
   * already, and switching their selection because they re-exported something
   * would be a surprise rather than a service.
   */
  const upload = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.set("template", file);
      const { template, replaced } = await api.postForm<
        { template: TemplateSummary; replaced: boolean }
      >("/api/templates", body);
      await load();
      if (!replaced) choose(template.id);
      toast.show(
        replaced ? `Updated “${template.name}”.` : `Added “${template.name}”.`,
        "success",
      );
    } catch (error) {
      toast.showError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (template: TemplateSummary) => {
    try {
      await api.delete(`/api/templates/${template.id}`);
      await load();
      toast.show(`Deleted “${template.name}”.`, "success");
    } catch (error) {
      toast.showError(error);
    }
  };

  const mine = list.filter((template) => !template.builtIn);

  return (
    <Setting
      id={TEMPLATE_ID}
      label="Template"
      // Nothing on the caption line: a template is named after the file it came
      // out of, and those run long. Sharing the line with the label would leave
      // it a third of the drawer to show a name in, so it takes the next line and
      // the whole width instead.
      control={null}
    >
      <select
        id={TEMPLATE_ID}
        className="select select-sm w-full"
        value={active}
        onChange={(event) => choose(event.target.value)}
      >
        {/* A list that has not arrived yet still has to hold the value the
            identity gave us, or the select would show its first option and
            read as a choice nobody made. */}
        {list.length === 0
          ? <option value={active}>Loading…</option>
          : list.map((template) => (
            <option key={template.id} value={template.id}>{template.name}</option>
          ))}
      </select>

      <p className={`text-xs ${TEXT_MUTED}`}>
        The HERO Designer export template your character sheets are drawn through.
        Sheets are built as they are opened, so a change shows on the next one.
      </p>

      {mine.length > 0
        ? (
          <ul className="space-y-1">
            {mine.map((template) => (
              <li key={template.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-xs" title={template.originalName}>
                  {template.name}
                </span>
                <IconButton
                  bare
                  danger
                  label={template.id === active
                    // The server refuses this either way; saying so before the
                    // press is the half that saves a reader the round trip.
                    ? `Your sheets are drawn with ${template.name}. Choose another one first.`
                    : `Delete ${template.name}`}
                  icon={<DeleteIcon />}
                  disabled={template.id === active}
                  onClick={() => void remove(template)}
                />
              </li>
            ))}
          </ul>
        )
        : null}

      <input
        type="file"
        accept=".hde"
        disabled={busy}
        aria-label="Upload an export template"
        className="file-input file-input-sm w-full"
        onChange={(event) => {
          const file = event.target.files?.item(0) ?? null;
          // Cleared so that choosing the same file twice — a template edited
          // between the two — is two uploads rather than one and a shrug.
          event.target.value = "";
          void upload(file);
        }}
      />
    </Setting>
  );
}

/* ------------------------------------------------------------------- drawer */

export function SettingsDrawer({
  open,
  onClose,
  showAllNpcsHeldOn = null,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Why `Show All NPCs` cannot be switched off just now, or null when it can.
   *
   * The console passes a sentence while a monster it borrowed is standing in its
   * fight; the library page never does, because it is not looking at a stage. The
   * rule itself lives on the server either way — this is only the half that tells
   * a reader before they press rather than after.
   */
  showAllNpcsHeldOn?: string | null;
}) {
  // Escape closes it, as it does every other layer in the app. Bound only while
  // it is open, so a stray Escape over the page is nobody's business.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /*
   * The slide is the collapse of this wrapper, and which way it collapses
   * depends on whether there is a sideways to give — the reasoning is the log
   * drawer's, written out there. Two things are the other way round here:
   *
   * The margin is on the left (`lg:ml-2.5`), since the page is on that side, and
   * it collapses with the rest so a shut drawer costs the page nothing.
   *
   * And below `lg:` this is a block above the page rather than below it
   * (`order-first`), even though it is last in the markup so that it lands on
   * the right once there are columns. A drawer that opened below a full page of
   * panels would be a press that visibly did nothing.
   */
  return (
    <aside
      // Named, as the log's drawer is: two complementary landmarks on one page,
      // and which is which should not be a matter of reading their contents.
      aria-label="Settings"
      // Hidden from everything, not merely from the eye: a collapsed drawer is
      // still in the document, and controls nobody can see are not ones a screen
      // reader should be reading out or a Tab should be landing in.
      aria-hidden={!open}
      inert={!open}
      className={`order-first flex flex-col overflow-hidden transition-[max-height,width,margin] duration-200 ease-out motion-reduce:transition-none lg:order-none lg:max-h-none wide:min-h-0 ${
        open
          ? "mb-2.5 max-h-[60vh] w-full lg:mb-0 lg:ml-2.5 lg:w-72 wide:w-80"
          : "mb-0 max-h-0 w-full lg:ml-0 lg:w-0"
      }`}
    >
      {/* The open width, fixed, so the text inside does not reflow line by line
          while the wrapper animates around it. `flex-1 min-h-0` is what gives
          the panel a bounded height to scroll inside, in both the phone's
          `max-h` and the wide frame's stretched column. */}
      <div className="flex min-h-0 w-full flex-1 flex-col lg:w-72 wide:w-80">
        <Panel
          title="Settings"
          scroll
          className="min-h-0 flex-1"
          actions={
            <Button
              variant="ghost"
              onClick={onClose}
              aria-label="Close settings"
              title="Close settings"
            >
              <Icon icon={faXmark} />
            </Button>
          }
        >
          <div className="space-y-5">
            <CardSize />
            <ShowAllNpcs heldOn={showAllNpcsHeldOn} />
            <Template open={open} />
          </div>
        </Panel>
      </div>
    </aside>
  );
}
