/**
 * The game master's library: campaigns and the characters filed under them, both
 * presented as cards, plus the controls for starting a session.
 */

import type { HTMLAttributes, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";
import {
  faCircleInfo,
  faCirclePlay,
  faPlay,
  faRightFromBracket,
  faScroll,
  faSquarePlus,
  faStop,
} from "@fortawesome/free-solid-svg-icons";
import {
  HERO_STAT_FIELDS,
  HERO_STAT_HINTS,
  HERO_STAT_LABELS,
  HERO_STAT_RANGES,
} from "../../lib/hero.ts";
import type { HeroStatField } from "../../lib/hero.ts";
import { compareNames } from "../../lib/names.ts";
import { splitCharacterFile, type SplitCharacter } from "../hdc.ts";
import { fitFileToCard } from "../images.ts";
import { ConnectionWarning } from "../components/ConnectionWarning.tsx";
import { useSessionSocket } from "../useSessionSocket.ts";
import { useLiveSessions } from "../useLiveSessions.ts";
import { measureTrack, useCardFit } from "../useCardFit.ts";
import { useColumnSplit } from "../useColumnSplit.ts";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { SettingsDrawer, SettingsToggle, useSettingsDrawer } from "../components/Settings.tsx";
import {
  AppPage,
  Button,
  CardPicture,
  CardFrame,
  CardWell,
  ColumnHandle,
  CARD_CAPTION_FRAMED,
  CARD_GRID,
  CARD_NAME,
  CHARACTER_DRAG,
  DeleteIcon,
  EditIcon,
  EmptyState,
  Field,
  FIELD_CAPTION,
  FileDrop,
  HAIRLINE,
  HoverCard,
  Icon,
  IconButton,
  LoadingNote,
  mergeDropProps,
  Modal,
  Panel,
  SheetIcon,
  TEXT_MUTED,
  useDropTarget,
  useFileDropTarget,
} from "../components/ui.tsx";
import { CharacterCard } from "../components/CharacterCard.tsx";
import { SheetOverlay } from "../components/SheetFrame.tsx";
import { useConfirm } from "../components/Confirm.tsx";
import { useToast } from "../components/Toast.tsx";
import type { Campaign, Character, CharacterKind, GameSession } from "../types.ts";

/** Mirrors `limits.nameMaxLength` on the server, which is what rejects a longer one. */
const NAME_MAX_LENGTH = 60;

/**
 * The character name a sheet's filename gives, since a sheet is nearly always
 * saved under the character's name and retyping it is busywork.
 *
 * The extension goes; nothing else about the filename is second-guessed. Empty
 * when the filename was nothing but an extension, which is the one case the
 * caller has to answer for — a dropped character file cannot be filed without a name, and
 * the dialog simply leaves its field alone.
 */
function characterNameFor(file: File): string {
  return file.name.replace(/\.[^.]+$/, "").trim().slice(0, NAME_MAX_LENGTH);
}

/**
 * A character added to the list where the server would have put it.
 *
 * The library arrives sorted by name, so a character filed without a reload has
 * to be filed into that order rather than onto the end. `compareNames` is the
 * order the server sent, which is the point of its being shared code.
 */
function insertByName(current: Character[], added: Character): Character[] {
  const next = [...current, added];
  return next.sort((a, b) => compareNames(a.name, b.name));
}

/* ------------------------------------------------------------------- dialogs */

/**
 * Sizes a card picture as it is chosen, so the dialog uploads the card rather
 * than the photograph.
 *
 * Both edit dialogs carry the same `Card image` field and want the same thing of
 * it. The work starts the moment the file lands, while the game master is still
 * filling the rest of the dialog in, so by the time they submit it is nearly
 * always done — but `apply` waits for it rather than settling for whatever is
 * ready, because the alternative is a picture uploaded whole for having been
 * chosen a second before the button. That is not a theoretical second: a
 * dialog whose only remaining field is the picture is submitted the instant the
 * picker closes, and the ceiling that rejects an unfitted photograph does not
 * care why it was unfitted.
 *
 * Waiting costs nothing that is not already being waited for — the dialog is on
 * `Saving…` and an upload is about to follow — and the fit itself never fails:
 * a picture it cannot decode comes back as the file it was given, for the server
 * to deal with as it always has.
 *
 * The file the fit was started from is kept beside it, the same guard the
 * character split uses: a picture chosen while the previous one is still being
 * scaled must not be uploaded as that previous one.
 */
function useCardImageFit() {
  const fitting = useRef<{ source: File; done: Promise<File> } | null>(null);

  const take = (file: File) => {
    fitting.current = { source: file, done: fitFileToCard(file) };
  };

  const apply = async (form: FormData) => {
    const chosen = form.get("card");
    const held = fitting.current;
    if (held && chosen instanceof File && chosen === held.source) {
      form.set("card", await held.done);
    }
  };

  return { take, apply };
}

function CampaignForm({
  campaign,
  onDone,
}: {
  campaign: Campaign | null;
  onDone: (campaign: Campaign) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(campaign?.name ?? "");
  const [busy, setBusy] = useState(false);
  const cardImage = useCardImageFit();

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("name", name);
    setBusy(true);
    try {
      await cardImage.apply(form);
      const result = campaign
        ? await api.patchForm<{ campaign: Campaign }>(`/api/campaigns/${campaign.id}`, form)
        : await api.postForm<{ campaign: Campaign }>("/api/campaigns", form);
      onDone(result.campaign);
    } catch (error) {
      toast.showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field
        label="Campaign name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
        hint="Campaign names are unique."
      />
      <FileDrop
        label="Card image (optional)"
        name="card"
        accept="image/png,image/jpeg,image/gif,image/webp"
        onFile={cardImage.take}
      />
      {campaign?.cardUrl ? (
        <label className={`flex items-center gap-2 text-sm ${TEXT_MUTED}`}>
          <input type="checkbox" name="removeCard" value="true" />
          Remove the current card image
        </label>
      ) : null}
      <Button variant="primary" type="submit" disabled={busy} className="w-full">
        {busy ? "Saving…" : campaign ? "Save changes" : "Create campaign"}
      </Button>
    </form>
  );
}

/**
 * A characteristic's caption, marked with an info icon on the ones that carry
 * hover text — INIT, so far. Without it the tooltip is there but invisible:
 * nobody hovers a word that looks like every other word in the row.
 *
 * The tooltip belongs to the whole field rather than to the icon (see `Field`),
 * so this is a sign that there is something to hover rather than a control of
 * its own — nothing here is focusable and the glyph is `aria-hidden`.
 */
function StatLabel({ field }: { field: HeroStatField }) {
  const label = HERO_STAT_LABELS[field];
  if (!HERO_STAT_HINTS[field]) return <>{label}</>;
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <Icon icon={faCircleInfo} className={`h-3 w-3 ${TEXT_MUTED}`} />
    </span>
  );
}

function CharacterForm({
  campaigns,
  character,
  defaultCampaignId,
  onDone,
}: {
  campaigns: Campaign[];
  character: Character | null;
  defaultCampaignId: string;
  onDone: (character: Character) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(character?.name ?? "");
  // Controlled, because a chosen sheet writes into them — see `readStatsFrom`.
  // A character being edited starts at its own numbers, a new one at zeros, which
  // is what an unfilled characteristic has always meant.
  const [stats, setStats] = useState<Record<HeroStatField, number>>(() =>
    Object.fromEntries(
      HERO_STAT_FIELDS.map((field) => [field, character?.[field] ?? 0]),
    ) as Record<HeroStatField, number>,
  );
  // What the last uploaded sheet put in the name field. Anything else in there is
  // the game master's own typing, and a second upload must not overwrite it.
  const suggested = useRef<string | null>(null);

  /**
   * Names the character, since retyping a name the file already carries is
   * busywork.
   *
   * Only into an empty field, or over a name this same mechanism put there —
   * which is also what lets the filename stand in until the file has been read
   * and then be replaced by the name inside it. The game master's own typing is
   * never overwritten, so a name typed in the moment between the two is kept.
   *
   * Through the setter rather than the rendered `name`, because the second
   * suggestion arrives after an await and the value closed over by then is the
   * one from before the first.
   */
  const suggestName = (candidate: string) => {
    const stripped = candidate.trim().slice(0, NAME_MAX_LENGTH);
    if (!stripped) return;
    setName((current) => {
      if (current !== "" && current !== suggested.current) return current;
      suggested.current = stripped;
      return stripped;
    });
  };

  /**
   * The chosen file taken apart — the character on its own, and its picture.
   *
   * Held from the moment the file is chosen, because both halves of the dialog
   * want it: the characteristics are read off it immediately, and it is what is
   * actually uploaded when the form is submitted. Splitting it twice would mean
   * decoding several megabytes twice.
   *
   * The file it was made from is kept beside it. Splitting is asynchronous, so a
   * game master who picks a second file and submits before it finishes would
   * otherwise upload the *first* character under the second one's name — and
   * both are valid files, so nothing downstream could tell.
   */
  const split = useRef<{ source: File; parts: SplitCharacter } | null>(null);

  /** The card picture, sized as it was chosen. See `useCardImageFit`. */
  const cardImage = useCardImageFit();

  /**
   * Fills the characteristics in from the character file.
   *
   * Over whatever is in the boxes, including numbers the game master typed a
   * moment ago and the ones a character being edited arrived with: choosing a
   * file is choosing what this character is, and the file is a better authority
   * on its own SPD than a box somebody filled from an older export. That is the
   * whole point of uploading a replacement.
   *
   * Worked out by the server, which has the game system's rules — the browser
   * sends the file with its portrait already taken out, so what crosses the wire
   * is tens of kilobytes rather than the megabytes the file weighs.
   *
   * It says nothing when it works. The numbers appearing in the boxes is the
   * message, and they are still the game master's to correct before saving.
   */
  const readStatsFrom = async (file: File) => {
    try {
      const parts = await splitCharacterFile(file);
      split.current = { source: file, parts };
      // What the character calls itself, over what its file is called. The
      // filename is only ever a guess at this, and a character renamed since it
      // was last exported — or exported as `Redshift (v3 final).hdc` — is filed
      // under the name on its own sheet.
      if (parts.name) suggestName(parts.name);

      const body = new FormData();
      body.set("hdc", parts.hdc);
      const { stats: found } = await api.postForm<{
        stats: Partial<Record<HeroStatField, number>>;
      }>("/api/characters/stats", body);
      if (Object.keys(found).length > 0) setStats((current) => ({ ...current, ...found }));
    } catch {
      // An unreadable file is one the upload itself is about to complain about,
      // and the boxes are still there to be typed into meanwhile.
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    // The file input still holds the file as it was chosen, portrait and all.
    // What goes up is the split of it made when it was chosen: the character on
    // its own, and its picture sized for a card, as a part the server knows not
    // to mistake for a picture the game master picked by hand.
    //
    // Only when the split is of the file that is actually in the input. If it is
    // not — a second file picked while the first was still being split — the
    // original goes up whole and the server takes it apart itself, which is
    // slower and entirely correct.
    const chosen = form.get("sheet");
    const held = split.current;
    if (held && chosen instanceof File && chosen === held.source) {
      form.set("sheet", held.parts.hdc);
      if (held.parts.portrait) form.set("sheetPortrait", held.parts.portrait);
    }


    setBusy(true);
    try {
      // And the picture chosen as a picture, which is sized the same way and for
      // the same reasons — only it needs no taking apart first.
      await cardImage.apply(form);
      const result = character
        ? await api.patchForm<{ character: Character }>(`/api/characters/${character.id}`, form)
        : await api.postForm<{ character: Character }>("/api/characters", form);
      onDone(result.character);
    } catch (error) {
      toast.showError(error);
    } finally {
      setBusy(false);
    }
  };

  // The sheet leads: uploading it is the point of the dialog, and the fields
  // below it are the filing — what this character is, where it belongs, what it
  // looks like — in the order someone answers them.
  return (
    <form onSubmit={submit} className="space-y-4">
      <FileDrop
        label={`Character file ${
          character ? "(leave empty to keep the current one)" : "(.hdc from HERO Designer)"
        }`}
        name="sheet"
        accept=".hdc"
        hint="The character sheet is drawn from this file every time it is opened, so re-exporting a character and uploading them again is all it takes to keep their sheet current. The picture inside the file becomes the character's card, and is taken out of the file rather than stored twice."
        onFile={(file) => {
          // The filename now, so the field is filled the moment a file is
          // chosen; the name inside the file a moment later, once it is read.
          suggestName(characterNameFor(file));
          void readStatsFrom(file);
        }}
      />

      <Field
        label="Name"
        name="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <label className="block">
        <span className={FIELD_CAPTION}>Type</span>
        {/* A new character is an NPC until it is said otherwise. A campaign has a
            handful of player characters, filed once at the start, and then a
            monster every session for the rest of its life — so the default that
            costs the fewest presses is the one the game master reaches for most,
            and it is the safer way round besides: an NPC mistaken for a PC is a
            character a player can claim. Editing keeps whatever the character
            already is. */}
        <select name="kind" defaultValue={character?.kind ?? "npc"} className="select w-full">
          <option value="pc">Player character</option>
          <option value="npc">Non-player character</option>
        </select>
      </label>

      <label className="block">
        <span className={FIELD_CAPTION}>Campaign</span>
        <select
          name="campaignId"
          defaultValue={character?.campaignId ?? defaultCampaignId}
          required
          className="select w-full"
        >
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </select>
      </label>

      {/*
        The HERO characteristics in a block rather than in stacked rows: they are
        short numbers and reading them across is how a character sheet prints
        them. Four to a row puts the looked-up ones on the first line — SPD, DEX,
        INIT and CON — and REC with the three spent in a fight on the second. A
        character nobody has filled in yet is all zeros, which is a legitimate
        thing to save.
      */}
      <fieldset>
        <legend className={FIELD_CAPTION}>Characteristics</legend>
        <div className="grid grid-cols-4 gap-3">
          {HERO_STAT_FIELDS.map((field) => (
            <Field
              key={field}
              label={<StatLabel field={field} />}
              title={HERO_STAT_HINTS[field]}
              name={field}
              type="number"
              inputMode="numeric"
              min={HERO_STAT_RANGES[field]?.min}
              max={HERO_STAT_RANGES[field]?.max}
              value={String(stats[field])}
              onChange={(event) =>
                setStats((current) => ({ ...current, [field]: Number(event.target.value) }))
              }
            />
          ))}
        </div>
      </fieldset>

      <FileDrop
        label="Card image (optional)"
        name="card"
        accept="image/png,image/jpeg,image/gif,image/webp"
        onFile={cardImage.take}
      />

      {/*
        Offered only when there is one to remove, as the campaign form does it.
        A picture uploaded in the same submission wins over the box being ticked,
        and so does the box over a portrait found in a new sheet — the server
        settles both, in that order.
      */}
      {character?.cardUrl ? (
        <label className={`flex items-center gap-2 text-sm ${TEXT_MUTED}`}>
          <input type="checkbox" name="removeCard" value="true" />
          Remove the current card image
        </label>
      ) : null}

      <Button variant="primary" type="submit" disabled={busy} className="w-full">
        {busy ? "Saving…" : character ? "Save changes" : "Add character"}
      </Button>
    </form>
  );
}

/** The hot keys that set a character's kind, and what each one means. */
const KIND_KEYS: Record<string, CharacterKind> = { p: "pc", n: "npc" };

/**
 * `P` and `N` on the card under the reader, which is the fastest way there is to
 * sort a freshly dropped folder of sheets into heroes and monsters.
 *
 * A sheet arrives as an NPC because that is the safer default, so a party of six
 * is six trips through the edit dialog to say what everybody already knows by
 * looking at the card. This is that, done from the card itself — the same
 * bargain the picture drop makes, and for the same reason: what a character *is*
 * is the whole of the decision, and the card is right there.
 *
 * Hung on the window rather than on the cards, because the key is pressed
 * wherever the reader last clicked and a card is not focused merely by being
 * hovered. Which card it means is the caller's business (`onAttention`).
 *
 * The listener is re-hung on every render, which is deliberate rather than
 * overlooked: `apply` closes over which card is attended to and what is in the
 * library, and both change under it. Adding and removing one window listener is
 * cheaper than the staleness a memo here would buy.
 *
 * What it deliberately does not fire on:
 *
 * - **A key with a modifier on it.** `Ctrl-P` prints, `Cmd-N` opens a window, and
 *   neither of them is about a character.
 * - **A key held down.** `event.repeat` would otherwise send a `PATCH` for every
 *   repeat of a key that says the same thing each time.
 * - **A key typed into something.** A name being typed into a box is a name, not
 *   a command, and the box is where it belongs.
 * - **A key pressed while a dialog is open.** A dialog covers the library, and a
 *   pointer that was over a card when one opened is not told it has left.
 */
function useKindKeys(apply: (kind: CharacterKind) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const kind = KIND_KEYS[event.key.toLowerCase()];
      if (!kind) return;

      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (document.querySelector("dialog[open], [role='dialog']")) return;

      // Consumed, so it reaches nothing else — a browser's own find-as-you-type
      // among them.
      event.preventDefault();
      apply(kind);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply]);
}

/**
 * A character in the library: the card, plus the picture drop the campaign cards
 * beside it also take.
 *
 * A component of its own for the same reason `CampaignCard` is — the drop target
 * is a hook, and the cards are drawn in a map. Everything else about the card
 * belongs to `CharacterCard`, which the session screens use too; only the library
 * lets a picture be dropped on one.
 */
function LibraryCharacterCard({
  character,
  onOpen,
  flipped,
  onAttention,
  onPicture,
  dragProps,
  actions,
}: {
  character: Character;
  onOpen: () => void;
  /** Whether this is the card currently turned over. */
  flipped: boolean;
  /** The card is the one the pointer or the keyboard is on — see `useKindKeys`. */
  onAttention: (attending: boolean) => void;
  onPicture: (file: File) => void;
  dragProps: HTMLAttributes<HTMLElement> & { draggable?: boolean };
  actions: ReactNode;
}) {
  const { over, dropProps } = useFileDropTarget((files) => {
    const file = files.item(0);
    if (file) onPicture(file);
  });

  return (
    <CharacterCard
      character={character}
      onOpen={onOpen}
      flippable
      flipped={flipped}
      onAttention={onAttention}
      dragProps={dragProps}
      dropProps={dropProps}
      inviting={over}
      actions={actions}
    />
  );
}

/* ---------------------------------------------------------------------- page */

/**
 * One line in "sessions in progress".
 *
 * It opens the session's socket so the player count is live: the server
 * republishes the session whenever anyone joins, leaves, or is kicked, and the
 * count comes from that rather than from the list, which is only as fresh as the
 * last time the page loaded. Until the first snapshot arrives — and if the socket
 * drops — the count from the list stands in.
 */
function SessionRow({
  session,
  onOpen,
  onEnd,
}: {
  session: GameSession;
  onOpen: () => void;
  onEnd: () => void;
}) {
  const { snapshot } = useSessionSocket(session.id);
  const playerCount = snapshot?.players.length ?? session.playerCount;
  const turn = snapshot?.session.turn ?? session.turn;

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">
        {session.campaignName}
        <span className={`ml-2 text-xs ${TEXT_MUTED}`}>
          turn {turn} ·{" "}
          {playerCount === 0
            ? "nobody has joined"
            : `${playerCount} player${playerCount === 1 ? "" : "s"}`}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="dangerGhost" onClick={onEnd}>
          <Icon icon={faStop} /> End
        </Button>
        <Button onClick={onOpen}>
          <Icon icon={faPlay} /> Open
        </Button>
      </div>
    </div>
  );
}

