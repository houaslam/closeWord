import { useEffect, useRef } from "react";
export const avatars = ["🦁", "🐼", "🦊", "🐸", "🐨", "🐯"];
const paths = {
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.6-2.5 1.8-2.5 3.5m0 3h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  stats: <path d="M5 19v-7m7 7V5m7 14v-9" />,
  settings: (
    <>
      <path d="m9 4 1-2h4l1 2 2 1 2-.2 2 3-1.2 2v3l1.2 2-2 3-2-.2-2 1-1 2h-4l-1-2-2-1-2 .2-2-3 1.2-2v-3L3 8l2-3 2 .2Z" />
      <circle cx="12" cy="11" r="3" />
    </>
  ),
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  back: <path d="M19 12H5m6-6-6 6 6 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  trophy: (
    <path d="M8 3h8v6a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 1v6m-4 2h8" />
  ),
  link: (
    <path d="m10 14 4-4m-6 2-2 2a4 4 0 0 0 6 6l3-3m-6-10 3-3a4 4 0 0 1 6 6l-2 2" />
  ),
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" />,
  hint: (
    <path d="M9 18h6m-5 3h4m-6-9a6 6 0 1 1 8 0c-1 .8-1 1-1 3H9c0-2 0-2.2-1-3Z" />
  ),
  share: <path d="M12 16V3m-4 4 4-4 4 4M5 12v8h14v-8" />,
};
export function Icon({ name }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name] || paths.arrow}
    </svg>
  );
}
export const rankLabel = (rank) => (rank > 30000 ? "30000+" : String(rank));
export function GuessRow({ guess: g }) {
  const fill =
    g.rank === 1
      ? 100
      : Math.max(5, Math.min(98, 100 - Math.log10(g.rank) * 21));
  return (
    <div
      className={`guess-row ${g.rank <= 300 ? "hot" : g.rank <= 1500 ? "warm" : ""}`}
      style={{ "--fill": `${fill}%` }}
    >
      <span className="word">
        {g.word}
        {g.hint && <span className="hint-label">HINT</span>}
        {g.name && <small>{g.name}</small>}
      </span>
      <strong>{rankLabel(g.rank)}</strong>
    </div>
  );
}
export function GuessForm({
  word,
  setWord,
  onGuess,
  disabled,
  placeholder = "Type a word...",
  multiplayer = false,
  error,
}) {
  const input = useRef(null);
  useEffect(() => {
    if (!disabled) input.current?.focus({ preventScroll: true });
  }, [disabled]);
  return (
    <>
      <form
        className="guess-form"
        id="guess-form"
        onSubmit={(e) => {
          e.preventDefault();
          onGuess();
        }}
      >
        <input
          ref={input}
          id="guess-input"
          name="word"
          value={word}
          onChange={(e) => setWord(e.target.value)}
          placeholder={placeholder}
          aria-label="Your guess"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={40}
          disabled={disabled}
          required
        />
        <button
          className="square"
          type="submit"
          aria-label={multiplayer ? "Guess" : "Submit guess"}
          disabled={disabled}
        >
          <Icon name="arrow" />
        </button>
      </form>
      <ErrorMessage error={error} />
    </>
  );
}
export function ErrorMessage({ error }) {
  return (
    <p id="form-error" className="error empty-error" role="alert">
      {error}
    </p>
  );
}
export function EmptyState() {
  return (
    <section className="empty">
      <h2>How to play</h2>
      <ol className="instructions">
        {[
          <>Type any English word and submit your guess</>,
          <>Each guess is ranked by how close it is to the secret word</>,
          <>
            Lower rank = closer. <strong>Rank 1</strong> means you found it!
          </>,
        ].map((text, i) => (
          <li key={i}>
            <span className="step">{i + 1}</span>
            <span>{text}</span>
          </li>
        ))}
      </ol>
      <div className="sample">
        {[
          { word: "wave", rank: 3 },
          { word: "summer", rank: 380 },
          { word: "pen", rank: 8204 },
        ].map((g) => (
          <GuessRow key={g.word} guess={g} />
        ))}
      </div>
    </section>
  );
}
export function Counts({ guesses, children }) {
  const best = guesses.length ? Math.min(...guesses.map((g) => g.rank)) : null;
  return (
    <div className="stats-bar">
      <div className="counts">
        <div className="count">
          <strong>{guesses.length}</strong>
          <span>GUESSES</span>
        </div>
        <div className="count">
          <strong>{best ? rankLabel(best) : "—"}</strong>
          <span>BEST</span>
        </div>
      </div>
      {children}
    </div>
  );
}
export function GuessList({ guesses }) {
  return (
    <div className="guess-list">
      {[...guesses]
        .sort((a, b) => a.rank - b.rank)
        .map((g, i) => (
          <GuessRow key={`${g.playerId || "solo"}:${g.word}:${i}`} guess={g} />
        ))}
    </div>
  );
}
export function Modal({
  children,
  onClose,
  variant = "",
  label = "Game dialog",
}) {
  const ref = useRef(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector("button")?.focus();
    function key(e) {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const focusable = [
          ...ref.current.querySelectorAll("button,input,a,select"),
        ].filter((el) => !el.disabled);
        const first = focusable[0],
          last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", key);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${variant}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={ref}
      >
        <button className="icon-btn close" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
        {children}
      </div>
    </div>
  );
}
export function Leaders({ rows, limit = 50 }) {
  return rows.length ? (
    <>
      {rows.slice(0, limit).map((p, i) => (
        <div key={`${p.name}:${i}`} className="leader-row">
          <span className="place">{["🏆", "🥈", "🥉"][i] || i + 1}</span>
          <span className="avatar">{avatars[i % 6]}</span>
          <span>{p.name}</span>
          <strong>+{p.score}</strong>
        </div>
      ))}
    </>
  ) : (
    <div className="no-leaders">
      The leaderboard is waiting for its first wordsmith.
      <br />
      Win a multiplayer game to take the lead.
    </div>
  );
}
