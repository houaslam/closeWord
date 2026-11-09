import { useEffect, useState } from "react";
import { Icon, Modal, Leaders } from "./ui.jsx";
import { api, readSaved } from "../lib/client.js";
function StatGrid({ values }) {
  return (
    <div className="stat-grid">
      {values.map(([value, label]) => (
        <div key={label} className="count">
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
const slides = [
  [
    "Welcome to CloseWord!",
    "Find the secret word using semantic clues. Let’s walk through how it works.",
  ],
  [
    "Guess any word",
    "Type any English word and press Enter to submit your guess.",
  ],
  [
    "Lower rank = closer",
    "Each guess is ranked by meaning. Rank 1 means you found the secret word!",
  ],
  [
    "Follow the colors",
    "Green means very close, yellow means warm, and gray means far away.",
  ],
  [
    "A little help",
    "You have three hints per game. Find more ways to play in Practice and Multiplayer.",
  ],
  ["Ready to play?", "Try your first word. A new puzzle is waiting every day!"],
];
function Countdown() {
  const [remaining, setRemaining] = useState("");
  useEffect(() => {
    function tick() {
      const seconds = 86400 - (Math.floor(Date.now() / 1000) % 86400);
      setRemaining(
        [
          Math.floor(seconds / 3600),
          Math.floor((seconds % 3600) / 60),
          seconds % 60,
        ]
          .map((n) => String(n).padStart(2, "0"))
          .join(":"),
      );
    }
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="countdown">
      <span>NEXT PUZZLE IN</span>
      <strong>{remaining}</strong>
    </div>
  );
}
export default function GameDialog({
  type,
  close,
  settings,
  setSettings,
  multiplayer,
  room,
  seat,
  solo,
  soloMode,
  leaders,
  busy,
  rematch,
  practice,
  copy,
  origin,
}) {
  const [tab, setTab] = useState("how"),
    [step, setStep] = useState(0),
    [rows, setRows] = useState(leaders),
    [loadError, setLoadError] = useState("");
  useEffect(() => {
    setTab("how");
    setStep(0);
  }, [type]);
  useEffect(() => {
    if (type !== "leaderboard") return;
    const controller = new AbortController();
    api("/api/leaderboard", undefined, controller.signal)
      .then(setRows)
      .catch((e) => {
        if (e.name !== "AbortError") setLoadError(e.message);
      });
    return () => controller.abort();
  }, [type]);
  const update = (key, value) =>
    setSettings((old) => ({ ...old, [key]: value }));
  let content;
  if (type === "settings")
    content = (
      <>
        <h2>Settings</h2>
        <label className="setting">
          <span>
            <strong>Dark mode</strong>
            <small>Reduce eye strain in low light</small>
          </span>
          <input
            className="switch"
            type="checkbox"
            aria-label="Dark mode"
            checked={settings.dark}
            onChange={(e) => update("dark", e.target.checked)}
          />
        </label>
        {multiplayer ? (
          <label className="setting">
            <span>
              <strong>Sound effects</strong>
              <small>Play sounds during multiplayer games</small>
            </span>
            <input
              className="switch"
              type="checkbox"
              aria-label="Sound effects"
              checked={settings.sound}
              onChange={(e) => update("sound", e.target.checked)}
            />
          </label>
        ) : (
          <div className="setting" style={{ display: "block" }}>
            <strong>Hints</strong>
            <small>
              The hint’s position will be{" "}
              {settings.difficulty === "easy"
                ? "half the position of your closest word"
                : settings.difficulty === "medium"
                  ? "one less than your closest word"
                  : "random"}
            </small>
            <div className="difficulty">
              {["easy", "medium", "hard"].map((value) => (
                <button
                  key={value}
                  className={settings.difficulty === value ? "active" : ""}
                  onClick={() => update("difficulty", value)}
                >
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="setting">
          <span>
            <strong>High Contrast</strong>
            <small>Use a high-contrast palette (blue / orange / gray)</small>
          </span>
          <input
            className="switch"
            type="checkbox"
            aria-label="High contrast"
            checked={settings.contrast}
            onChange={(e) => update("contrast", e.target.checked)}
          />
        </label>
        <div className="fine">
          CloseWord · A daily word game
          <br />
          Six-player edition
        </div>
      </>
    );
  else if (type === "onboarding")
    content = (
      <>
        <div className="dots">
          {slides.map((_, i) => (
            <i key={i} className={i === step ? "active" : ""} />
          ))}
        </div>
        <h2>{slides[step][0]}</h2>
        <p>{slides[step][1]}</p>
        <div className="onboard-actions">
          <button className="text-btn" onClick={close}>
            Skip
          </button>
          <button
            className="primary"
            onClick={() =>
              step === slides.length - 1 ? close() : setStep(step + 1)
            }
          >
            {step === slides.length - 1 ? "Let’s play" : "Next"}
          </button>
        </div>
      </>
    );
  else if (type === "room-result" && room) {
    const won = room.winner === seat?.playerId,
      winner = room.players.find((p) => p.id === room.winner);
    content = (
      <>
        <div style={{ fontSize: 38 }}>{won ? "🎉" : "🏆"}</div>
        <h2>{won ? "You won!" : `${winner?.name || "A player"} won!`}</h2>
        <p>The secret word was</p>
        <div className="answer">{room.answer?.toUpperCase()}</div>
        <p>
          {room.guesses.filter((g) => g.playerId === room.winner).length}{" "}
          guesses by the winner · Round {room.round}
        </p>
        {room.host === seat?.playerId ? (
          <button className="primary" disabled={busy} onClick={rematch}>
            Play again
          </button>
        ) : (
          <p>Waiting for the host to start a rematch.</p>
        )}
        <button className="outline" onClick={close}>
          View board
        </button>
      </>
    );
  } else if (type === "solo-result" && solo)
    content = (
      <>
        <h2>Brilliant!</h2>
        <div className="answer">{solo.answer?.toUpperCase()}</div>
        <StatGrid
          values={[
            [solo.guesses.length, "GUESSES"],
            [solo.hints, "HINTS USED"],
          ]}
        />
        <button
          className="primary"
          onClick={() =>
            copy(
              `CloseWord ${soloMode === "daily" ? `#${solo.number}` : "Practice"}\nFound ${solo.answer} in ${solo.guesses.length} guesses · ${solo.hints} hints\n${origin}`,
            )
          }
        >
          <Icon name="share" /> Share result
        </button>
        <button className="outline" disabled={busy} onClick={practice}>
          Play another
        </button>
        {soloMode === "daily" && <Countdown />}
      </>
    );
  else if (type === "leaderboard")
    content = (
      <>
        <h2>Leaderboard</h2>
        <div className="leaders">
          <Leaders rows={rows} />
          {loadError && (
            <p role="alert" className="error">
              {loadError}
            </p>
          )}
        </div>
      </>
    );
  else if (type === "stats" && multiplayer) {
    const games = readSaved("cw-mp-stats", []),
      wins = games.filter((g) => g.won);
    content = (
      <>
        <h2>Your stats</h2>
        <StatGrid
          values={[
            [games.length, "GAMES"],
            [wins.length, "WINS"],
            [
              games.length
                ? Math.round((wins.length / games.length) * 100) + "%"
                : "—",
              "WIN RATE",
            ],
          ]}
        />
        <p>
          {games.length
            ? "Keep playing to build your record."
            : "Play a multiplayer round to start your record."}
        </p>
        <p>Your multiplayer record is saved in this browser.</p>
      </>
    );
  } else if (type === "stats") {
    const all = readSaved("cw-stats", []),
      wins = all.filter(
        (g) => g.mode === (tab === "practice" ? "practice" : "daily"),
      ),
      dates = [
        ...new Set(all.filter((g) => g.mode === "daily").map((g) => g.date)),
      ].sort();
    let longest = 0,
      run = 0,
      previous = 0;
    for (const date of dates) {
      const day = Date.parse(date) / 86400000;
      run = day === previous + 1 ? run + 1 : 1;
      previous = day;
      longest = Math.max(longest, run);
    }
    const streak = previous >= Math.floor(Date.now() / 86400000) - 1 ? run : 0;
    content = (
      <>
        <h2>Statistics</h2>
        <div className="daily-tabs">
          {["daily", "practice"].map((value) => (
            <button
              key={value}
              className={
                (tab === "practice" ? "practice" : "daily") === value
                  ? "active"
                  : ""
              }
              onClick={() => setTab(value)}
            >
              {value === "daily" ? "Daily" : "Practice"}
            </button>
          ))}
        </div>
        <StatGrid
          values={[
            [wins.length, "GAMES"],
            [wins.length, "WINS"],
            [tab === "practice" ? "—" : streak, "STREAK"],
            [tab === "practice" ? "—" : longest, "BEST STREAK"],
          ]}
        />
        <h3>Guess Distribution</h3>
        {wins.length ? (
          [10, 25, 50, 100, Infinity].map((limit, i) => {
            const low = [0, 10, 25, 50, 100][i],
              count = wins.filter(
                (g) => g.guesses > low && g.guesses <= limit,
              ).length;
            return (
              <div
                key={limit}
                className="distribute"
                style={{
                  "--fill": `${Math.max(5, (count / wins.length) * 100)}%`,
                }}
              >
                {i === 4 ? "100+" : `${low + 1}–${limit}`}
                <strong style={{ marginLeft: "auto" }}>{count}</strong>
              </div>
            );
          })
        ) : (
          <p style={{ marginTop: 20 }}>
            Solve a puzzle to see your statistics.
          </p>
        )}
      </>
    );
  } else
    content = (
      <>
        <h2>How to Play</h2>
        <div className="daily-tabs" role="tablist">
          {[
            ["how", "How to Play"],
            ["tips", "Tips"],
            ["faq", "FAQ"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={tab === value ? "active" : ""}
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "how" ? (
          <>
            <p>Find the secret word. Lower rank means closer.</p>
            <div className="help-section">
              <strong>Guess any word</strong>
              <p>
                Type a word and submit it. Each guess is ranked by how
                semantically close it is to the secret word.
              </p>
            </div>
            <div className="help-section">
              <strong>Watch the colors</strong>
              <p>Green = very close. Yellow = getting warm. Gray = far away.</p>
            </div>
            <div className="help-section">
              <strong>Use hints wisely</strong>
              <p>
                You have three hints per solo game. A new daily puzzle arrives
                at midnight UTC.
              </p>
            </div>
          </>
        ) : tab === "tips" ? (
          <>
            <div className="help-section">
              <strong>Think about meaning</strong>
              <p>
                “Wave” and “beach” can both be close to “ocean”. Spelling and
                word length do not matter.
              </p>
            </div>
            <div className="help-section">
              <strong>Start broad, then narrow down</strong>
              <p>
                Try people, nature, food, and places. Follow your best guesses
                and explore synonyms.
              </p>
            </div>
            <p>Change hint difficulty in Settings.</p>
          </>
        ) : (
          <>
            <div className="help-section">
              <strong>How are guesses ranked?</strong>
              <p>Words are compared using GloVe word embeddings.</p>
            </div>
            <div className="help-section">
              <strong>When does the daily puzzle change?</strong>
              <p>A new puzzle arrives at midnight UTC.</p>
            </div>
            <div className="help-section">
              <strong>Can I play with friends?</strong>
              <p>
                Open Multiplayer, create a room, and invite up to five friends.
                Take turns or race simultaneously.
              </p>
            </div>
          </>
        )}
      </>
    );
  return (
    <Modal
      onClose={close}
      label={
        type === "settings"
          ? "Settings"
          : type === "room-result" || type === "solo-result"
            ? "Game result"
            : "Game dialog"
      }
      variant={
        type.includes("result")
          ? "victory"
          : type === "onboarding"
            ? "onboarding"
            : ""
      }
    >
      {content}
    </Modal>
  );
}
