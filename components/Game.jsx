import { useEffect, useRef, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import {
  Icon,
  avatars,
  rankLabel,
  PlayerProximity,
  GuessForm,
  GuessRow,
  GuessList,
  EmptyState,
  Counts,
  Modal,
  Leaders,
  ErrorMessage,
} from "./ui.jsx";
import GameDialog from "./GameDialog.jsx";
import { api, readSaved, save } from "../lib/client.js";
const defaults = {
  dark: true,
  contrast: false,
  difficulty: "easy",
  sound: true,
};
function victorySound() {
  try {
    const ctx = new AudioContext(),
      osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    [523, 659, 784].forEach((f, i) =>
      osc.frequency.setValueAtTime(f, ctx.currentTime + i * 0.12),
    );
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    osc.onended = () => ctx.close();
  } catch {}
}
export default function Game() {
  const router = useRouter(),
    path = router.asPath.split("?")[0],
    mp = path.startsWith("/multiplayer"),
    invite = path
      .match(/^\/multiplayer\/m\/([A-Z0-9]{6})$/i)?.[1]
      ?.toUpperCase();
  const [ready, setReady] = useState(false),
    [origin, setOrigin] = useState(""),
    [device, setDevice] = useState("");
  const [settings, setSettings] = useState(defaults),
    [name, setName] = useState(""),
    [nameInput, setNameInput] = useState(""),
    [mode, setMode] = useState("turn"),
    [capacity, setCapacity] = useState(6);
  const [solo, setSolo] = useState(null),
    [soloMode, setSoloMode] = useState("daily"),
    [room, setRoom] = useState(null),
    [seat, setSeat] = useState(null),
    [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [word, setWord] = useState(""),
    [codeInput, setCodeInput] = useState(""),
    [dialog, setDialog] = useState(null),
    [toast, setToast] = useState("");
  const [leaders, setLeaders] = useState([]),
    [period, setPeriod] = useState("week"),
    [challenge, setChallenge] = useState("");
  const lock = useRef(false),
    roomRef = useRef(null),
    seatRef = useRef(null),
    lastWin = useRef(""),
    generation = useRef(0);
  roomRef.current = room;
  seatRef.current = seat;
  useEffect(() => {
    let nickname = "",
      gameMode = "turn",
      limit = 6,
      id = "";
    try {
      nickname = localStorage.getItem("cw-name") || "";
      gameMode = localStorage.getItem("cw-mode") || "turn";
      limit = Number(localStorage.getItem("cw-player-limit")) || 6;
      id = localStorage.getItem("cw-device") || "";
    } catch {}
    if (!id) id = crypto.randomUUID();
    save("cw-device", id);
    setName(nickname);
    setMode(gameMode === "race" ? "race" : "turn");
    setCapacity(
      Number.isInteger(limit) && limit >= 2 && limit <= 6 ? limit : 6,
    );
    setSettings({ ...defaults, ...readSaved("cw-settings", {}) });
    setDevice(id);
    setOrigin(location.origin);
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    document.documentElement.classList.toggle("dark", settings.dark);
    document.documentElement.classList.toggle("contrast", settings.contrast);
    save("cw-settings", settings);
  }, [ready, settings]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!ready || !router.isReady) return;
    const ticket = ++generation.current;
    setError("");
    setWord("");
    setChallenge("");
    setDialog(null);
    const abort = new AbortController();
    if (mp) {
      if (!invite) {
        setRoom(null);
        setSeat(null);
        setSolo(null);
        return;
      }
      if (roomRef.current?.code === invite && seatRef.current) return;
      setRoom(null);
      setSeat(null);
      const saved = readSaved(`cw-room-${invite}`, null);
      if (saved?.token) {
        setBusy(true);
        api(`/api/rooms/${invite}/join`, { token: saved.token }, abort.signal)
          .then((data) => {
            if (ticket === generation.current) enter(data);
          })
          .catch((e) => {
            if (e.name !== "AbortError" && ticket === generation.current)
              setError(e.message);
          })
          .finally(() => {
            if (ticket === generation.current) setBusy(false);
          });
      }
    } else {
      setRoom(null);
      setSeat(null);
      if (path !== "/challenge") {
        const challengeCode = path
          .match(/^\/challenge\/([A-Z0-9]{6})$/i)?.[1]
          ?.toUpperCase();
        const gameMode = challengeCode ? "challenge" : "daily";
        setSoloMode(gameMode);
        setSolo(null);
        api(
          "/api/solo/new",
          { mode: gameMode, device, code: challengeCode },
          abort.signal,
        )
          .then((data) => {
            if (ticket === generation.current) {
              setSolo(data);
              if (gameMode === "daily" && !readSaved("cw-onboarded", false))
                setDialog("onboarding");
            }
          })
          .catch((e) => {
            if (e.name !== "AbortError" && ticket === generation.current)
              setError(e.message);
          });
      }
    }
    return () => abort.abort();
  }, [ready, router.isReady, path, device]);
  useEffect(() => {
    if (!ready || !mp) return;
    const abort = new AbortController();
    api(`/api/leaderboard?period=${period}`, undefined, abort.signal)
      .then(setLeaders)
      .catch((e) => {
        if (e.name !== "AbortError") setToast(e.message);
      });
    return () => abort.abort();
  }, [ready, mp, period, room?.status]);
  useEffect(() => {
    if (!room?.code || !seat?.token) return;
    setConnected(false);
    const events = new EventSource(
      `/api/events?code=${room.code}&token=${seat.token}`,
    );
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = (e) => {
      try {
        updateRoom(JSON.parse(e.data));
      } catch {
        setError("Could not read a game update. Reconnecting…");
      }
    };
    return () => {
      events.close();
      setConnected(false);
    };
  }, [room?.code, seat?.token]);
  useEffect(() => {
    if (room?.status !== "finished" || !seat) return;
    const key = `${room.code}:${room.round}`;
    if (lastWin.current === key) return;
    lastWin.current = key;
    const games = readSaved("cw-mp-stats", []),
      won = room.winner === seat.playerId;
    if (!games.some((g) => g.key === key)) {
      games.push({
        key,
        won,
        mode: room.mode,
        guesses: room.guesses.filter((g) => g.playerId === seat.playerId)
          .length,
      });
      save("cw-mp-stats", games);
    }
    setDialog("room-result");
    if (settings.sound && won) victorySound();
  }, [room, seat, settings.sound]);
  useEffect(() => {
    if (room?.status === "waiting" && dialog === "room-result") setDialog(null);
  }, [room?.status, dialog]);
  function updateRoom(next) {
    setRoom((current) =>
      current &&
      current.code === next.code &&
      Number.isInteger(current.revision) &&
      Number.isInteger(next.revision) &&
      next.revision < current.revision
        ? current
        : next,
    );
  }
  async function run(fn) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function enter(data) {
    const nextSeat = { token: data.token, playerId: data.playerId };
    save(`cw-room-${data.room.code}`, nextSeat);
    setSeat(nextSeat);
    setRoom(data.room);
  }
  async function createRoom(random) {
    await run(async () => {
      const data = await api(random ? "/api/match" : "/api/rooms", {
        name,
        mode,
        maxPlayers: capacity,
      });
      enter(data);
      await router.push(`/multiplayer/m/${data.room.code}`, undefined, {
        shallow: true,
      });
    });
  }
  async function joinRoom(code) {
    await run(async () => {
      if (!/^[A-Z0-9]{6}$/.test(code))
        throw Error("Enter a six-character room code.");
      const saved = readSaved(`cw-room-${code}`, null);
      const data = await api(`/api/rooms/${code}/join`, {
        name,
        token: saved?.token,
      });
      enter(data);
      await router.push(`/multiplayer/m/${data.room.code}`, undefined, {
        shallow: true,
      });
    });
  }
  async function roomAction(action, extra = {}) {
    await run(async () => {
      const result = await api(`/api/rooms/${room.code}/${action}`, {
        token: seat.token,
        ...extra,
      });
      updateRoom(result);
      if (action === "guess") setWord("");
      if (action === "rematch") setDialog(null);
    });
  }
  async function leave(e) {
    e?.preventDefault();
    if (lock.current) return;
    await run(async () => {
      if (room && seat) {
        await api(`/api/rooms/${room.code}/leave`, { token: seat.token });
        try {
          localStorage.removeItem(`cw-room-${room.code}`);
        } catch {}
      }
      setRoom(null);
      setSeat(null);
      lastWin.current = "";
      await router.push("/multiplayer", undefined, { shallow: true });
    });
  }
  async function startSolo(gameMode) {
    await run(async () => {
      setSolo(null);
      setWord("");
      setSoloMode(gameMode);
      setDialog(null);
      setSolo(await api("/api/solo/new", { mode: gameMode, device }));
    });
  }
  async function guessSolo(hint = false) {
    if (!solo) return;
    await run(async () => {
      const result = {
        ...solo,
        ...(await api(`/api/solo/${hint ? "hint" : "guess"}`, {
          token: solo.token,
          word: word.trim(),
          difficulty: settings.difficulty,
        })),
      };
      setSolo(result);
      if (!hint) setWord("");
      if (result.won) {
        const games = readSaved("cw-stats", []);
        if (!games.some((g) => g.token === result.token)) {
          games.push({
            token: result.token,
            mode: result.mode,
            guesses: result.guesses.length,
            date: new Date().toISOString().slice(0, 10),
          });
          save("cw-stats", games);
        }
        setDialog("solo-result");
      }
    });
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setToast("Copied to clipboard");
    } catch {
      setToast("Select and copy the link below.");
    }
  }
  const guessed = solo?.guesses || [];
  const host = room?.host === seat?.playerId,
    waiting = room?.status === "waiting",
    playing = room?.status === "playing",
    finished = room?.status === "finished";
  const current = room?.players.find((p) => p.id === room.turn),
    canGuess =
      playing && (room.mode === "race" || room.turn === seat?.playerId);
  const guesses = room
    ? room.mode === "race"
      ? room.guesses.filter((g) => g.playerId === seat?.playerId)
      : room.guesses
    : [];
  const inviteUrl = room ? `${origin}/multiplayer/m/${room.code}` : "";
  const title = mp ? "Multiplayer — CloseWord" : "CloseWord — Daily Word Game";
  return (
    <>
      <Head>
        <title>{title}</title>
        <meta
          name="description"
          content="Find the secret word. Play daily, practice, or race up to six friends online."
        />
      </Head>
      <header>
        <div className="header-inner">
          <div className="header-side">
            {mp || path === "/challenge" ? (
              <Link
                className="icon-btn"
                href={room ? "/multiplayer" : "/"}
                aria-label={room ? "Leave" : "Back to the game"}
                onClick={room ? leave : undefined}
              >
                <Icon name="back" />
              </Link>
            ) : (
              <>
                <button
                  className="icon-btn"
                  aria-label="How to play"
                  onClick={() => setDialog("help")}
                >
                  <Icon name="help" />
                </button>
                <Link
                  className="icon-btn"
                  href="/challenge"
                  aria-label="Create a challenge"
                >
                  <Icon name="plus" />
                </Link>
              </>
            )}
          </div>
          <Link className="brand" href="/">
            <strong>CloseWord</strong>
            <span>
              {mp ? "MULTIPLAYER · SIX PLAYERS" : "GUESS THE SECRET WORD"}
            </span>
          </Link>
          <div className="header-side">
            <button
              className="icon-btn"
              aria-label={mp ? "Your stats" : "Statistics"}
              onClick={() => setDialog("stats")}
            >
              <Icon name="stats" />
            </button>
            {mp && (
              <button
                className="icon-btn"
                aria-label="Leaderboard"
                onClick={() => setDialog("leaderboard")}
              >
                <Icon name="trophy" />
              </button>
            )}
            <button
              className="icon-btn"
              aria-label="Settings"
              onClick={() => setDialog("settings")}
            >
              <Icon name="settings" />
            </button>
          </div>
        </div>
      </header>
      {!ready ? (
        <main>
          <p className="loading">Loading…</p>
        </main>
      ) : mp ? (
        !room ? (
          <main className="mp-main">
            <h1>{invite ? "Join your friends" : "Six minds, one word"}</h1>
            <p className="intro">
              {invite ? (
                "Choose a nickname and join the room."
              ) : (
                <>
                  Race friends or other players to guess the secret word.
                  <br />
                  First to find it wins — up to six can play.
                </>
              )}
            </p>
            {!name ? (
              <form
                id="nickname-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = nameInput.trim().slice(0, 24);
                  if (next) {
                    setName(next);
                    save("cw-name", next);
                    setError("");
                  }
                }}
              >
                <label className="field-label" htmlFor="nickname">
                  Choose a nickname
                </label>
                <div className="guess-form">
                  <input
                    id="nickname"
                    name="nickname"
                    placeholder="Your nickname"
                    autoComplete="nickname"
                    maxLength={24}
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    required
                  />
                  <button className="square" aria-label="Continue">
                    <Icon name="arrow" />
                  </button>
                </div>
                <div className="under">
                  Play anonymously — no account needed.
                </div>
              </form>
            ) : (
              <>
                <div className="profile">
                  <span className="avatar">🦁</span>
                  <div>
                    <strong>{name}</strong>
                    <small>Ready to play</small>
                  </div>
                  <button
                    className="text-btn"
                    onClick={() => {
                      setNameInput(name);
                      setName("");
                      save("cw-name", "");
                    }}
                  >
                    switch
                  </button>
                </div>
                {invite ? (
                  <>
                    <div className="status-banner">
                      Room {invite} · up to 6 players
                    </div>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => joinRoom(invite)}
                    >
                      Join game <Icon name="arrow" />
                    </button>
                  </>
                ) : (
                  <>
                    <div className="mode-label">
                      <b>1</b> CHOOSE A GAME MODE
                    </div>
                    <div
                      className="modes"
                      role="radiogroup"
                      aria-label="Game mode"
                    >
                      {[
                        [
                          "turn",
                          "⚔️",
                          "Turn-by-turn",
                          "Take turns on the same word",
                        ],
                        [
                          "race",
                          "🏁",
                          "Speed race",
                          "Everyone guesses — fastest wins",
                        ],
                      ].map(([value, emoji, label, detail]) => (
                        <button
                          key={value}
                          className={`mode ${mode === value ? "active" : ""}`}
                          role="radio"
                          aria-checked={mode === value}
                          onClick={() => {
                            setMode(value);
                            save("cw-mode", value);
                          }}
                        >
                          <span className="emoji">{emoji}</span>
                          <strong>{label}</strong>
                          <small>{detail}</small>
                          {mode === value && <span className="check">✓</span>}
                        </button>
                      ))}
                    </div>
                    <div className="player-limit">
                      <label htmlFor="player-limit">
                        <strong>Number of players</strong>
                        <small>Room limit, including you</small>
                      </label>
                      <select
                        id="player-limit"
                        value={capacity}
                        onChange={(e) => {
                          setCapacity(Number(e.target.value));
                          save("cw-player-limit", e.target.value);
                        }}
                      >
                        {[2, 3, 4, 5, 6].map((n) => (
                          <option key={n} value={n}>
                            {n} players
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="mode-label">
                      <b>2</b> START A GAME
                    </div>
                    <button
                      className="action-card solid"
                      disabled={busy}
                      onClick={() => createRoom(true)}
                    >
                      <span className="action-icon">
                        <Icon name="bolt" />
                      </span>
                      <span>
                        <strong>Find other players</strong>
                        <small>Get matched and play together</small>
                      </span>
                      <span className="capacity" style={{ marginLeft: "auto" }}>
                        {capacity} players
                      </span>
                    </button>
                    <button
                      className="action-card"
                      disabled={busy}
                      onClick={() => createRoom(false)}
                    >
                      <span className="action-icon">
                        <Icon name="link" />
                      </span>
                      <span>
                        <strong>Invite friends</strong>
                        <small>Create a private game and share the link</small>
                      </span>
                      <span className="trailing">
                        <Icon name="arrow" />
                      </span>
                    </button>
                    <div className="or">OR JOIN WITH A CODE</div>
                    <form
                      className="guess-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        joinRoom(codeInput.trim().toUpperCase());
                      }}
                    >
                      <input
                        placeholder="ENTER CODE (E.G. K7P2QM)"
                        aria-label="Room code"
                        maxLength={6}
                        autoCapitalize="characters"
                        value={codeInput}
                        onChange={(e) => setCodeInput(e.target.value)}
                        required
                      />
                      <button
                        className="square"
                        aria-label="Join"
                        disabled={busy}
                      >
                        <Icon name="arrow" />
                      </button>
                    </form>
                  </>
                )}
              </>
            )}
            {busy && <p className="loading">Connecting…</p>}
            <ErrorMessage error={error} />
            <section className="leaderboard">
              <div className="leader-head">
                <h2>Top players</h2>
                <div
                  className="segments"
                  role="tablist"
                  aria-label="Leaderboard period"
                >
                  {[
                    ["week", "Week"],
                    ["month", "Month"],
                    ["all", "All time"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={period === value ? "active" : ""}
                      role="tab"
                      aria-selected={period === value}
                      onClick={() => setPeriod(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="leaders">
                <Leaders rows={leaders} limit={5} />
              </div>
              <button
                className="outline"
                onClick={() => setDialog("leaderboard")}
              >
                View all
              </button>
            </section>
          </main>
        ) : (
          <main className="mp-main">
            <div className="round-label">
              {room.mode === "race" ? "🏁 SPEED RACE" : "⚔️ TURN-BY-TURN"} ·
              ROUND {room.round}
            </div>
            <div
              className={`players ${room.players.length === 1 ? "single" : ""}`}
            >
              {room.players.map((p) => (
                <div
                  key={p.id}
                  className={`player-card ${p.id === seat.playerId ? "me" : ""} ${playing && p.id === room.turn && room.mode === "turn" ? "current" : ""}`}
                >
                  <span
                    className="avatar"
                    style={{
                      background: [
                        "#e5b8e3",
                        "#b9cce7",
                        "#efd0ac",
                        "#c2dab5",
                        "#d1c4e8",
                        "#e8c0ac",
                      ][p.avatar],
                    }}
                  >
                    {avatars[p.avatar]}
                  </span>
                  <div className="player-details">
                    <strong className="player-name">
                      {p.name}{" "}
                      {p.id === seat.playerId && (
                        <span className="you">you</span>
                      )}
                    </strong>
                    <div className="player-meta">
                      {waiting
                        ? `${p.id === room.host ? "Host" : "Player"} · ${p.online ? "online" : "away"}`
                        : p.bestRank
                          ? `Best ${rankLabel(p.bestRank)} · ${p.guessCount} ${p.guessCount === 1 ? "guess" : "guesses"}`
                          : "No guesses yet"}
                    </div>
                    <PlayerProximity
                      name={p.name}
                      rank={waiting ? null : p.bestRank}
                    />
                  </div>
                  {p.score > 0 && <span className="you">{p.score} ★</span>}
                </div>
              ))}
            </div>
            <div className="status-banner">
              {waiting ? (
                <>
                  Waiting for{" "}
                  {room.players.length === 1
                    ? "players to join…"
                    : host
                      ? "you to start…"
                      : "the host to start…"}
                  <span
                    style={{
                      display: "block",
                      fontSize: 12,
                      opacity: 0.7,
                      marginTop: 3,
                    }}
                  >
                    {room.players.length} / {room.maxPlayers} players
                  </span>
                </>
              ) : finished ? (
                `🎉 ${room.players.find((p) => p.id === room.winner)?.name || "A player"} found the word!`
              ) : room.mode === "race" ? (
                "The race is on — find the secret word!"
              ) : room.turn === seat.playerId ? (
                "Your turn — make a guess!"
              ) : (
                `${current?.name || "Another player"}’s turn…`
              )}
            </div>
            {waiting && (
              <>
                <p className="share-label">
                  Share this link to invite friends:
                </p>
                <div className="share-form">
                  <input aria-label="Invite link" value={inviteUrl} readOnly />
                  <button className="primary" onClick={() => copy(inviteUrl)}>
                    Copy
                  </button>
                </div>
                <div className="room-code">
                  ROOM CODE <strong>{room.code}</strong>
                </div>
                <div className="room-actions">
                  {host ? (
                    <button
                      className="primary"
                      disabled={busy || room.players.length < 2}
                      onClick={() => roomAction("start")}
                    >
                      Start game <Icon name="arrow" />
                    </button>
                  ) : (
                    <p className="under">
                      The host will start when everyone is ready.
                    </p>
                  )}
                </div>
                <p className="mp-note">
                  Invite up to {room.maxPlayers - 1}{" "}
                  {room.maxPlayers === 2 ? "friend" : "friends"}. Everyone opens
                  the same link on their own device.
                  <br />
                  This room allows up to {room.maxPlayers} players.
                </p>
              </>
            )}
            <section className="room-game">
              <GuessForm
                multiplayer
                word={word}
                setWord={setWord}
                onGuess={() => roomAction("guess", { word: word.trim() })}
                disabled={!canGuess || busy}
                placeholder={
                  waiting
                    ? "Waiting for players…"
                    : finished
                      ? "Round complete"
                      : canGuess
                        ? "Type a word..."
                        : `Waiting for ${current?.name || "your turn"}…`
                }
                error={error}
              />
              <div className="room-status">
                <span>
                  {room.mode === "race" ? "Your guesses" : "Shared board"}
                </span>
                <span className="connection">
                  <span className={`dot ${connected ? "" : "off"}`} />
                  {connected ? "Connected" : "Reconnecting…"}
                </span>
                {canGuess && room.mode === "turn" && (
                  <button
                    className="text-btn"
                    disabled={busy}
                    onClick={() => roomAction("skip")}
                  >
                    Skip turn
                  </button>
                )}
              </div>
              {guesses.length ? (
                <>
                  <Counts guesses={guesses}>
                    <span className="label">LOWER IS CLOSER</span>
                  </Counts>
                  <GuessList guesses={guesses} />
                </>
              ) : (
                playing && (
                  <div className="mini-empty">
                    Every word brings you closer.
                    <br />
                    Guess an English word to get started.
                  </div>
                )
              )}
            </section>
            {finished && (
              <div className="room-actions">
                {host ? (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => roomAction("rematch")}
                  >
                    Play again
                  </button>
                ) : (
                  <span className="under">
                    Waiting for the host to start a rematch.
                  </span>
                )}
                <button
                  className="outline"
                  onClick={() => setDialog("room-result")}
                >
                  View result
                </button>
              </div>
            )}
          </main>
        )
      ) : path === "/challenge" ? (
        <main className="challenge-page">
          <h1>Create a challenge</h1>
          <p>
            Choose a secret word and challenge your friends to find it. Share a
            link so they can play the same puzzle.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const data = await api("/api/challenge", { word: word.trim() });
                setChallenge(`${origin}/challenge/${data.code}`);
              });
            }}
          >
            <label htmlFor="secret" className="field-label">
              Your secret word
            </label>
            <div className="guess-form">
              <input
                id="secret"
                placeholder="Enter an English word"
                autoComplete="off"
                autoCapitalize="none"
                maxLength={40}
                value={word}
                onChange={(e) => setWord(e.target.value)}
                required
              />
              <button
                className="square"
                aria-label="Create challenge"
                disabled={busy}
              >
                <Icon name="arrow" />
              </button>
            </div>
          </form>
          <ErrorMessage error={error} />
          {challenge && (
            <>
              <div className="status-banner">Your challenge is ready!</div>
              <div className="share-form">
                <input aria-label="Challenge link" value={challenge} readOnly />
                <button className="primary" onClick={() => copy(challenge)}>
                  Copy
                </button>
              </div>
            </>
          )}
        </main>
      ) : (
        <main>
          <nav className="daily-tabs" aria-label="Game mode">
            <button
              className={soloMode === "daily" ? "active" : ""}
              disabled={busy}
              onClick={() => startSolo("daily")}
            >
              Daily
            </button>
            <button
              className={soloMode === "practice" ? "active" : ""}
              disabled={busy}
              onClick={() => startSolo("practice")}
            >
              Practice
            </button>
            <Link href="/multiplayer">
              Multiplayer <span className="new">NEW</span>
            </Link>
          </nav>
          <div className="game-date">
            <strong>
              {soloMode === "practice"
                ? "Practice"
                : soloMode === "challenge"
                  ? "A friend’s challenge"
                  : `Game #${solo?.number || "—"}`}
            </strong>
            <span>
              {soloMode === "daily"
                ? new Date().toLocaleDateString("en-US", {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    timeZone: "UTC",
                  })
                : "Find the secret word"}
            </span>
            {soloMode === "practice" && (
              <button
                className="text-btn"
                disabled={busy}
                onClick={() => startSolo("practice")}
              >
                New game
              </button>
            )}
          </div>
          <GuessForm
            word={word}
            setWord={setWord}
            onGuess={() => guessSolo()}
            disabled={!solo || solo.won || busy}
            placeholder={solo?.won ? "You found the word!" : "Type a word..."}
            error={error}
          />
          {guessed.length > 0 && (
            <div className="last-guess">
              <div className="section-label">LAST GUESS</div>
              <GuessRow guess={guessed.at(-1)} />
            </div>
          )}
          <Counts guesses={guessed}>
            <div className="hint-group">
              <button
                className="hint-btn"
                disabled={!solo || solo.won || solo.hints >= 3 || busy}
                onClick={() => guessSolo(true)}
              >
                <Icon name="hint" /> Hint
              </button>
              <small>{3 - (solo?.hints || 0)} REMAINING</small>
            </div>
          </Counts>
          {guessed.length ? <GuessList guesses={guessed} /> : <EmptyState />}
        </main>
      )}
      {dialog && (
        <GameDialog
          type={dialog}
          close={() => {
            if (dialog === "onboarding") save("cw-onboarded", "1");
            setDialog(null);
          }}
          settings={settings}
          setSettings={setSettings}
          multiplayer={mp}
          room={room}
          seat={seat}
          solo={solo}
          soloMode={soloMode}
          leaders={leaders}
          busy={busy}
          rematch={() => roomAction("rematch")}
          practice={() => startSolo("practice")}
          copy={copy}
          origin={origin}
        />
      )}
      <div
        id="toast"
        role="status"
        aria-live="polite"
        className={toast ? "show" : ""}
      >
        {toast}
      </div>
    </>
  );
}