/**
 * A campaign in the library, and the thing a character is refiled by being dropped
 * onto it.
 *
 * It is a component of its own rather than markup inside the map because the drop
 * target is a hook. `takes` is the character that would move if it were let go here
 * — null when nothing is being dragged, and null on the card of the campaign the
 * character is already in, so its own campaign never invites a move that would do
 * nothing.
 *
 * The drop cue is a ring with an offset, which is a different shape from both the
 * selection ring this card may already be wearing and the one the character panel
 * draws for a file, so the three never read as each other.
 */
function CampaignCard({
  campaign,
  selected,
  onSelect,
  onEdit,
  onDelete,
  takes,
  onTake,
  onPicture,
}: {
  campaign: Campaign;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  takes: Character | null;
  onTake: (character: Character) => void;
  onPicture: (file: File) => void;
}) {
  const { over, dropProps } = useDropTarget(CHARACTER_DRAG, () => takes && onTake(takes));
  const { over: fileOver, dropProps: fileDrop } = useFileDropTarget((files) => {
    const file = files.item(0);
    if (file) onPicture(file);
  });
  const inviting = over && takes !== null;

  // The campaign whose characters are on the panel, lit like a card that is in
  // play rather than merely outlined.
  //
  // daisyUI's `aura` is a wrapper that paints behind whatever it holds, so this
  // is a `div` around the card rather than a class on it. Three things make it
  // sit right in the grid.
  //
  // `block`, because the component is `inline-block` and an inline box would sit
  // on the text baseline with a descender's gap under it.
  //
  // A wider band than the component's own. Every size daisyUI ships is a hairline
  // — `aura-xl` is four pixels — and a hairline is lost behind a card whose
  // artwork is already a printed gold frame. 6px is wide enough to read as a glow
  // around this card rather than a highlight on its edge, and still leaves most
  // of the grid's `gap-4` between it and the card beside it. Only one card is
  // ever lit, so the spill is one-sided.
  //
  // And the negative margin, which is exactly that padding pulled back out again.
  // Without it the lit card would be twelve pixels narrower than every card
  // beside it — the aura would take the difference out of a fixed grid track —
  // and a row of cards that change size as they are picked is worse than no glow
  // at all. Pulled back, the glow spills into the gap instead.
  const lit = (card: ReactNode) =>
    selected
      ? (
        <div className="aura aura-gold block -m-1.5 [--aura-padding:0.375rem]">{card}</div>
      )
      : card;

  return lit(
    // The picture used to carry a full-bleed button of its own; `HoverCard`'s
    // zones sit over it, so the whole card is the select control instead. The
    // ring stays out on the frame rather than on the tile: it is the answer to
    // "may this campaign take what you are dragging", which is about the slot the
    // card sits in rather than about the card, and `tests/e2e.test.ts` reads it
    // off the `<article>`.
    <HoverCard
      {...mergeDropProps(takes ? dropProps : null, fileDrop)}
      label={`Select ${campaign.name}`}
      onClick={onSelect}
      pressed={selected}
      // A ring for one thing only: "may this campaign take what you are
      // dragging". Being selected used to draw a fainter ring in the same colour
      // and it is the aura's to say now — two answers to one question, in colours
      // that did not love each other.
      className={
        inviting ? "rounded-xl ring-2 ring-primary ring-offset-2 ring-offset-base-200" : ""
      }
      cardClassName={`${inviting || selected ? "border-primary" : HAIRLINE} bg-base-100`}
      actions={
        <>
          {/* `bare` on both, exactly as the character cards below: glyphs alone,
              so they can sit into the corner of the picture the frame leaves. */}
          <IconButton bare label={`Edit ${campaign.name}`} icon={<EditIcon />} onClick={onEdit} />
          <IconButton
            bare
            label={`Delete ${campaign.name}`}
            icon={<DeleteIcon />}
            danger
            onClick={onDelete}
          />
        </>
      }
    >
      <CardWell inviting={fileOver}>
        <CardPicture src={campaign.cardUrl} icon={faScroll} draggable={false} />
      </CardWell>

      {/* Over the picture, under the name, exactly as on a character card — the
          campaign art is cut to the same shape, so the same boxes fit it. */}
      <CardFrame kind="campaign" />

      {/* Light-theme ink on the frame's pale panel, as on a character card. */}
      <div className={CARD_CAPTION_FRAMED} data-theme="winter">
        <h3 className={CARD_NAME}>{campaign.name}</h3>
      </div>
    </HoverCard>,
  );
}

