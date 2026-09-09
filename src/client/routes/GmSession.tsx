/**
 * The game master's session console.
 *
 * Everything that changes what players see happens here: which characters are
 * active, what order they act in, whose turn it is, and who is in the room.
 * Every mutation returns the new snapshot, which is applied straight away, and
 * the same snapshot is broadcast to the players.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api.ts";
import { compareNames } from "../../lib/names.ts";
import { useSessionSocket } from "../useSessionSocket.ts";
import { useGmSettings } from "../gmSettings.ts";
import { useColumnSplit } from "../useColumnSplit.ts";
import {
  AppPage,
  Button,
  CharacterThumb,
  ColumnHandle,
  CopyButton,
  CountBadge,
  EmptyState,
  Icon,
  KindBadge,
  LoadingNote,
  Panel,
  TEXT_MUTED,
} from "../components/ui.tsx";
import {
  faBook,
  faCopy,
  faEye,
  faLink,
  faRightFromBracket,
  faStop,
  faUserPlus,
  faUserSlash,
} from "@fortawesome/free-solid-svg-icons";
import type { VitalsPatch } from "../components/Vitals.tsx";
import { ConnectionWarning } from "../components/ConnectionWarning.tsx";
import { InitiativeList, stageLabel } from "../components/InitiativeList.tsx";
import { LogDrawer, LogToggle, useLogDrawer } from "../components/EventLog.tsx";
import { SettingsDrawer, SettingsToggle, useSettingsDrawer } from "../components/Settings.tsx";
import { SegmentFilterToggle, useSegmentFilter } from "../components/SegmentFilter.tsx";
import { TurnControls } from "../components/TurnControls.tsx";
import { SheetOverlay } from "../components/SheetFrame.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { useConfirm } from "../components/Confirm.tsx";
import { useToast } from "../components/Toast.tsx";
import type { Character, GameSession, Snapshot } from "../types.ts";

export function GmSessionConsole({ onSignOut }: { onSignOut: () => void }) {
  const { id: sessionId = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  // Anything the server wants said out loud here reaches this screen as a toast.
  // Green unless the server says otherwise: the Post-Segment 12 Recovery and the
  // turn passing to your character are both the fight going well, and a notice
  // that is not — a character stunned by a hit — sends the tone to say so.
  const { snapshot, applySnapshot } = useSessionSocket(
    sessionId,
    (message, tone) => toast.show(message, tone ?? "success"),
  );
  const [session, setSession] = useState<GameSession | null>(null);
  const [library, setLibrary] = useState<Character[]>([]);
  // Only the borrowed rows need one, so this is empty until the setting that
  // borrows them is on.
  const [campaignNames, setCampaignNames] = useState<Map<string, string>>(new Map());
  // A library character rather than a stage slot: sheets are opened from the
  // library panel, which lists the campaign's characters whether they are in the
  // scene or not, and a sheet belongs to the character rather than to the copy.
  const [viewingSheet, setViewingSheet] = useState<Character | null>(null);
  const [busy, setBusy] = useState(false);
  const [showActingOnly, toggleSegmentFilter] = useSegmentFilter(sessionId);
  const [logOpen, toggleLog] = useLogDrawer(sessionId);
  const [settingsOpen, toggleSettings] = useSettingsDrawer();
  // Set in the drawer on this same screen, so the library below re-reads itself
  // as it is switched rather than on the next visit.
  const { showAllNpcs } = useGmSettings();

  // The console's columns start as equal shares and can be dragged to any others.
  // One split per boundary, each sizing the column to its left; the last column
  // has no handle and absorbs what the others give up.
  //
  // Three hooks for two layouts, because the two layouts do not share a boundary.
  // At `sm` the console is the table's stuff on the left and the fight on the
  // right, so the one boundary is between those two. On the dashboard the left
  // stack comes apart into the library and the players, on either side of the
  // fight, and neither of the boundaries that leaves is the one `sm` had — the
  // library and the players are not even adjacent any more. So `sideSplit`
  // belongs to the two-column layout and the other two to the three-column one,
  // and each is hidden where its boundary does not exist.
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const sideSplit = useColumnSplit<HTMLDivElement>({
    containerRef: consoleRef,
    variable: "--console-side",
  });
  const turnSplit = useColumnSplit<HTMLDivElement>({
    containerRef: consoleRef,
    variable: "--console-turn",
  });
  const librarySplit = useColumnSplit<HTMLDivElement>({
    containerRef: consoleRef,
    variable: "--console-library",
  });

  // Loaded once: the code and the campaign don't change while a session runs.
  useEffect(() => {
    void (async () => {
      try {
        const { sessions } = await api.get<{ sessions: GameSession[] }>("/api/sessions");
        setSession(sessions.find((entry) => entry.id === sessionId) ?? null);
      } catch (error) {
        toast.showError(error);
      }
    })();
  }, [sessionId, toast]);

  /*
   * Who can be brought into the fight — read again whenever that answer changes,
   * which is why it is an effect of its own rather than part of the load above.
   * The session is fetched once because a session's campaign does not move;
   * `Show All NPCs` moves under the reader's hand, in the drawer beside this
   * panel, and the list has to refill when it does.
   *
   * Off, the campaign's own characters, which is the whole of the old behaviour.
   * On, everything this game master owns — and then the monsters are kept out of
   * the campaign as well as in it, while the heroes are not. A player character
   * belongs to a player in a campaign, and the server will refuse to stage one
   * from anywhere else, so listing them here would be offering something that
   * cannot be taken.
   */
  useEffect(() => {
    if (!showAllNpcs) {
      setCampaignNames(new Map());
      return;
    }
    void (async () => {
      try {
        const { campaigns } = await api.get<{ campaigns: { id: string; name: string }[] }>(
          "/api/campaigns",
        );
        setCampaignNames(new Map(campaigns.map((campaign) => [campaign.id, campaign.name])));
      } catch {
        // A borrowed monster reads as a monster without the campaign under it,
        // which is worse than with — but it is still the row it was, and the
        // library itself has already said whatever went wrong.
      }
    })();
  }, [showAllNpcs]);

  useEffect(() => {
    const campaignId = session?.campaignId;
    if (!campaignId) return;

    void (async () => {
      try {
        const { characters } = await api.get<{ characters: Character[] }>(
          showAllNpcs
            ? "/api/characters"
            : `/api/characters?campaignId=${encodeURIComponent(campaignId)}`,
        );
        setLibrary(
          characters.filter(
            (character) => character.campaignId === campaignId || character.kind === "npc",
          ),
        );
      } catch (error) {
        toast.showError(error);
      }
    })();
  }, [session?.campaignId, showAllNpcs, toast]);

  /** Runs a mutation and applies the snapshot it returns. */
  const mutate = useCallback(
    async (action: () => Promise<{ snapshot: Snapshot }>) => {
      setBusy(true);
      try {
        const { snapshot: next } = await action();
        applySnapshot(next);
      } catch (error) {
        toast.showError(error);
      } finally {
        setBusy(false);
      }
    },
    [applySnapshot, toast],
  );

  /** Puts a character on the stage. An NPC asked for twice arrives twice. */
  const addCharacter = (characterId: string) =>
    mutate(() =>
      api.postJson<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/stage`, { characterId }),
    );

  /** Takes one slot off the stage, leaving any other copy of it where it is. */
  /**
   * Takes a character off the stage.
   *
   * It asks first only when someone is actually playing the character: removing
   * a claimed PC drops that player back to the pick-a-character screen mid-game,
   * which is not what a misplaced click should be able to do. Everything else —
   * an unclaimed hero, a goblin, one goblin of several — goes straight away,
   * because a fight is run by clicking quickly and a dialog in front of every
   * removal would be answered without being read.
   */
  const removeCharacter = async (slotId: string) => {
    const slot = snapshot?.characters.find((character) => character.id === slotId) ?? null;
    const heldBy = slot?.kind === "pc" ? slot.claimedByPlayerName : null;

    if (heldBy) {
      const ok = await confirm({
        title: `Take ${slot!.name} out of the scene?`,
        body: `${heldBy} is playing them, and will be asked to choose a character again. `
          + "Their initiative place goes with them.",
        confirmLabel: "Remove",
      });
      if (!ok) return;
    }

    void mutate(() =>
      api.delete<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/stage/${slotId}`),
    );
  };

  const setTurn = (slotId: string) =>
    mutate(() => api.postJson<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/turn`, {
      slotId,
    }));

  const advanceTurn = useCallback(
    (direction: "next" | "prev") =>
      void mutate(() =>
        api.postJson<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/turn/advance`, {
          direction,
        }),
      ),
    [mutate, sessionId],
  );

  /**
   * Starts the fight over: turn one, segment twelve, no turn set.
   *
   * It asks first because it is the one turn control that throws work away —
   * several turns of tracking gone on one click, and the only way back is to
   * press Next as many times as it took to get there.
   */
  const restartTurns = async () => {
    const ok = await confirm({
      title: "Start over at turn 1?",
      body: "The fight goes back to turn 1, segment 12, with no turn set. Characters and their claims stay as they are.",
      confirmLabel: "Restart",
    });
    if (!ok) return;
    void mutate(() =>
      api.post<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/turn/restart`),
    );
  };

  /**
   * Empties the log.
   *
   * It asks first because it is the only control on the console that destroys a
   * record rather than changing state: everything else the game master presses
   * can be pressed back, and this cannot.
   */
  const clearLog = async () => {
    const ok = await confirm({
      title: "Clear the log?",
      body: "Everything the log remembers about this session is thrown away. The fight itself — the turn, the stage, what everybody has left — is untouched.",
      confirmLabel: "Clear",
    });
    if (!ok) return;
    void mutate(() => api.post<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/log/clear`));
  };

  const setVitals = (slotId: string, patch: VitalsPatch) =>
    mutate(() =>
      api.patchJson<{ snapshot: Snapshot }>(
        `/api/sessions/${sessionId}/stage/${slotId}/vitals`,
        patch,
      ),
    );

  const recover = (slotId: string) =>
    mutate(() =>
      api.post<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/stage/${slotId}/recover`),
    );

  const rest = (slotId: string) =>
    mutate(() =>
      api.post<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/stage/${slotId}/rest`),
    );

  const setHold = (slotId: string, held: boolean) =>
    mutate(() =>
      api.patchJson<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/stage/${slotId}/hold`, {
        held,
      }),
    );

  const setStatusTag = (slotId: string, tag: string, active: boolean) =>
    mutate(() =>
      api.patchJson<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/stage/${slotId}/tags`, {
        tag,
        active,
      }),
    );

  const setClaim = (playerId: string, claimedCharacterId: string | null) =>
    mutate(() =>
      api.patchJson<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/players/${playerId}`, {
        claimedCharacterId,
      }),
    );

  const kickPlayer = async (playerId: string, name: string) => {
    const ok = await confirm({
      title: `Remove ${name} from this session?`,
      body: "They can rejoin with the session code.",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    void mutate(() =>
      api.delete<{ snapshot: Snapshot }>(`/api/sessions/${sessionId}/players/${playerId}`),
    );
  };

  const endSession = async () => {
    const ok = await confirm({
      title: "End this session?",
      body: "The code stops working and everyone is disconnected.",
      confirmLabel: "End session",
    });
    if (!ok) return;
    try {
      await api.post(`/api/sessions/${sessionId}/end`);
      toast.show("Session ended.", "success");
      navigate("/gm");
    } catch (error) {
      toast.showError(error);
    }
  };

  if (!session) {
    return <LoadingNote>Loading session…</LoadingNote>;
  }

  // How many of each character are on the stage: the count beside a library row,
  // and what decides whether a PC's Add button is still live.
  const staged = new Map<string, number>();
  for (const character of snapshot?.characters ?? []) {
    staged.set(character.characterId, (staged.get(character.characterId) ?? 0) + 1);
  }

  // Nobody leaves the library, on stage or not. A row that vanishes when its
  // character walks on reads the same as a character that was never in the
  // campaign; a row that stays, with its Add ghosted, says the hero is already
  // in.
  //
  // Four blocks, in the order a fight asks for them: whoever is already in the
  // scene first — heroes, then monsters — and then everybody who is not, in the
  // same two kinds. Who is in the scene is the thing a game master is looking
  // this panel up against, so it sorts before what kind they are. Alphabetically
  // inside each block, matching the `COLLATE NOCASE` the characters endpoint
  // already orders by — sorted here as well so the grouping is this panel's own
  // rather than something inherited from a query.
  const libraryRank = (character: Character) =>
    (staged.has(character.id) ? 0 : 2) + (character.kind === "pc" ? 0 : 1);

  /** Borrowed from another campaign, which only `Show All NPCs` puts here. */
  const isBorrowed = (character: Character) => character.campaignId !== session?.campaignId;

  /*
   * Monsters on this stage that only `Show All NPCs` could have put there.
   *
   * While there is one, the setting cannot be switched off — turning it off is
   * what takes them out of the library, and a slot whose character the library no
   * longer lists has no count beside it, no sheet to open from there, and no way
   * to add a second copy. The server refuses it too, and has to: this console can
   * only see its own fight, and a game master may be running another in the next
   * tab.
   */
  const borrowedOnStage = (snapshot?.characters ?? []).filter(isBorrowed);
  const showAllNpcsHeldOn = borrowedOnStage.length === 0
    ? null
    : `${borrowedOnStage.length === 1
      ? `${borrowedOnStage[0]!.name} is`
      : `${borrowedOnStage.length} characters are`
    } on the stage from another campaign. Take them off to turn this back off.`;

  const libraryOrder = [...library].sort(
    (a, b) =>
      libraryRank(a) - libraryRank(b) ||
      // Inside a block, this campaign's own before anything borrowed: the cast
      // the console is actually running is what a game master is looking for
      // first, and the rest is a shelf they went to on purpose.
      Number(isBorrowed(a)) - Number(isBorrowed(b)) ||
      compareNames(a.name, b.name),
  );

  // The one row that has the scene above it and the rest of the campaign below.
  // There is at most one, since the sort puts everybody on stage first, and none
  // at all when the whole library is in the scene or none of it is.
  const opensTheOffStageBlock = (index: number) =>
    index > 0 &&
    !staged.has(libraryOrder[index]!.id) &&
    staged.has(libraryOrder[index - 1]!.id);
  const activeCharacter =
    snapshot?.characters.find((character) => character.id === snapshot.session.activeSlotId) ??
    null;
  const playerCharacters = snapshot?.characters.filter((c) => c.kind === "pc") ?? [];
  // The socket is the truth once it has spoken; the loaded session covers the
  // moment before it does.
  const segment = snapshot?.session.segment ?? session.segment;

  const joinUrl = `${location.origin}/join?code=${encodeURIComponent(session.code)}`;

  /*
   * The code, the two ways of handing it out, and the control that stops it
   * working. They belong together and they belong in a panel: the header is for
   * where you are and how the page looks, not for the session's own controls.
   */
  const invite = (
    <Panel className="order-first sm:order-none">
      <div className="flex flex-wrap items-center gap-3">
        <code className="rounded-lg bg-base-200 px-3 py-2 font-mono text-sm tracking-wider">
          {session.code}
        </code>
        <CopyButton value={session.code} label="Code" icon={faCopy} />
        <CopyButton value={joinUrl} label="Link" icon={faLink} />
        <Button variant="danger" onClick={() => void endSession()}>
          <Icon icon={faStop} /> End
        </Button>
      </div>
    </Panel>
  );

  return (
    <AppPage>
      {/*
        Three tracks rather than a row with the name in the middle of it: the
        outer two are equal, so the campaign's name is centred on the page rather
        than on whatever is left over between the button and the toggle, and it
        stays put as the connection warning comes and goes.
      */}
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3">
        {/* The log first, because it is what opens directly below it: the drawer
            comes out of this corner, so its control is the thing in the corner. */}
        <div className="flex flex-wrap items-center gap-2 justify-self-start">
          <LogToggle open={logOpen} onToggle={toggleLog} />
          <Button variant="ghost" onClick={() => navigate("/gm")}>
            <Icon icon={faBook} /> Library
          </Button>
        </div>

        <h1 className="truncate text-center text-xl font-semibold">
          {session.campaignName}
        </h1>

        <div className="flex flex-wrap items-center justify-end gap-2 justify-self-end">
          <ConnectionWarning />
          <ThemeToggle />
          {/* Between the theme and the sign-out: the drawer comes out of this
              corner, the same way the log's control sits in the corner its
              drawer comes out of. */}
          <SettingsToggle open={settingsOpen} onToggle={toggleSettings} />
          {/* Signing out is about this browser, not about the table: the session
              keeps running and the code keeps working. Ending it is the `End`
              button down in the panel with the code, where it belongs. */}
          <Button onClick={onSignOut}>
            <Icon icon={faRightFromBracket} /> Sign out
          </Button>
        </div>
      </header>

      {/*
        Three panels' worth of console, in as many columns as the glass allows:
        one on a phone, two halves on anything wider, three thirds where the
        screen is a dashboard. The turn belongs above the segment panel and the
        width of it — it is the same fight — so the two travel together as one
        column wherever they land.

        Where they land is the fight in the middle of the dashboard, with the
        library on one side of it and the players on the other: the library feeds
        the stage, the stage is what the evening is about, and a game master
        reading left to right meets the three in the order they are used. At `sm`
        there is no middle to be in, so the fight takes the right-hand half and
        everything about the table — the code, who has joined, and what there is
        to bring on — stacks up on the left. Stacked on a phone the code comes
        first, because a session's first minute is reading it out.

        The wrappers are `display: contents` until their column exists, so the
        panels are items of one flow while stacked, and `order` alone says where
        each lands on each layout rather than a second copy of the markup saying
        so.

        Nothing here grows: every panel is a flex item at its natural height, so
        a short list ends where its content does. `scroll` on the lists is the
        guard for the other direction — a list taller than the fixed wide frame
        shrinks back and scrolls its own body instead of being clipped by it.
      */}
      {/*
        The log is a drawer beside the console rather than a panel inside it, and
        it pushes rather than covers: this row is the push. Closed it has no
        width, so the console is the whole of the row and the layout below is
        exactly what it was before the drawer existed.
      */}
      <div className="flex flex-col lg:flex-row lg:items-start wide:min-h-0 wide:flex-1 wide:items-stretch">
        <LogDrawer
          events={snapshot?.events ?? []}
          open={logOpen}
          onClose={toggleLog}
          onClear={() => void clearLog()}
        />

      {/*
        Two columns here and three on the dashboard, with a handle standing in each
        gutter — which is why there is no `gap` between the tracks any more: a
        handle is exactly as wide as the gap it replaced. The widths are the two
        custom properties, each defaulting to an equal share (see `styles.css`), so
        an untouched console looks exactly as it did before it could be dragged.
      */}
      <div
        ref={consoleRef}
        className="flex min-w-0 flex-1 flex-col gap-2.5 sm:grid sm:grid-cols-[var(--console-side)_auto_minmax(0,1fr)] sm:items-start sm:gap-x-0 wide:min-h-0 wide:grid-cols-[var(--console-library)_auto_var(--console-turn)_auto_minmax(0,1fr)] wide:items-stretch"
      >
        {/* The fight: on the right at `sm`, in the middle on the dashboard, and
            the third track of both templates either way. */}
        <div
          ref={turnSplit.panelRef}
          className="contents sm:order-3 sm:flex sm:min-w-0 sm:flex-col sm:gap-2.5 wide:min-h-0"
        >
          <TurnControls
            className="sm:shrink-0"
            turn={snapshot?.session.turn ?? session.turn}
            segment={segment}
            activeCharacterName={
              activeCharacter ? stageLabel(snapshot?.characters ?? [], activeCharacter) : null
            }
            editable
            onAdvance={advanceTurn}
            onRestart={() => void restartTurns()}
            disabled={busy || (snapshot?.characters.length ?? 0) === 0}
          />

          <Panel
            title="Stage"
            actions={
              <SegmentFilterToggle showActingOnly={showActingOnly} onToggle={toggleSegmentFilter} />
            }
            scroll
          >
          {snapshot && snapshot.characters.length > 0 ? (
            <InitiativeList
              characters={snapshot.characters}
              segment={segment}
              showActingOnly={showActingOnly}
              activeSlotId={snapshot.session.activeSlotId}
              editable
              onSetVitals={(id, patch) => void setVitals(id, patch)}
              onRecover={(id) => void recover(id)}
              onRest={(id) => void rest(id)}
              onToggleTag={(id, tag, active) => void setStatusTag(id, tag, active)}
              onToggleHold={(id, held) => void setHold(id, held)}
              onSetTurn={(id) => void setTurn(id)}
              onRemove={(id) => void removeCharacter(id)}
            />
          ) : (
            <EmptyState>
              No characters in the session yet. Add some from the library.
            </EmptyState>
          )}
          </Panel>
        </div>

        {/* The two-column layout's only boundary, between the table's stuff and
            the fight. It goes when the dashboard takes that stack apart, because
            the two halves it divided are no longer either half of anything. */}
        <ColumnHandle
          {...sideSplit.handleProps}
          from="smOnly"
          className="sm:order-2"
          label="Resize the players and library column"
        />

        {/* The dashboard's first boundary, between the library and the fight it
            feeds. */}
        <ColumnHandle
          {...librarySplit.handleProps}
          className="wide:order-2"
          label="Resize the library column"
        />

        {/*
          Everything about the table rather than about the fight: the code, who is
          here, and who could be brought on. One stack on the left at `sm`; on the
          dashboard it comes apart and the fight goes between its two halves, the
          library on the near side of the stage it feeds and the players on the
          far side.
        */}
        <div
          ref={sideSplit.panelRef}
          className="contents sm:order-1 sm:flex sm:min-w-0 sm:flex-col sm:gap-2.5 wide:contents"
        >
          <div className="contents wide:order-5 wide:flex wide:min-h-0 wide:min-w-0 wide:flex-col wide:gap-2.5">
          {invite}

          <Panel title={`Players (${snapshot?.players.length ?? 0})`} scroll>
            {snapshot && snapshot.players.length > 0 ? (
              <ul className="divide-y divide-base-200">
                {snapshot.players.map((player) => {
                  const claimed = snapshot.characters.find(
                    (character) => character.characterId === player.claimedCharacterId,
                  );
                  return (
                    <li key={player.id} className="flex items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{player.name}</p>
                        <p className={`truncate text-xs ${TEXT_MUTED}`}>
                          {claimed ? `Playing ${claimed.name}` : "No character chosen yet"}
                        </p>
                      </div>
                      <select
                        value={player.claimedCharacterId ?? ""}
                        onChange={(event) =>
                          void setClaim(player.id, event.target.value || null)
                        }
                        aria-label={`Character played by ${player.name}`}
                        className="select select-xs w-auto"
                      >
                        <option value="">— none —</option>
                        {playerCharacters.map((character) => (
                          // Valued by the character: a claim is on the hero, not
                          // on the slot they happen to be standing in.
                          <option key={character.id} value={character.characterId}>
                            {character.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="dangerGhost"
                        onClick={() => void kickPlayer(player.id, player.name)}
                      >
                        <Icon icon={faUserSlash} /> Kick
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState>Nobody has joined yet. Send them the code above.</EmptyState>
            )}
          </Panel>
          </div>

          <div
            ref={librarySplit.panelRef}
            className="contents wide:order-1 wide:flex wide:min-h-0 wide:min-w-0 wide:flex-col"
          >
          <Panel title="Library" scroll>
            {libraryOrder.length === 0 ? (
              <EmptyState>
                This campaign has no characters yet. They are made on the library page.
              </EmptyState>
            ) : (
              // The rules between rows are drawn per row rather than by `divide-y`,
              // because one of them is not like the others: where the scene ends
              // and the rest of the campaign begins, the line thickens. The four
              // blocks are otherwise told apart only by dimming and by kind
              // badges, and the eye finds a heavier rule before it reads either.
              //
              // It carries its own colour rather than `HAIRLINE`, which shares
              // its dark shade with the hairline below — two rules the same
              // colour and a pixel apart in weight is not a boundary anybody can
              // see. These two are picked to stand off the row rule in both
              // themes: darker than it on white, lighter than it on stone.
              <ul>
                {libraryOrder.map((character, index) => (
                  <li
                    key={character.id}
                    className={`flex items-center gap-3 py-2 ${
                      index === 0
                        ? ""
                        : opensTheOffStageBlock(index)
                          ? "border-t-2 border-base-content/30"
                          : "border-t border-base-200"
                    }`}
                  >
                    {/*
                      A character who is not in the scene is dimmed, the same way
                      the segment panel dims whoever has no phase this segment:
                      brightness is this panel's answer to "are they in the
                      fight", which is the question the four blocks are sorted by.

                      Everything but the Add button is inside it, because opacity
                      composites the whole subtree — a child cannot be brighter
                      than its parent, so the one control that should stay at full
                      strength has to sit outside the dimming rather than undo it.
                      And it is the one that should: adding them is exactly what a
                      game master is reaching for on a row that is not in yet.
                    */}
                    <div
                      className={`flex min-w-0 flex-1 items-center gap-3 ${
                        staged.has(character.id) ? "" : "opacity-60"
                      }`}
                    >
                      <CharacterThumb
                        kind={character.kind}
                        cardUrl={character.cardUrl}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{character.name}</span>
                        {/* Where it came from, and only when that is not here.
                            Two campaigns with a `Goblin` in each are two
                            identical rows otherwise, and which one a game master
                            is about to bring on would be a coin toss. */}
                        {isBorrowed(character) ? (
                          <span className={`block truncate text-xs ${TEXT_MUTED}`}>
                            {campaignNames.get(character.campaignId) ?? "Another campaign"}
                          </span>
                        ) : null}
                      </span>
                      {/* How many of this one are out there already, and only
                          once that is a question worth answering.

                          Two things keep it quiet. Only monsters carry it, since
                          there is one of a given hero and never a second. And
                          only a second copy brings it out: a row that is lit
                          rather than dimmed already says the character is in the
                          fight, so a badge reading `1` beside it is the same
                          sentence twice — and on a stage of single monsters it is
                          that sentence on every row, which is a column of `1`s
                          for the eye to learn to skip. The number earns its place
                          the moment it stops being one. */}
                      {character.kind === "npc" && (staged.get(character.id) ?? 0) > 1 ? (
                        <CountBadge title={`${staged.get(character.id)} in the session`}>
                          {staged.get(character.id)}
                        </CountBadge>
                      ) : null}
                      <KindBadge kind={character.kind} />
                      {/* Sheets are opened from here rather than from the segment
                          panel: this list has every character in the campaign, so
                          one that has not walked on yet can still be read, and a
                          sheet is the character's rather than the copy's — two
                          goblins have one between them. */}
                      <Button variant="ghost" onClick={() => setViewingSheet(character)}>
                        <Icon icon={faEye} /> Sheet
                      </Button>
                    </div>
                    {/* A hero is on the stage once and no more, so their Add goes
                        quiet rather than away — the ghosting is `Button`'s own
                        `disabled:` styling. A monster's never does. */}
                    <Button
                      onClick={() => void addCharacter(character.id)}
                      disabled={busy || (character.kind === "pc" && staged.has(character.id))}
                      title={
                        character.kind === "pc" && staged.has(character.id)
                          ? `${character.name} is already in the session.`
                          : undefined
                      }
                    >
                      <Icon icon={faUserPlus} /> Add
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          </div>
        </div>

        {/* The dashboard's second boundary, between the fight and the players.
            Only the dashboard has a second gutter at all. */}
        <ColumnHandle
          {...turnSplit.handleProps}
          className="wide:order-4"
          label="Resize the turn column"
        />
      </div>

        {/* The other end of the same row the log sits at the start of. Last in
            the markup so it lands on the right once the page has columns to
            push; the drawer itself moves back above the console on a phone,
            where there is no sideways to give. */}
        <SettingsDrawer
          open={settingsOpen}
          onClose={toggleSettings}
          showAllNpcsHeldOn={showAllNpcsHeldOn}
        />
      </div>

      {viewingSheet ? (
        <SheetOverlay
          src={viewingSheet.sheetUrl}
          title={viewingSheet.name}
          onClose={() => setViewingSheet(null)}
        />
      ) : null}
    </AppPage>
  );
}
