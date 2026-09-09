/**
 * The player's view of a session.
 *
 * Two panels, as the spec asks: everyone who has joined, and every active
 * character in initiative order with the player each one belongs to. Both update
 * live — a character the game master adds or removes, a reorder, or a change of
 * turn all arrive over the socket without a refresh.
 *
 * A player who hasn't picked a character yet is asked to choose one first.
 *
 * When the turn reaches this player's character they get a toast and a chime,
 * since a table is a room full of distractions and the highlighted row alone is
 * easy to miss.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { compareNames } from "../../lib/names.ts";
import { playDing } from "../ding.ts";
import { useSessionSocket } from "../useSessionSocket.ts";
import { useColumnSplit } from "../useColumnSplit.ts";
import {
  AppPage,
  bareIcon,
  Button,
  CARD_CAPTION_FRAMED,
  CARD_GRID,
  CARD_NAME,
  CardFrame,
  CardPicture,
  CardWell,
  ColumnHandle,
  HoverCard,
  CharacterThumb,
  EmptyState,
  Icon,
  LoadingNote,
  Panel,
  SURFACE,
  TEXT_MUTED,
} from "../components/ui.tsx";
import { ConnectionWarning } from "../components/ConnectionWarning.tsx";
import { InitiativeList, stageLabel } from "../components/InitiativeList.tsx";
import { LogDrawer, LogToggle, useLogDrawer } from "../components/EventLog.tsx";
import { SegmentFilterToggle, useSegmentFilter } from "../components/SegmentFilter.tsx";
import { StatLine } from "../components/StatLine.tsx";
import { VitalActions, Vitals, type VitalsPatch } from "../components/Vitals.tsx";
import { faOctagon, faRightFromBracket, faShieldHalved } from "@fortawesome/free-solid-svg-icons";
import { TurnControls } from "../components/TurnControls.tsx";
import { SheetOverlay } from "../components/SheetFrame.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { useToast } from "../components/Toast.tsx";
import {
  StatusTagButton,
  StatusTagPicker,
  StatusTagPills,
} from "../components/StatusTags.tsx";
import type { Snapshot } from "../types.ts";

function Notice({ title, body, onLeave }: { title: string; body: string; onLeave: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className={`max-w-md p-6 text-center shadow-sm ${SURFACE}`}>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className={`mt-2 text-sm ${TEXT_MUTED}`}>{body}</p>
        <Button variant="primary" onClick={onLeave} className="mt-5">
          Back to the start
        </Button>
      </div>
    </div>
  );
}

export function PlayerSession({
  sessionId,
  playerId,
  playerName,
  onLeave,
}: {
  sessionId: string;
  playerId: string;
  playerName: string;
  onLeave: () => void;
}) {
  const toast = useToast();
  // Anything the server wants said out loud here reaches this screen as a toast.
  // Green unless the server says otherwise: the Post-Segment 12 Recovery and the
  // turn passing to your character are both the fight going well, and a notice
  // that is not — a character stunned by a hit — sends the tone to say so.
  const { snapshot, connection, applySnapshot } = useSessionSocket(
    sessionId,
    (message, tone) => toast.show(message, tone ?? "success"),
  );
  const [claiming, setClaiming] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [taggingOpen, setTaggingOpen] = useState(false);
  const [dropped, setDropped] = useState(false);
  const [showActingOnly, toggleSegmentFilter] = useSegmentFilter(sessionId);
  const [logOpen, toggleLog] = useLogDrawer(sessionId);

  // The two columns start at the shares the screen has always used and can be
  // dragged to any others. One boundary, so one split: it sizes the column to its
  // left and the scene beside it takes what that column gives up.
  const columnsRef = useRef<HTMLDivElement | null>(null);
  const mineSplit = useColumnSplit<HTMLDivElement>({
    containerRef: columnsRef,
    variable: "--player-mine",
  });

  /**
   * A player who is away long enough is removed from the session, and a removed
   * player's socket is refused rather than told why. Without this, a laptop
   * opened again after an hour would retry behind "Reconnecting…" forever, so
   * while the socket is away we ask who we are: an answer that is no longer this
   * player means the seat is gone and there is nothing to reconnect to.
   */
  useEffect(() => {
    if (connection !== "reconnecting") return;

    const check = async () => {
      try {
        const identity = await api.get<{ kind: string }>("/api/auth/me");
        if (identity.kind !== "player") setDropped(true);
      } catch {
        // Offline, or the server is down. Either way the socket keeps trying.
      }
    };

    const timer = setInterval(() => void check(), 5000);
    return () => clearInterval(timer);
  }, [connection]);

  // Identifies this player's turn, changing again if the order comes back round
  // to them — with one character in the scene the id alone would never change.
  //
  // Keyed on the slot and on where the clock is, so a character with two phases
  // in one turn is announced for each of them — a SPD 12 hero would otherwise be
  // chimed at once and then sit through eleven silent segments of their own.
  const myTurnKey = (() => {
    if (!snapshot) return null;
    const claimed =
      snapshot.players.find((player) => player.id === playerId)?.claimedCharacterId ?? null;
    const active = snapshot.session.activeSlotId;
    if (!claimed || !active) return null;
    const mine = snapshot.characters.some(
      (character) => character.id === active && character.characterId === claimed,
    );
    return mine ? `${active}#${snapshot.session.turn}#${snapshot.session.segment}` : null;
  })();

  // `undefined` until the first snapshot lands: arriving mid-turn is not a change,
  // and neither is the snapshot a reconnect replays.
  const announcedTurn = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!snapshot) return;
    const previous = announcedTurn.current;
    announcedTurn.current = myTurnKey;
    if (previous === undefined || !myTurnKey || myTurnKey === previous) return;

    toast.show("It's your turn!", "success");
    void playDing();
  }, [snapshot, myTurnKey, toast]);

  if (connection === "ended") {
    return (
      <Notice
        title="The session has ended"
        body="Your game master closed this session. The code will no longer work."
        onLeave={onLeave}
      />
    );
  }

  if (dropped) {
    return (
      <Notice
        title="You were away too long"
        body="Your seat was given up while you were disconnected. Join again with the same code — your game master can hand your character back."
        onLeave={onLeave}
      />
    );
  }

  if (connection === "kicked") {
    return (
      <Notice
        title="You were removed from the session"
        body="Your game master removed you. Ask them for a new code if this was a mistake."
        onLeave={onLeave}
      />
    );
  }

  if (!snapshot) {
    return <LoadingNote>Connecting to the table…</LoadingNote>;
  }

  const me = snapshot.players.find((player) => player.id === playerId) ?? null;
  const myCharacterId = me?.claimedCharacterId ?? null;
  const myCharacter =
    snapshot.characters.find((character) => character.characterId === myCharacterId) ?? null;

  /**
   * What this player's character has left. Only ever their own: the server
   * checks that too, since a screen is not where a rule like that lives.
   */
  const setVitals = async (slotId: string, patch: VitalsPatch) => {
    try {
      const { snapshot: next } = await api.patchJson<{ snapshot: Snapshot }>(
        `/api/sessions/${sessionId}/stage/${slotId}/vitals`,
        patch,
      );
      applySnapshot(next);
    } catch (error) {
      toast.showError(error);
    }
  };

  /** A Recovery for this player's own character; the totals are the server's. */
  const recover = async (slotId: string) => {
    try {
      const { snapshot: next } = await api.post<{ snapshot: Snapshot }>(
        `/api/sessions/${sessionId}/stage/${slotId}/recover`,
      );
      applySnapshot(next);
    } catch (error) {
      toast.showError(error);
    }
  };

  /** A rest for this player's own character: END and STUN back to full. */
  const rest = async (slotId: string) => {
    try {
      const { snapshot: next } = await api.post<{ snapshot: Snapshot }>(
        `/api/sessions/${sessionId}/stage/${slotId}/rest`,
      );
      applySnapshot(next);
    } catch (error) {
      toast.showError(error);
    }
  };

  /**
   * What condition their character is in. Theirs to say for the same reason
   * their numbers are theirs to spend, and refused by the server for anybody
   * else's character.
   */
  const setStatusTag = async (slotId: string, tag: string, active: boolean) => {
    try {
      const { snapshot: next } = await api.patchJson<{ snapshot: Snapshot }>(
        `/api/sessions/${sessionId}/stage/${slotId}/tags`,
        { tag, active },
      );
      applySnapshot(next);
    } catch (error) {
      toast.showError(error);
    }
  };

  const setHold = async (slotId: string, held: boolean) => {
    try {
      const { snapshot: next } = await api.patchJson<{ snapshot: Snapshot }>(
        `/api/sessions/${sessionId}/stage/${slotId}/hold`,
        { held },
      );
      applySnapshot(next);
    } catch (error) {
      toast.showError(error);
    }
  };

  const claim = async (characterId: string) => {
    setClaiming(true);
    try {
      const { snapshot: next } = await api.postJson<{ snapshot: Snapshot }>(
        `/api/sessions/${sessionId}/claim`,
        { characterId },
      );
      applySnapshot(next);
    } catch (error) {
      toast.showError(error);
    } finally {
      setClaiming(false);
    }
  };

  // Before anything else, a player picks which character they're playing.
  if (!myCharacterId) {
    // The snapshot arrives in initiative order, which is the wrong order for
    // finding your own character in a list of names.
    const available = snapshot.characters
      .filter((character) => character.kind === "pc" && character.claimedByPlayerId === null)
      .sort((a, b) => compareNames(a.name, b.name));

    return (
      <div className="w-full p-2 sm:p-3">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Welcome, {playerName}</h1>
          {/* This screen promises the list fills itself in as characters are
              freed up, which is a promise the socket keeps — so it is a screen
              that has to say when the socket is not keeping it. */}
          <div className="flex items-center gap-2">
            <ConnectionWarning />
            <ThemeToggle />
          </div>
        </header>

        <Panel title="Choose your character">
          {available.length === 0 ? (
            <EmptyState>
              No player characters are free right now. Your game master can add more — this list
              updates on its own.
            </EmptyState>
          ) : (
            // Built from the same two constants as the library cards, so a player
            // sees the shape the game master saw. The whole tile is the button
            // here, since picking a character is all there is to do with one.
            <div className={CARD_GRID}>
              {available.map((character) => (
                <HoverCard
                  key={character.id}
                  label={character.name}
                  onClick={() => void claim(character.characterId)}
                  disabled={claiming}
                  cardClassName="border-base-300 bg-base-100 text-left"
                >
                  {/* Everything in this list is a PC — see `available` above —
                      so every card here is printed on foil. */}
                  <CardWell foil>
                    <CardPicture src={character.cardUrl} icon={faShieldHalved} />
                  </CardWell>
                  {/* The same frame the library draws, so a player picks from the
                      cards the game master was looking at. */}
                  <CardFrame kind={character.kind} />
                  {/* Light-theme ink on the frame's pale panel, as in the
                      library. */}
                  <div className={CARD_CAPTION_FRAMED} data-theme="winter">
                    <p className={CARD_NAME}>
                      {character.name}
                    </p>
                  </div>
                </HoverCard>
              ))}
            </div>
          )}
        </Panel>
      </div>
    );
  }

  return (
    <AppPage>
      {/*
        The campaign heads the page, as it does the game master's console: who
        the player is and who they are playing are both on their own panel a few
        lines below, and repeating them up here said nothing the rest of the
        screen was not already saying.

        Three tracks rather than a row, so the name is centred on the page rather
        than on what is left over beside the controls, and stays put as the
        reconnecting note comes and goes.
      */}
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3">
        {/* The left track was empty; the log control fills it, which keeps the
            campaign's name centred on the page rather than on what is left. */}
        <div className="justify-self-start">
          <LogToggle open={logOpen} onToggle={toggleLog} />
        </div>

        <h1 className="truncate text-center text-xl font-semibold">
          {snapshot.session.campaignName}
        </h1>

        <div className="flex items-center justify-end gap-2">
          <ConnectionWarning />
          <ThemeToggle />
          {/* The same picture the game master's `Sign out` carries: for a player,
              leaving the table is the same gesture as signing out of one. */}
          <Button onClick={onLeave}>
            <Icon icon={faRightFromBracket} /> Leave
          </Button>
        </div>
      </header>

      {/*
        Two columns on a large screen, one on a narrow one — and the stacked order
        interleaves them, since the scene belongs above the player list on a phone
        but beside it on a monitor. The wrappers are `display: contents` until the
        columns exist, so all four panels are items of the one column and `order`
        alone decides where the player list falls; the same trick the game master's
        console uses (GmSession.tsx).

        Nothing here grows. Every panel is a flex item at its natural height, so a
        short list ends where its content does rather than being stretched to the
        frame. `scroll` on the two lists is only a guard for the other direction: a
        list taller than the fixed wide frame shrinks back and scrolls its own body
        instead of spilling out of the page, which the wide layout clips.
      */}
      {/*
        The log is a drawer beside the page rather than a panel inside it, and it
        pushes rather than covers: this row is the push. Closed it has no width,
        so the two columns below are exactly what they were without it.
      */}
      <div className="flex flex-col lg:flex-row lg:items-start wide:min-h-0 wide:flex-1 wide:items-stretch">
        <LogDrawer events={snapshot.events} open={logOpen} onClose={toggleLog} />

      {/*
        Two tracks with a handle standing in the gutter between them, which is why
        there is no column gap any more: the handle is exactly as wide as the gap
        it replaced. The left track's width is the custom property, defaulting to
        the share it has always had against the scene's `1.4fr` (see `styles.css`),
        so an untouched screen looks exactly as it did before it could be dragged.
      */}
      <div
        ref={columnsRef}
        className="flex min-w-0 flex-1 flex-col gap-2.5 lg:grid lg:grid-cols-[var(--player-mine)_auto_minmax(0,1.4fr)] lg:items-start lg:gap-x-0 wide:min-h-0 wide:items-stretch"
      >
        <div
          ref={mineSplit.panelRef}
          className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-2.5 wide:min-h-0"
        >
          <TurnControls
            className="lg:shrink-0"
            turn={snapshot.session.turn}
            segment={snapshot.session.segment}
            activeCharacterName={(() => {
              const active = snapshot.characters.find(
                (character) => character.id === snapshot.session.activeSlotId,
              );
              return active ? stageLabel(snapshot.characters, active) : null;
            })()}
            editable={false}
          />

          <Panel
            title="My character"
            className="lg:shrink-0"
            actions={
              myCharacter ? (
                <Button onClick={() => setSheetOpen(true)}>My sheet</Button>
              ) : null
            }
          >
            {myCharacter ? (
              // Nothing in here wraps. This panel is one character's own line of
              // numbers, and a row that folds in half on a phone reads as two
              // characters at a glance — worse than a line that has to be pushed
              // sideways to see the end of. A name too long for the panel is cut
              // with an ellipsis for the same reason; the whole of it is on the
              // page header above.
              <div className="space-y-3">
                {/*
                  The row a character gets on the game master's segment panel:
                  the big square, then the same three lines beside it — who they
                  are, the four numbers the order is worked out from, and what
                  they have left. A player reading over the game master's
                  shoulder is reading their own row twice rather than two
                  arrangements of it, which is the same reason `StatLine` is
                  shared between the two screens at all.
                */}
                <div className="flex items-center gap-3">
                  <CharacterThumb
                    fill
                    kind={myCharacter.kind}
                    cardUrl={myCharacter.cardUrl}
                  />
                  <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
                    <p className="truncate font-medium">{myCharacter.name}</p>
                    <StatLine character={myCharacter} />
                    {/*
                      Spent during a fight, and this player's own to spend. The
                      line does not wrap, and this column's width is the reader's
                      to choose, so it is pushed sideways to see the end of
                      rather than allowed to spill: without this it overflowed
                      the panel and lay across the drag handle beside it, which
                      put the handle out of reach exactly when a reader wanted
                      their column back.
                    */}
                    <div className="overflow-x-auto">
                      <Vitals
                        character={myCharacter}
                        wrap={false}
                        onChange={(patch) => void setVitals(myCharacter.id, patch)}
                      />
                    </div>
                  </div>
                </div>
                {/*
                  And what condition they are in, set here rather than in the
                  scene below for the same reason the numbers are: a player's own
                  character is theirs to change on their own panel, and the scene
                  is where everybody is read rather than written.
                */}
                {/*
                  What is on this character on the left, what they can do about
                  it on the right — the shape a segment row on the console has,
                  so a player reading over the game master's shoulder is reading
                  the same panel twice rather than two arrangements of it.
                */}
                <div className="flex items-center gap-2">
                  {/* Nothing at all when there is nothing on them: the row of
                      pills is the answer to "what is on me", and an empty row
                      says that as plainly as a sentence would. */}
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <StatusTagButton
                      character={myCharacter}
                      onOpen={() => setTaggingOpen(true)}
                    />
                    <StatusTagPills
                      tags={myCharacter.statusTags}
                      subject={myCharacter.name}
                      onRemove={(tag) => void setStatusTag(myCharacter.id, tag, false)}
                    />
                  </div>

                  {/*
                    The three that change something, in the console's own order.
                    Waiting is this player's decision as much as spending their
                    own END is, which is why the hold is here at all rather than
                    only on the game master's screen; taking it off cuts them
                    back into the order and gives them the turn, so the label
                    promises that rather than describing the state — the badge in
                    the scene below says the state.
                  */}
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    <VitalActions
                      character={myCharacter}
                      onRecover={() => void recover(myCharacter.id)}
                      onRest={() => void rest(myCharacter.id)}
                    />
                    <button
                      type="button"
                      onClick={() => void setHold(myCharacter.id, !myCharacter.isHeld)}
                      className={bareIcon(myCharacter.isHeld ? "danger" : "muted")}
                      title={
                        myCharacter.isHeld
                          ? "Take your held action now"
                          : "Hold your action"
                      }
                      aria-label={
                        myCharacter.isHeld
                          ? "Take your held action now"
                          : "Hold your action"
                      }
                      aria-pressed={myCharacter.isHeld}
                    >
                      <Icon icon={faOctagon} />
                    </button>
                  </div>
                </div>
                {taggingOpen ? (
                  <StatusTagPicker
                    character={myCharacter}
                    onToggle={(tag, active) => void setStatusTag(myCharacter.id, tag, active)}
                    onClose={() => setTaggingOpen(false)}
                  />
                ) : null}
              </div>
            ) : (
              <EmptyState>
                Your character isn't in the scene right now. Your game master can bring them
                back.
              </EmptyState>
            )}
          </Panel>

          <Panel
            title={`Players (${snapshot.players.length})`}
            scroll
            className="order-last lg:order-none"
          >
            <ul className="divide-y divide-base-200">
              {snapshot.players.map((player) => {
                const character = snapshot.characters.find(
                  (entry) => entry.characterId === player.claimedCharacterId,
                );
                return (
                  <li key={player.id} className="py-2.5">
                    <p className="font-medium">
                      {player.name}
                      {player.id === playerId ? (
                        <span className={`ml-1.5 text-xs font-normal ${TEXT_MUTED}`}>(you)</span>
                      ) : null}
                    </p>
                    <p className={`text-xs ${TEXT_MUTED}`}>
                      {character ? `Playing ${character.name}` : "Choosing a character…"}
                    </p>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>

        <ColumnHandle
          {...mineSplit.handleProps}
          from="lg"
          label="Resize your column"
        />

        <div className="contents lg:flex lg:min-w-0 lg:flex-col wide:min-h-0">
          <Panel
            scroll
            title="Stage"
            actions={
              <SegmentFilterToggle showActingOnly={showActingOnly} onToggle={toggleSegmentFilter} />
            }
          >
            {snapshot.characters.length === 0 ? (
              <EmptyState>Your game master hasn't brought anyone into the scene yet.</EmptyState>
            ) : (
              <InitiativeList
                characters={snapshot.characters}
                segment={snapshot.session.segment}
                showActingOnly={showActingOnly}
                activeSlotId={snapshot.session.activeSlotId}
                yourCharacterId={myCharacterId}
              />
            )}
          </Panel>
        </div>
      </div>
      </div>

      {sheetOpen && myCharacter ? (
        <SheetOverlay
          src={myCharacter.sheetUrl}
          title={myCharacter.name}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </AppPage>
  );
}