export function GmLibrary({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  // Fetched with everything else below, then kept current by the library socket.
  const { sessions, setSessions } = useLiveSessions();
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [campaignDialog, setCampaignDialog] = useState<{ open: boolean; editing: Campaign | null }>(
    { open: false, editing: null },
  );
  const [characterDialog, setCharacterDialog] = useState<{
    open: boolean;
    editing: Character | null;
  }>({ open: false, editing: null });
  /** Sheets from the current drop still to be filed, for the note the panel shows. */
  const [filing, setFiling] = useState(0);
  const [previewing, setPreviewing] = useState<Character | null>(null);
  /**
   * The character whose card is turned over, if one is.
   *
   * One at a time. A card is turned over to read a number off the back of it,
   * which is a thing done to one card rather than to the library — and a wall of
   * cards showing their backs is a wall with no pictures on it.
   */
  const [flippedId, setFlippedId] = useState<string | null>(null);
  /**
   * The character the reader is on — under the pointer, or holding the keyboard
   * focus — which is the one the kind hot keys mean. Null when they are on none.
   *
   * A ref rather than state, for two reasons that point the same way. Nothing is
   * *drawn* differently because the pointer is on a card — the tilt and the hover
   * border are the stylesheet's — so a state update here would re-render the
   * whole library on every card the pointer crosses, for nothing.
   *
   * And it would be a re-render that can arrive too late. React gives a pointer
   * crossing a boundary a lower priority than a keystroke, so on a busy page the
   * hover can still be uncommitted when the key lands a few milliseconds later —
   * and the key would then be read against the card the pointer was on before.
   * Written straight to a ref, "which card" is true the instant the pointer
   * arrives, which is what a hot key needs it to be.
   */
  const attendedId = useRef<string | null>(null);
  const [settingsOpen, toggleSettings] = useSettingsDrawer();
  /**
   * The character being dragged, if one is.
   *
   * `dataTransfer` carries the marker type and the id, but during `dragover` the
   * payload is unreadable — and a campaign card has to know, while the drag is
   * still in the air, whether letting go here would move anything at all.
   */
  const [dragging, setDragging] = useState<Character | null>(null);

  // The campaigns column: trimmed to whole card columns by default, the leftover
  // going to the characters beside it (`useCardFit`), and draggable to a width of
  // the reader's own (`useColumnSplit`), which stands the fit down for as long as
  // that width is in force.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // What the handle needs to know about cards: the panel may not be dragged
  // narrower than one whole card, and a key-press moves it by one. Measured off
  // the grid on screen rather than chosen here, which is what keeps both of them
  // right at whatever size the deployment draws a card.
  const measureCards = useCallback((panel: HTMLElement) => {
    const grid = gridRef.current;
    const measured = grid ? measureTrack(panel, grid) : null;
    return (
      measured && {
        min: measured.track + measured.overhead,
        step: measured.track + measured.gap,
      }
    );
  }, []);

  const { panelRef, manual, handleProps } = useColumnSplit({
    containerRef,
    variable: "--campaign-col",
    measure: measureCards,
  });
  useCardFit({
    count: campaigns.length,
    enabled: !manual,
    variable: "--campaign-col",
    refs: { containerRef, panelRef, gridRef },
  });

  const load = useCallback(async () => {
    try {
      const [campaignData, characterData, sessionData] = await Promise.all([
        api.get<{ campaigns: Campaign[] }>("/api/campaigns"),
        api.get<{ characters: Character[] }>("/api/characters"),
        api.get<{ sessions: GameSession[] }>("/api/sessions"),
      ]);
      setCampaigns(campaignData.campaigns);
      setCharacters(characterData.characters);
      setSessions(sessionData.sessions);
      setSelectedCampaignId((current) => current ?? campaignData.campaigns[0]?.id ?? null);
    } catch (error) {
      toast.showError(error);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);


  // Having invited a drag onto the page, catch the ones that miss: a file dropped
  // anywhere else would otherwise be opened by the browser, throwing the library
  // away to show a character sheet as a bare page.
  // A character dragged onto nothing in particular is left alone, so the browser
  // shows a no-drop cursor over everything that isn't a campaign and the gesture
  // simply ends where it started.
  useEffect(() => {
    const swallow = (event: Event) => {
      const transfer = (event as globalThis.DragEvent).dataTransfer;
      if (transfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  const selectedCampaign = campaigns.find((campaign) => campaign.id === selectedCampaignId) ?? null;
  const visibleCharacters = characters.filter(
    (character) => character.campaignId === selectedCampaignId,
  );
  const activeSessions = sessions.filter((session) => session.status === "active");
  // A campaign runs one session at a time, so the button that would start a
  // second one opens the first instead.
  const runningHere = activeSessions.find(
    (session) => session.campaignId === selectedCampaignId,
  );

  /**
   * Files character files dropped on the character panel as characters, there and then.
   *
   * Everything the add dialog would have asked for is already known: the panel
   * only exists while a campaign is selected, the file names the character the
   * way the dialog's own name field would have, and a dropped character is an NPC
   * until it is edited — the same default the dialog offers, and for the same
   * reason: a folder of character files dropped on a campaign is a folder of monsters far
   * more often than it is a party. So the dialog would have been a form with nothing left
   * to fill in, and a folder of characters can be filed by dropping the folder.
   *
   * A name the campaign already has is that character being *updated*, not a
   * collision. Re-exporting from HERO Designer and dropping the file back is how
   * a character is kept current, and the alternative was finding each character,
   * opening its dialog and picking the file by hand. So the file replaces the
   * stored one, the characteristics inside it replace the character's, and the
   * portrait inside it replaces the picture — the dropped file is the whole of
   * the intent, and there is nothing in the gesture that could mean "but keep the
   * old picture". What it leaves alone is the kind: a monster dropped over a hero
   * does not make that hero a monster, and the dialog is where that is decided.
   *
   * Matched on the name the way the server matches it — its `COLLATE NOCASE`
   * against `sensitivity: "base"` here, the same stand-in `insertByName` uses.
   * The list is this page's own, so a character added in another tab since it
   * loaded is not in it; that file takes the create path and gets the conflict it
   * always did, which a reload puts right.
   *
   * Every dropped file is handled one request at a time — each one is taken
   * apart and its picture re-encoded, and a dozen of those at once is a dozen
   * image decodes racing each other for no gain. Each character appears as it lands,
   * in name order, so the panel fills in as the batch goes. One failure is
   * reported and the rest carry on.
   */
  const fileSheets = async (files: FileList, campaign: Campaign) => {
    const dropped = Array.from(files);
    setFiling(dropped.length);
    let added = 0;
    let updated = 0;
    for (const file of dropped) {
      try {
        // Split before uploading, as the dialog does: the picture goes as its
        // own part, sized for a card, and what is left of the character file is
        // a fraction of what was dropped. It also comes back with the name the
        // character gives itself, which is why this happens before the character
        // is looked for rather than after.
        const parts = await splitCharacterFile(file);

        // What the character calls itself, over what its file is called — and so
        // also what decides whether this is a character the campaign already has.
        // A file exported under a working filename updates the character whose
        // name is inside it, which is the one it is.
        const name = parts.name?.slice(0, NAME_MAX_LENGTH) ?? characterNameFor(file);
        if (!name) {
          throw new Error(`We couldn't work out a name for “${file.name}”.`);
        }

        const existing = characters.find(
          (entry) =>
            entry.campaignId === campaign.id &&
            entry.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0,
        );

        const form = new FormData();
        form.set("sheet", parts.hdc);
        if (parts.portrait) form.set("sheetPortrait", parts.portrait);

        if (existing) {
          // Neither the name nor the campaign, which are what found this
          // character in the first place — and sending either would put the
          // update through the server's own name check for no reason.
          form.set("portraitFromSheet", "true");
          const { character } = await api.patchForm<{ character: Character }>(
            `/api/characters/${existing.id}`,
            form,
          );
          setCharacters((current) =>
            current.map((entry) => (entry.id === character.id ? character : entry)),
          );
          updated += 1;
        } else {
          form.set("campaignId", campaign.id);
          form.set("kind", "npc");
          form.set("name", name);
          const { character } = await api.postForm<{ character: Character }>(
            "/api/characters",
            form,
          );
          setCharacters((current) => insertByName(current, character));
          added += 1;
        }
      } catch (error) {
        toast.showError(error);
      } finally {
        setFiling((remaining) => remaining - 1);
      }
    }

    // Said separately, because they are different things to have happened: a
    // batch that quietly updated ten characters when the game master meant to add
    // ten is worth noticing before the evening rather than during it.
    const done = [
      added > 0 ? `Added ${added} character${added === 1 ? "" : "s"}.` : null,
      updated > 0 ? `Updated ${updated} character${updated === 1 ? "" : "s"}.` : null,
    ].filter(Boolean).join(" ");
    if (done) toast.show(done, "success");
  };

  const { over: sheetOver, dropProps: sheetDrop } = useFileDropTarget((files) => {
    if (selectedCampaign) void fileSheets(files, selectedCampaign);
  });

  /**
   * Ends a session without opening its console.
   *
   * Named by campaign rather than "this session": the library can be showing
   * several at once, and the console's wording would leave the game master
   * guessing which one they are about to close.
   *
   * Nothing is reloaded afterwards — ending broadcasts the session list to the
   * library socket, so the row goes on its own.
   */
  const endSession = async (session: GameSession) => {
    const ok = await confirm({
      title: `End the session on “${session.campaignName}”?`,
      body: "The code stops working and everyone is disconnected.",
      confirmLabel: "End session",
    });
    if (!ok) return;
    try {
      await api.post(`/api/sessions/${session.id}/end`);
      toast.show("Session ended.", "success");
    } catch (error) {
      toast.showError(error);
    }
  };

  const deleteCampaign = async (campaign: Campaign) => {
    const ok = await confirm({
      title: `Delete “${campaign.name}”?`,
      body: "Its characters and sessions will be deleted too.",
      confirmLabel: "Delete campaign",
    });
    if (!ok) return;
    try {
      await api.delete(`/api/campaigns/${campaign.id}`);
      setSelectedCampaignId(null);
      toast.show(`Deleted “${campaign.name}”.`, "success");
      await load();
    } catch (error) {
      toast.showError(error);
    }
  };

  const deleteCharacter = async (character: Character) => {
    const ok = await confirm({
      title: `Delete “${character.name}”?`,
      confirmLabel: "Delete character",
    });
    if (!ok) return;
    try {
      await api.delete(`/api/characters/${character.id}`);
      setCharacters((current) => current.filter((entry) => entry.id !== character.id));
      toast.show(`Deleted “${character.name}”.`, "success");
    } catch (error) {
      toast.showError(error);
    }
  };

  /**
   * Refiles a character under another campaign, which is what a drop onto a
   * campaign card means.
   *
   * The selection stays where it is: the character simply leaves the list, so a
   * run of characters can be filed out of one campaign without re-selecting it
   * between each. The server may refuse — a name the destination already has, or
   * a character still playing in a running session — and says why in a message
   * the toast can show as it stands.
   */
  const moveCharacter = async (character: Character, campaign: Campaign) => {
    const form = new FormData();
    form.set("campaignId", campaign.id);
    try {
      const { character: moved } = await api.patchForm<{ character: Character }>(
        `/api/characters/${character.id}`,
        form,
      );
      setCharacters((current) => current.map((entry) => (entry.id === moved.id ? moved : entry)));
      toast.show(`Moved “${moved.name}” to “${campaign.name}”.`, "success");
    } catch (error) {
      toast.showError(error);
    }
  };

  /**
   * Sets a card's picture from a file dropped straight onto it.
   *
   * The same `PATCH` the edit dialog sends, with only the picture in it, so the
   * server applies it exactly as it would from the form — and answers with the
   * updated record, which is what goes back into the list. Filing a picture is
   * the one edit worth doing without opening a dialog at all: the card is right
   * there, and what it should look like is the whole of the decision.
   *
   * Nothing checks the file first. `accept` filters the picker, and the server
   * identifies an image by its content rather than its name, so a sheet dropped
   * on a card is refused there and the refusal is what the toast shows — and a
   * file the fit cannot decode is handed on whole, which is the same path.
   *
   * Sized on the way, as the dialogs size theirs (`useCardImageFit`). Awaited
   * here rather than started earlier because there is nowhere earlier: a drop is
   * the whole gesture, and the picture is wanted in the same breath. It is a
   * decode and an encode of one image, against an upload of the megabytes it
   * would otherwise have been.
   */
  const setCardImage = async (file: File, target: Campaign | Character) => {
    const form = new FormData();
    form.set("card", await fitFileToCard(file));
    const character = "campaignId" in target;
    try {
      if (character) {
        const { character: updated } = await api.patchForm<{ character: Character }>(
          `/api/characters/${target.id}`,
          form,
        );
        setCharacters((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry))
        );
      } else {
        const { campaign: updated } = await api.patchForm<{ campaign: Campaign }>(
          `/api/campaigns/${target.id}`,
          form,
        );
        setCampaigns((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry))
        );
      }
      toast.show(`Updated the picture for “${target.name}”.`, "success");
    } catch (error) {
      toast.showError(error);
    }
  };

  /**
   * Makes a character a PC or an NPC, from the hot key on its card.
   *
   * The same `PATCH` the edit dialog sends, carrying the one field — so the
   * server applies it exactly as it would from the form, and answers with the
   * record that goes back into the list.
   *
   * It says nothing when it works. The card redrawing itself in the other frame
   * — new artwork, and the foil arriving or leaving with it — is the whole of the
   * answer, and a toast on top of a change the reader is already looking at is
   * one more thing to dismiss while sorting a folder of characters a key at a time.
   * A failure still speaks, because that is the case where nothing visible
   * happens.
   *
   * A character that is already that kind is left alone. The key says what the
   * character is rather than toggling it, so pressing it twice is not a mistake
   * — it is the same instruction twice.
   */
  const setKind = async (character: Character, kind: CharacterKind) => {
    if (character.kind === kind) return;
    const form = new FormData();
    form.set("kind", kind);
    try {
      const { character: updated } = await api.patchForm<{ character: Character }>(
        `/api/characters/${character.id}`,
        form,
      );
      setCharacters((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry))
      );
    } catch (error) {
      toast.showError(error);
    }
  };

  useKindKeys((kind) => {
    // The character is looked up rather than remembered whole: the card may have
    // been edited since the pointer arrived on it, and a hot key should change
    // what the card is currently showing. It is looked up in the *visible* list,
    // so a key can only ever mean a card that is on the screen.
    const character = visibleCharacters.find((entry) => entry.id === attendedId.current);
    if (character) void setKind(character, kind);
  });

  const startSession = async () => {
    if (!selectedCampaign) return;
    try {
      const result = await api.postJson<{ session: GameSession }>("/api/sessions", {
        campaignId: selectedCampaign.id,
      });
      navigate(`/gm/sessions/${result.session.id}`);
    } catch (error) {
      toast.showError(error);
    }
  };

  if (loading) {
    return <LoadingNote>Loading your library…</LoadingNote>;
  }

  return (
    <AppPage>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Your library</h1>
          <p className={`text-sm ${TEXT_MUTED}`}>Signed in as {email}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Every socket this page holds — the session list's, and one for each
              session in progress — reports into this one icon. */}
          <ConnectionWarning />
          <ThemeToggle />
          {/* Between the theme and the sign-out, in the corner its drawer comes
              out of — the same place, and the same gear, as on the console. */}
          <SettingsToggle open={settingsOpen} onToggle={toggleSettings} />
          <Button onClick={onSignOut}>
            <Icon icon={faRightFromBracket} /> Sign out
          </Button>
        </div>
      </header>

      {/*
        The drawer pushes the library aside rather than covering it, exactly as
        the log does on the console: this row is the push. Closed it has no
        width, so the column below is the whole of the row and the page is
        exactly what it was before the drawer existed.
      */}
      <div className="flex flex-col lg:flex-row lg:items-start wide:min-h-0 wide:flex-1 wide:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 wide:min-h-0">
          {activeSessions.length > 0 ? (
            <Panel title={`Sessions in progress (${activeSessions.length})`} className="shrink-0">
              <ul className="space-y-2">
                {activeSessions.map((session) => (
                  <li key={session.id}>
                    <SessionRow
                      session={session}
                      onOpen={() => navigate(`/gm/sessions/${session.id}`)}
                      onEnd={() => void endSession(session)}
                    />
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <div
            ref={containerRef}
            // Three tracks rather than two: the handle is the middle one, and it is the
            // gutter as well as the control, which is why there is no `gap` any more —
            // it is exactly as wide as the gap it replaced.
            className="space-y-3 wide:grid wide:min-h-0 wide:flex-1 wide:grid-cols-[var(--campaign-col)_auto_minmax(0,1.4fr)] wide:space-y-0"
          >
            <Panel
              ref={panelRef}
              title="Campaigns"
              scroll
              actions={
                <Button
                  variant="primary"
                  onClick={() => setCampaignDialog({ open: true, editing: null })}
                >
                  <Icon icon={faSquarePlus} /> New
                </Button>
              }
            >
              {campaigns.length === 0 ? (
                <EmptyState>No campaigns yet. Create one to get started.</EmptyState>
              ) : (
                <div ref={gridRef} className={CARD_GRID}>
                  {campaigns.map((campaign) => (
                    <CampaignCard
                      key={campaign.id}
                      campaign={campaign}
                      selected={campaign.id === selectedCampaignId}
                      onSelect={() => setSelectedCampaignId(campaign.id)}
                      onEdit={() => setCampaignDialog({ open: true, editing: campaign })}
                      onDelete={() => void deleteCampaign(campaign)}
                      takes={dragging && dragging.campaignId !== campaign.id ? dragging : null}
                      onTake={(character) => void moveCharacter(character, campaign)}
                      onPicture={(file) => void setCardImage(file, campaign)}
                    />
                  ))}
                </div>
              )}
            </Panel>

            {/* Between the two panels whether or not one is chosen, so the split does
                not move as campaigns are selected and deselected. */}
            <ColumnHandle {...handleProps} label="Resize the campaigns column" />

            {selectedCampaign ? (
              <Panel
                scroll
                {...sheetDrop}
                // A ring rather than a border or a background tint: those would fight
                // the panel's own `border-base-300` and `bg-base-100` for the same
                // property, and which wins is down to stylesheet order.
                className={sheetOver ? "ring-2 ring-primary" : ""}
                title={`Characters in ${selectedCampaign.name}`}
                actions={
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      onClick={() => setCharacterDialog({ open: true, editing: null })}
                    >
                      <Icon icon={faSquarePlus} /> Add
                    </Button>
                    {runningHere ? (
                      <Button onClick={() => navigate(`/gm/sessions/${runningHere.id}`)}>
                        <Icon icon={faPlay} /> Open
                      </Button>
                    ) : (
                      <Button onClick={() => void startSession()}>
                        <Icon icon={faCirclePlay} /> Start
                      </Button>
                    )}
                  </div>
                }
              >
                {/*
                  A drop files its sheets one request at a time, and each card appears
                  as its sheet lands, so the line says what is still to come rather
                  than covering the panel with a spinner. `aria-live` because the
                  cards arriving underneath it are the only other announcement.
                */}
                {filing > 0 ? (
                  <p
                    className={`flex items-center gap-3 pb-3 text-sm ${TEXT_MUTED}`}
                    aria-live="polite"
                  >
                    <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                    {filing === 1 ? "Filing 1 character…" : `Filing ${filing} characters…`}
                  </p>
                ) : null}

                {visibleCharacters.length === 0 && filing === 0 ? (
                  <EmptyState>
                    No characters in this campaign yet. Drop HTML sheets here to file them, or add
                    one with the button above.
                  </EmptyState>
                ) : (
                  <div className={CARD_GRID}>
                    {visibleCharacters.map((character) => (
                      <LibraryCharacterCard
                        key={character.id}
                        character={character}
                        // Pressing the card turns it over. The sheet it used to
                        // open has its own control in the corner, so nothing has
                        // been taken away — it has stopped being what the whole
                        // card does.
                        onOpen={() =>
                          setFlippedId((current) => (current === character.id ? null : character.id))
                        }
                        flipped={flippedId === character.id}
                        onAttention={(attending) => {
                          // Only this card may clear the mark, and only while it
                          // still holds it: the pointer leaves one card by
                          // arriving on the next, and the two fire in that order.
                          if (attending) attendedId.current = character.id;
                          else if (attendedId.current === character.id) attendedId.current = null;
                        }}
                        onPicture={(file) => void setCardImage(file, character)}
                        dragProps={{
                          draggable: true,
                          onDragStart: (event) => {
                            event.dataTransfer.setData(CHARACTER_DRAG, character.id);
                            event.dataTransfer.effectAllowed = "move";
                            setDragging(character);
                          },
                          onDragEnd: () => setDragging(null),
                        }}
                        actions={
                          <>
                            {/* `bare` on all three: glyphs alone, so they can sit into
                                the corner of the picture. The campaign cards above are
                                drawn the same way. */}
                            <IconButton
                              bare
                              label={`View ${character.name}'s sheet`}
                              icon={<SheetIcon />}
                              onClick={() => setPreviewing(character)}
                            />
                            <IconButton
                              bare
                              label={`Edit ${character.name}`}
                              icon={<EditIcon />}
                              onClick={() => setCharacterDialog({ open: true, editing: character })}
                            />
                            <IconButton
                              bare
                              label={`Delete ${character.name}`}
                              icon={<DeleteIcon />}
                              danger
                              onClick={() => void deleteCharacter(character)}
                            />
                          </>
                        }
                      />
                    ))}
                  </div>
                )}
              </Panel>
            ) : null}
          </div>
        </div>

        <SettingsDrawer open={settingsOpen} onClose={toggleSettings} />
      </div>

      {campaignDialog.open ? (
        <Modal
          title={campaignDialog.editing ? "Edit campaign" : "New campaign"}
          onClose={() => setCampaignDialog({ open: false, editing: null })}
        >
          <CampaignForm
            campaign={campaignDialog.editing}
            onDone={async (campaign) => {
              setCampaignDialog({ open: false, editing: null });
              setSelectedCampaignId(campaign.id);
              await load();
            }}
          />
        </Modal>
      ) : null}

      {characterDialog.open && selectedCampaign ? (
        <Modal
          title={characterDialog.editing ? "Edit character" : "Add character"}
          onClose={() => setCharacterDialog({ open: false, editing: null })}
          dismissable
        >
          <CharacterForm
            campaigns={campaigns}
            character={characterDialog.editing}
            defaultCampaignId={selectedCampaign.id}
            onDone={async () => {
              setCharacterDialog({ open: false, editing: null });
              await load();
            }}
          />
        </Modal>
      ) : null}

      {previewing ? (
        <SheetOverlay
          src={previewing.sheetUrl}
          title={previewing.name}
          onClose={() => setPreviewing(null)}
        />
      ) : null}
    </AppPage>
  );
}
