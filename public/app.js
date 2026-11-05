const $ = (s) => document.querySelector(s);
const app = $("#app"),
  modalRoot = $("#modal-root");
const icons = {
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.6-2.5 1.8-2.5 3.5m0 3h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  stats: '<path d="M5 19v-7m7 7V5m7 14v-9"/>',
  settings:
    '<path d="m9 4 1-2h4l1 2 2 1 2-.2 2 3-1.2 2v3l1.2 2-2 3-2-.2-2 1-1 2h-4l-1-2-2-1-2 .2-2-3 1.2-2v-3L3 8l2-3 2 .2Z"/><circle cx="12" cy="11" r="3"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  trophy:
    '<path d="M8 3h8v6a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 1v6m-4 2h8"/>',
  link: '<path d="m10 14 4-4m-6 2-2 2a4 4 0 0 0 6 6l3-3m-6-10 3-3a4 4 0 0 1 6 6l-2 2"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  hint: '<path d="M9 18h6m-5 3h4m-6-9a6 6 0 1 1 8 0c-1 .8-1 1-1 3H9c0-2 0-2.2-1-3Z"/>',
  share: '<path d="M12 16V3m-4 4 4-4 4 4M5 12v8h14v-8"/>',
};
const icon = (n) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[n] || icons.arrow}</svg>`;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const avatars = ["🦁", "🐼", "🦊", "🐸", "🐨", "🐯"];
const settings = JSON.parse(
  localStorage.getItem("cw-settings") ||
    '{"dark":true,"contrast":false,"difficulty":"easy","sound":true}',
);
function applySettings() {
  document.documentElement.classList.toggle("dark", settings.dark);
  document.documentElement.classList.toggle("contrast", settings.contrast);
  localStorage.setItem("cw-settings", JSON.stringify(settings));
}
applySettings();
let account = null,
  emailAvailable = false;
let nickname = localStorage.getItem("cw-name") || "",
  gameMode = localStorage.getItem("cw-mode") || "turn";
let playerLimit = Number(localStorage.getItem("cw-player-limit")) || 6;
if (!Number.isInteger(playerLimit) || playerLimit < 2 || playerLimit > 6)
  playerLimit = 6;
let solo = null,
  soloMode = "daily",
  room = null,
  credentials = null,
  events = null,
  connected = false,
  pending = false,
  leaderboard = [],
  lastWin = "",
  onboardStep = 0;
const device =
  localStorage.getItem("cw-device") ||
  crypto.randomUUID?.() ||
  `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
localStorage.setItem("cw-device", device);
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 3000);
}
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || "Something went wrong. Try again.");
  return data;
}
function errorText(message) {
  const el = $("#form-error");
  if (el) el.textContent = message;
  else toast(message);
}
function header(mp = false, back = false) {
  return `<header><div class="header-inner"><div class="header-side">${mp || back ? `<a class="icon-btn" href="${room ? "/multiplayer" : "/"}" aria-label="${room ? "Leave" : "Back to the game"}" ${room ? 'data-leave="true"' : ""}>${icon("back")}</a>` : `<button class="icon-btn" data-modal="help" aria-label="How to play">${icon("help")}</button><a class="icon-btn" href="/challenge" aria-label="Create a challenge">${icon("plus")}</a>`}</div><a class="brand" href="/"><strong>CloseWord</strong><span>${mp ? "MULTIPLAYER · SIX PLAYERS" : "GUESS THE SECRET WORD"}</span></a><div class="header-side"><button class="icon-btn" data-modal="stats" aria-label="${mp ? "Your stats" : "Statistics"}">${icon("stats")}</button>${mp ? `<button class="icon-btn" data-modal="leaderboard" aria-label="Leaderboard">${icon("trophy")}</button>` : ""}<button class="icon-btn" data-modal="settings" aria-label="Settings">${icon("settings")}</button></div></div></header>${accountNav()}`;
}
const rankLabel = (r) => (r > 30000 ? "30000+" : String(r));
function guessRow(g, small = false) {
  const heat = g.rank <= 300 ? "hot" : g.rank <= 1500 ? "warm" : "";
  const fill =
    g.rank === 1
      ? 100
      : Math.max(5, Math.min(98, 100 - Math.log10(g.rank) * 21));
  return `<div class="guess-row ${heat}" style="--fill:${fill}%"><span class="word">${esc(g.word)}${g.hint ? '<span class="hint-label">HINT</span>' : ""}${g.name ? `<small>${esc(g.name)}</small>` : ""}</span><strong>${rankLabel(g.rank)}</strong></div>`;
}
function guessForm(placeholder = "Type a word...", disabled = false) {
  return `<form class="guess-form" id="guess-form"><input id="guess-input" name="word" placeholder="${esc(placeholder)}" aria-label="Your guess" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="40" ${disabled ? "disabled" : ""} required><button class="square" type="submit" aria-label="${room ? "Guess" : "Submit guess"}" ${disabled ? "disabled" : ""}>${icon("arrow")}</button></form><p id="form-error" class="error empty-error" role="alert"></p>`;
}
function emptyState() {
  return `<section class="empty"><h2>How to play</h2><ol class="instructions"><li><span class="step">1</span><span>Type any English word and submit your guess</span></li><li><span class="step">2</span><span>Each guess is ranked by how close it is to the secret word</span></li><li><span class="step">3</span><span>Lower rank = closer. <strong>Rank 1</strong> means you found it!</span></li></ol><div class="sample">${guessRow({ word: "wave", rank: 3 })}${guessRow({ word: "summer", rank: 380 })}${guessRow({ word: "pen", rank: 8204 })}</div></section>`;
}
async function startSolo(mode = "daily", code) {
  soloMode = mode;
  solo = null;
  renderSolo();
  try {
    solo = await api("/api/solo/new", { mode, device, code });
    renderSolo();
  } catch (e) {
    errorText(e.message);
  }
}
function renderSolo() {
  const d = new Date();
  const guesses = solo?.guesses || [];
  const best = guesses.length ? Math.min(...guesses.map((g) => g.rank)) : null;
  app.innerHTML =
    header() +
    `<main><nav class="daily-tabs" aria-label="Game mode"><button data-solo="daily" class="${soloMode === "daily" ? "active" : ""}">Daily</button><button data-solo="practice" class="${soloMode === "practice" ? "active" : ""}">Practice</button><a href="/multiplayer">Multiplayer <span class="new">NEW</span></a></nav><div class="game-date"><strong>${soloMode === "practice" ? "Practice" : soloMode === "challenge" ? "A friend’s challenge" : `Game #${solo?.number || "—"}`}</strong><span>${soloMode === "daily" ? d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "Find the secret word"}</span>${soloMode === "practice" ? '<button class="text-btn" id="new-practice">New game</button>' : ""}</div>${guessForm(solo?.won ? "You found the word!" : "Type a word...", !solo || solo.won)}${guesses.length ? `<div class="last-guess"><div class="section-label">LAST GUESS</div>${guessRow(guesses.at(-1))}</div>` : ""}<div class="stats-bar"><div class="counts"><div class="count"><strong>${guesses.length}</strong><span>GUESSES</span></div><div class="count"><strong>${best ? rankLabel(best) : "—"}</strong><span>BEST</span></div></div><div class="hint-group"><button class="hint-btn" id="hint-btn" ${!solo || solo.won || solo.hints >= 3 ? "disabled" : ""}>${icon("hint")} Hint</button><small>${3 - (solo?.hints || 0)} REMAINING</small></div></div>${
      guesses.length
        ? `<div class="guess-list">${[...guesses]
            .sort((a, b) => a.rank - b.rank)
            .map((g) => guessRow(g))
            .join("")}</div>`
        : emptyState()
    }</main>`;
  bindCommon();
  $('[data-solo="daily"]').onclick = () => startSolo("daily");
  $('[data-solo="practice"]').onclick = () => startSolo("practice");
  $("#new-practice")?.addEventListener("click", () => startSolo("practice"));
  $("#guess-form").onsubmit = (e) => {
    e.preventDefault();
    submitSolo(false);
  };
  $("#hint-btn").onclick = () => submitSolo(true);
  if (solo && !solo.won) $("#guess-input").focus({ preventScroll: true });
}
async function submitSolo(hint) {
  if (pending) return;
  const word = $("#guess-input").value.trim();
  if (!hint && !word) return;
  pending = true;
  $("#form-error").textContent = "";
  try {
    solo = {
      ...solo,
      ...(await api(`/api/solo/${hint ? "hint" : "guess"}`, {
        token: solo.token,
        word,
        difficulty: settings.difficulty,
      })),
    };
    renderSolo();
    if (solo.won) {
      recordWin();
      showVictory();
    }
  } catch (e) {
    errorText(e.message);
  } finally {
    pending = false;
  }
}
function recordWin() {
  let stats = JSON.parse(localStorage.getItem("cw-stats") || "[]");
  if (!stats.some((s) => s.token === solo.token)) {
    stats.push({
      token: solo.token,
      mode: solo.mode,
      guesses: solo.guesses.length,
      date: new Date().toISOString().slice(0, 10),
    });
    localStorage.setItem("cw-stats", JSON.stringify(stats));
  }
}
async function loadLeaders() {
  try {
    leaderboard = await api("/api/leaderboard");
    const el = $("#leaders");
    if (el) el.innerHTML = leaderRows();
  } catch {}
}
function leaderRows() {
  if (!leaderboard.length)
    return '<div class="no-leaders">The leaderboard is waiting for its first wordsmith.<br>Win a multiplayer game to take the lead.</div>';
  return leaderboard
    .slice(0, 5)
    .map(
      (p, i) =>
        `<div class="leader-row"><span class="place">${["🏆", "🥈", "🥉"][i] || i + 1}</span><span class="avatar">${avatars[i % 6]}</span><span>${esc(p.name)}</span><strong>+${p.score}</strong></div>`,
    )
    .join("");
}
function leaderboardSection() {
  return `<section class="leaderboard"><div class="leader-head"><h2>Top players</h2><div class="segments" role="tablist" aria-label="Leaderboard period"><button class="active" data-period="week" role="tab" aria-selected="true">Week</button><button data-period="month" role="tab" aria-selected="false">Month</button><button data-period="all" role="tab" aria-selected="false">All time</button></div></div><div class="leaders" id="leaders">${leaderRows()}</div><button class="outline" data-modal="leaderboard">View all</button></section>`;
}
function renderLobby(joinCode) {
  app.innerHTML =
    header(true) +
    `<main class="mp-main"><h1>${joinCode ? "Join your friends" : "Six minds, one word"}</h1><p class="intro">${joinCode ? "Choose a nickname and join the room." : "Race friends or other players to guess the secret word.<br>First to find it wins — up to six can play."}</p>${!nickname ? `<form id="nickname-form"><label class="field-label" for="nickname">Choose a nickname</label><div class="guess-form"><input id="nickname" name="nickname" placeholder="Your nickname" autocomplete="nickname" maxlength="24" required><button class="square" aria-label="Continue">${icon("arrow")}</button></div><div class="under">Play anonymously — no account needed.</div></form><p id="form-error" class="error empty-error" role="alert"></p>` : `<div class="profile"><span class="avatar">🦁</span><div><strong>${esc(nickname)}</strong><small>${account ? "Verified account" : "Guest · unrated"}</small></div>${account ? '<a class="text-btn" href="/account">my games</a>' : '<button class="text-btn" id="switch-name">switch</button>'}</div>${joinCode ? `<div class="status-banner">Room ${esc(joinCode)} · up to 6 players</div><button class="primary" id="join-invite">Join game ${icon("arrow")}</button>` : `<div class="mode-label"><b>1</b> CHOOSE A GAME MODE</div><div class="modes" role="radiogroup" aria-label="Game mode"><button class="mode ${gameMode === "turn" ? "active" : ""}" data-mode="turn" role="radio" aria-checked="${gameMode === "turn"}"><span class="emoji">⚔️</span><strong>Turn-by-turn</strong><small>Take turns on the same word</small>${gameMode === "turn" ? '<span class="check">✓</span>' : ""}</button><button class="mode ${gameMode === "race" ? "active" : ""}" data-mode="race" role="radio" aria-checked="${gameMode === "race"}"><span class="emoji">🏁</span><strong>Speed race</strong><small>Everyone guesses — fastest wins</small>${gameMode === "race" ? '<span class="check">✓</span>' : ""}</button></div><div class="player-limit"><label for="player-limit"><strong>Number of players</strong><small>Room limit, including you</small></label><select id="player-limit">${[2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === playerLimit ? "selected" : ""}>${n} players</option>`).join("")}</select></div><div class="mode-label"><b>2</b> START A GAME</div><button class="action-card solid" id="random-game"><span class="action-icon">${icon("bolt")}</span><span><strong>Find other players</strong><small>Get matched and play together</small></span><span class="capacity" style="margin-left:auto">${playerLimit} players</span></button><button class="action-card" id="create-game"><span class="action-icon">${icon("link")}</span><span><strong>Invite friends</strong><small>Create a private game and share the link</small></span><span class="trailing">${icon("arrow")}</span></button><div class="or">OR JOIN WITH A CODE</div><form id="join-form" class="guess-form"><input name="code" id="join-code" placeholder="ENTER CODE (E.G. K7P2QM)" aria-label="Room code" maxlength="6" autocapitalize="characters" required><button class="square" aria-label="Join">${icon("arrow")}</button></form>`}<p id="form-error" class="error empty-error" role="alert"></p>`}${leaderboardSection()}</main>`;
  bindCommon();
  loadLeaders();
  $("#nickname-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#nickname").value.trim();
    if (!name) return;
    nickname = name.slice(0, 24);
    localStorage.setItem("cw-name", nickname);
    renderLobby(joinCode);
  });
  $("#switch-name")?.addEventListener("click", () => {
    nickname = "";
    localStorage.removeItem("cw-name");
    renderLobby(joinCode);
    $("#nickname")?.focus();
  });
  document.querySelectorAll("[data-mode]").forEach(
    (b) =>
      (b.onclick = () => {
        gameMode = b.dataset.mode;
        localStorage.setItem("cw-mode", gameMode);
        renderLobby();
      }),
  );
  $("#player-limit")?.addEventListener("change", (e) => {
    playerLimit = Number(e.target.value);
    localStorage.setItem("cw-player-limit", playerLimit);
    renderLobby();
  });
  $("#create-game")?.addEventListener("click", () => createRoom(false));
  $("#random-game")?.addEventListener("click", () => createRoom(true));
  $("#join-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    joinRoom($("#join-code").value.trim().toUpperCase());
  });
  $("#join-invite")?.addEventListener("click", () => joinRoom(joinCode));
  document.querySelectorAll("[data-period]").forEach(
    (b) =>
      (b.onclick = async () => {
        document.querySelectorAll("[data-period]").forEach((t) => {
          t.classList.toggle("active", t === b);
          t.setAttribute("aria-selected", String(t === b));
        });
        try {
          leaderboard = await api(
            `/api/leaderboard?period=${b.dataset.period}`,
          );
          $("#leaders").innerHTML = leaderRows();
        } catch (e) {
          toast(e.message);
        }
      }),
  );
}
async function createRoom(random) {
  if (pending) return;
  pending = true;
  try {
    const data = await api(random ? "/api/match" : "/api/rooms", {
      name: nickname,
      mode: gameMode,
      maxPlayers: playerLimit,
    });
    enterRoom(data);
    history.pushState({}, "", `/multiplayer/m/${room.code}`);
  } catch (e) {
    errorText(e.message);
  } finally {
    pending = false;
  }
}
async function joinRoom(code) {
  if (pending) return;
  pending = true;
  try {
    const saved = JSON.parse(localStorage.getItem(`cw-room-${code}`) || "null");
    const data = await api(`/api/rooms/${code}/join`, {
      name: nickname,
      token: saved?.token,
    });
    enterRoom(data);
    history.replaceState({}, "", `/multiplayer/m/${room.code}`);
  } catch (e) {
    errorText(e.message);
  } finally {
    pending = false;
  }
}
function enterRoom(data) {
  room = data.room;
  credentials = { token: data.token, playerId: data.playerId };
  localStorage.setItem(`cw-room-${room.code}`, JSON.stringify(credentials));
  renderRoom();
  connectRoom();
}
function connectRoom() {
  events?.close();
  connected = false;
  events = new EventSource(
    `/api/events?code=${room.code}&token=${credentials.token}`,
  );
  events.onopen = () => {
    connected = true;
    updateConnection();
  };
  events.onerror = () => {
    connected = false;
    updateConnection();
  };
  events.onmessage = (e) => {
    const oldStatus = room?.status;
    room = JSON.parse(e.data);
    const active = $("#guess-input");
    const value = active?.value || "";
    const focused = document.activeElement === active;
    renderRoom();
    const input = $("#guess-input");
    if (input) {
      input.value = value;
      if (focused && !input.disabled) input.focus({ preventScroll: true });
    }
    if (
      room.status === "finished" &&
      lastWin !== `${room.code}:${room.round}`
    ) {
      lastWin = `${room.code}:${room.round}`;
      showRoomVictory();
    } else if (oldStatus === "finished" && room.status === "waiting")
      closeModal();
  };
}
function updateConnection() {
  const el = $(".connection");
  if (el)
    el.innerHTML = `<span class="dot ${connected ? "" : "off"}"></span>${connected ? "Connected" : "Reconnecting…"}`;
}
function renderRoom() {
  if (!room) return;
  const me = credentials.playerId,
    host = room.host === me,
    waiting = room.status === "waiting",
    playing = room.status === "playing",
    finished = room.status === "finished";
  const current = room.players.find((p) => p.id === room.turn);
  const canGuess = playing && (room.mode === "race" || room.turn === me);
  const guesses =
    room.mode === "race"
      ? room.guesses.filter((g) => g.playerId === me)
      : room.guesses;
  const best = guesses.length ? Math.min(...guesses.map((g) => g.rank)) : null;
  app.innerHTML =
    header(true) +
    `<main class="mp-main"><div class="round-label">${room.mode === "race" ? "🏁 SPEED RACE" : "⚔️ TURN-BY-TURN"} · ROUND ${room.round}</div><div class="players ${room.players.length === 1 ? "single" : ""}">${room.players
      .map((p) => {
        const gs = room.guesses.filter((g) => g.playerId === p.id);
        const b =
          p.bestRank ?? (gs.length ? Math.min(...gs.map((g) => g.rank)) : null);
        const guessCount = p.guessCount ?? gs.length;
        return `<div class="player-card ${p.id === me ? "me" : ""} ${playing && p.id === room.turn && room.mode === "turn" ? "current" : ""}"><span class="avatar" style="background:${["#e5b8e3", "#b9cce7", "#efd0ac", "#c2dab5", "#d1c4e8", "#e8c0ac"][p.avatar]}">${avatars[p.avatar]}</span><div class="player-details"><strong class="player-name">${esc(p.name)} ${p.id === me ? '<span class="you">you</span>' : ""}</strong><div class="player-meta">${waiting ? `${p.id === room.host ? "Host" : p.member ? "Member" : "Guest"}${p.online ? " · online" : " · away"}` : b ? `Best ${rankLabel(b)} · ${guessCount} ${guessCount === 1 ? "guess" : "guesses"}` : "No guesses yet"}</div></div>${p.score ? `<span class="you">${p.score} ★</span>` : ""}</div>`;
      })
      .join(
        "",
      )}</div><div class="status-banner">${waiting ? `Waiting for ${room.players.length === 1 ? "players to join…" : `${host ? "you to start" : "the host to start"}…`} <span style="display:block;font-size:12px;opacity:.7;margin-top:3px">${room.players.length} / ${room.maxPlayers} players</span>` : finished ? `🎉 ${esc(room.players.find((p) => p.id === room.winner)?.name || "A player")} found the word!` : room.mode === "race" ? "The race is on — find the secret word!" : room.turn === me ? "Your turn — make a guess!" : `${esc(current?.name || "Another player")}’s turn…`}</div>${waiting ? `<p class="share-label">Share this link to invite friends:</p><div class="share-form"><input aria-label="Invite link" id="share-url" readonly value="${esc(location.origin)}/multiplayer/m/${room.code}"><button class="primary" id="copy-link">Copy</button></div><div class="room-code">ROOM CODE <strong>${room.code}</strong></div><div class="room-actions">${host ? `<button class="primary" id="start-game" ${room.players.length < 2 ? "disabled" : ""}>Start game ${icon("arrow")}</button>` : '<p class="under">The host will start when everyone is ready.</p>'}</div><p class="mp-note">Invite up to ${room.maxPlayers - 1} ${room.maxPlayers === 2 ? "friend" : "friends"}. Everyone opens the same link on their own device.<br>This room allows up to ${room.maxPlayers} players.</p>` : ""}<section class="room-game">${guessForm(waiting ? "Waiting for players…" : finished ? "Round complete" : canGuess ? "Type a word..." : `Waiting for ${current?.name || "your turn"}…`, !canGuess)}<div class="room-status"><span>${room.mode === "race" ? "Your guesses" : "Shared board"}</span><span class="connection"><span class="dot ${connected ? "" : "off"}"></span>${connected ? "Connected" : "Reconnecting…"}</span>${canGuess && room.mode === "turn" ? '<button class="text-btn" id="skip-turn">Skip turn</button>' : ""}</div>${
      guesses.length
        ? `<div class="stats-bar"><div class="counts"><div class="count"><strong>${guesses.length}</strong><span>GUESSES</span></div><div class="count"><strong>${best ? rankLabel(best) : "—"}</strong><span>BEST</span></div></div><span class="label">LOWER IS CLOSER</span></div><div class="guess-list">${[
            ...guesses,
          ]
            .sort((a, b) => a.rank - b.rank)
            .map((g) => guessRow(g))
            .join("")}</div>`
        : playing
          ? '<div class="mini-empty">Every word brings you closer.<br>Guess an English word to get started.</div>'
          : ""
    }</section>${finished ? `<div class="room-actions">${host ? '<button class="primary" id="rematch">Play again</button>' : '<span class="under">Waiting for the host to start a rematch.</span>'}<button class="outline" id="show-result">View result</button></div>` : ""}</main>`;
  bindCommon();
  $("#copy-link")?.addEventListener("click", () =>
    copy(`${location.origin}/multiplayer/m/${room.code}`),
  );
  $("#start-game")?.addEventListener("click", () => roomAction("start"));
  $("#rematch")?.addEventListener("click", () => roomAction("rematch"));
  $("#skip-turn")?.addEventListener("click", () => roomAction("skip"));
  $("#show-result")?.addEventListener("click", showRoomVictory);
  $("#guess-form").onsubmit = (e) => {
    e.preventDefault();
    roomAction("guess", { word: $("#guess-input").value.trim() });
  };
}
async function roomAction(action, extra = {}) {
  if (pending) return;
  pending = true;
  const input = $("#guess-input");
  const typed = input?.value;
  try {
    room = await api(`/api/rooms/${room.code}/${action}`, {
      token: credentials.token,
      ...extra,
    });
    if (action === "guess" && input) input.value = "";
    renderRoom();
    if (action === "guess" && $("#guess-input") && !$("#guess-input").disabled)
      $("#guess-input").focus({ preventScroll: true });
  } catch (e) {
    errorText(e.message);
    if (input && typed) input.value = typed;
  } finally {
    pending = false;
  }
}
async function leaveRoom() {
  if (room && credentials) {
    try {
      await api(`/api/rooms/${room.code}/leave`, { token: credentials.token });
    } catch {}
  }
  events?.close();
  events = null;
  room = null;
  credentials = null;
  connected = false;
  lastWin = "";
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    const field = $("#share-url");
    if (field) {
      field.focus();
      field.select();
      toast("Select and copy the invite link");
    } else toast(text);
  }
}
function bindCommon() {
  $("#logout-account")?.addEventListener("click", logoutAccount);
  document
    .querySelectorAll("[data-modal]")
    .forEach((b) => (b.onclick = () => showModal(b.dataset.modal)));
  document.querySelectorAll("[data-leave]").forEach(
    (a) =>
      (a.onclick = async (e) => {
        e.preventDefault();
        await leaveRoom();
        navigate("/multiplayer");
      }),
  );
  document.querySelectorAll('a[href^="/"]').forEach((a) => {
    if (a.dataset.leave) return;
    a.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      navigate(a.getAttribute("href"));
    };
  });
}
async function navigate(path) {
  if (room) await leaveRoom();
  history.pushState({}, "", path);
  closeModal();
  route();
}
function closeModal() {
  modalRoot.innerHTML = "";
  document.body.style.overflow = "";
}
function modal(html, classes = "") {
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal ${classes}" role="dialog" aria-modal="true" aria-label="${classes === "victory" ? "Game result" : "CloseWord dialog"}"><button class="icon-btn close" aria-label="Close">${icon("close")}</button>${html}</section></div>`;
  document.body.style.overflow = "hidden";
  $(".modal .close").onclick = closeModal;
  $(".modal-backdrop").onclick = (e) => {
    if (e.target === $(".modal-backdrop")) closeModal();
  };
  $(".modal .close").focus();
}
function showModal(type, tab = "how") {
  if (type === "stats" && account) {
    navigate("/account");
    return;
  }
  if (type === "settings") {
    modal(
      `<h2>Settings</h2><label class="setting"><span><strong>Dark ${room || location.pathname.includes("multiplayer") ? "mode" : "Mode"}</strong><small>${room ? "Switch between light and dark" : "Reduce eye strain in low light"}</small></span><input class="switch" type="checkbox" id="dark-toggle" aria-label="Dark mode" ${settings.dark ? "checked" : ""}></label>${location.pathname.includes("multiplayer") ? `<label class="setting"><span><strong>Sound effects</strong><small>Play sounds during multiplayer games</small></span><input class="switch" type="checkbox" id="sound-toggle" aria-label="Sound effects" ${settings.sound ? "checked" : ""}></label>` : `<div class="setting" style="display:block"><strong>Hints</strong><small>The hint’s position will be ${settings.difficulty === "easy" ? "half the position of your closest word" : settings.difficulty === "medium" ? "one less than your closest word" : "random"}</small><div class="difficulty">${["easy", "medium", "hard"].map((d) => `<button data-difficulty="${d}" class="${settings.difficulty === d ? "active" : ""}">${d[0].toUpperCase() + d.slice(1)}</button>`).join("")}</div></div>`}<label class="setting"><span><strong>High Contrast</strong><small>Use a high-contrast palette (blue / orange / gray)</small></span><input class="switch" type="checkbox" id="contrast-toggle" aria-label="High contrast" ${settings.contrast ? "checked" : ""}></label><div class="fine">CloseWord · A daily word game<br>Six-player edition</div>`,
    );
    $("#dark-toggle").onchange = (e) => {
      settings.dark = e.target.checked;
      applySettings();
    };
    $("#contrast-toggle").onchange = (e) => {
      settings.contrast = e.target.checked;
      applySettings();
    };
    $("#sound-toggle")?.addEventListener("change", (e) => {
      settings.sound = e.target.checked;
      applySettings();
    });
    document.querySelectorAll("[data-difficulty]").forEach(
      (b) =>
        (b.onclick = () => {
          settings.difficulty = b.dataset.difficulty;
          applySettings();
          showModal("settings");
        }),
    );
  } else if (type === "help") {
    const texts = {
      how: `<p>Find the secret word. You have unlimited guesses.</p><div class="help-section"><strong>Guess any word</strong><p>Type a word and submit it. Each guess is ranked by how semantically close it is to the secret word.</p></div><div class="help-section"><strong>Lower rank = closer</strong><p>Rank 1 means you found the word! A rank of 50 means your word is very close. A rank of 1000+ means it’s far away.</p></div><div class="help-section"><strong>Watch the colors</strong><p>🟩 Green = very close &nbsp; 🟨 Yellow = getting warm &nbsp; Gray = far away</p></div><div class="help-section"><strong>Use hints wisely</strong><p>You have 3 hints per game. Each hint reveals a word and its rank to help guide you.</p></div><p>A new puzzle is available every day!</p>`,
      tips: '<div class="help-section"><strong>Think about meaning</strong><p>Related ideas count. For example, “wave” and “beach” can both be close to “ocean”. Spelling and word length do not matter.</p></div><div class="help-section"><strong>Start broad, then narrow down</strong><p>Try different topics: people, nature, food, places. Follow your best guesses and explore synonyms.</p></div><div class="help-section"><strong>Use your hints</strong><p>Stuck? A hint gives you another nearby word. Change hint difficulty in Settings.</p></div>',
      faq: '<div class="help-section"><strong>How are guesses ranked?</strong><p>Words are compared using GloVe word embeddings. Every guess gets a rank based on its meaning relative to the secret word.</p></div><div class="help-section"><strong>When does the daily puzzle change?</strong><p>A new puzzle arrives at midnight UTC. Everyone gets the same daily word.</p></div><div class="help-section"><strong>Can I play with friends?</strong><p>Yes! Open Multiplayer, create a private room, and send the invite link to up to five friends. Play turn-by-turn or race at the same time.</p></div>',
    };
    modal(
      `<h2>How to Play</h2><div class="daily-tabs" role="tablist">${[
        ["how", "How to Play"],
        ["tips", "Tips"],
        ["faq", "FAQ"],
      ]
        .map(
          ([id, name]) =>
            `<button data-help="${id}" class="${tab === id ? "active" : ""}" role="tab" aria-selected="${tab === id}">${name}</button>`,
        )
        .join("")}</div>${texts[tab]}`,
    );
    document
      .querySelectorAll("[data-help]")
      .forEach((b) => (b.onclick = () => showModal("help", b.dataset.help)));
  } else if (type === "stats" && location.pathname.includes("multiplayer")) {
    const games = JSON.parse(localStorage.getItem("cw-mp-stats") || "[]");
    const wins = games.filter((g) => g.won);
    modal(
      `<h2>Your stats</h2><div class="stat-grid">${[
        [games.length, "GAMES"],
        [wins.length, "WINS"],
        [
          games.length
            ? Math.round((wins.length / games.length) * 100) + "%"
            : "—",
          "WIN RATE",
        ],
      ]
        .map(
          ([n, s]) =>
            `<div class="count"><strong>${n}</strong><span>${s}</span></div>`,
        )
        .join(
          "",
        )}</div><p>${games.length ? "Keep playing to build your record." : "Play a multiplayer round to start your record."}</p><p>Your multiplayer record is saved in this browser.</p>`,
    );
  } else if (type === "stats") {
    const all = JSON.parse(localStorage.getItem("cw-stats") || "[]"),
      wins = all.filter(
        (s) => s.mode === (tab === "practice" ? "practice" : "daily"),
      );
    const dates = [
      ...new Set(all.filter((s) => s.mode === "daily").map((s) => s.date)),
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
    const today = Math.floor(Date.now() / 86400000);
    const streak = previous >= today - 1 ? run : 0;
    modal(
      `<h2>Statistics</h2><div class="daily-tabs"><button id="stat-daily" class="${tab !== "practice" ? "active" : ""}">Daily</button><button id="stat-practice" class="${tab === "practice" ? "active" : ""}">Practice</button></div><div class="stat-grid">${[
        [wins.length, "GAMES"],
        [wins.length, "WINS"],
        [tab === "practice" ? "—" : streak, "STREAK"],
        [tab === "practice" ? "—" : longest, "BEST STREAK"],
      ]
        .map(
          ([n, s]) =>
            `<div class="count"><strong>${n}</strong><span>${s}</span></div>`,
        )
        .join("")}</div><h3>Guess Distribution</h3>${
        wins.length
          ? [10, 25, 50, 100, Infinity]
              .map((limit, i) => {
                const low = [0, 10, 25, 50, 100][i];
                const count = wins.filter(
                  (w) => w.guesses > low && w.guesses <= limit,
                ).length;
                return `<div class="distribute" style="--fill:${Math.max(5, (count / wins.length) * 100)}%">${i === 4 ? "100+" : `${low + 1}–${limit}`}<strong style="margin-left:auto">${count}</strong></div>`;
              })
              .join("")
          : '<p style="margin-top:20px">Solve a puzzle to see your statistics.</p>'
      }`,
    );
    $("#stat-daily").onclick = () => showModal("stats", "daily");
    $("#stat-practice").onclick = () => showModal("stats", "practice");
  } else if (type === "leaderboard") {
    modal(
      '<h2>Leaderboard</h2><div id="all-leaders" class="leaders"><p class="loading">Loading…</p></div>',
    );
    api("/api/leaderboard")
      .then((rows) => {
        if (!$("#all-leaders")) return;
        $("#all-leaders").innerHTML = rows.length
          ? rows
              .map(
                (p, i) =>
                  `<div class="leader-row"><span class="place">${i + 1}</span><span>${esc(p.name)}</span><strong>+${p.score}</strong></div>`,
              )
              .join("")
          : '<div class="no-leaders">No games yet. Invite your friends and be the first!</div>';
      })
      .catch((e) => toast(e.message));
  }
}
function showVictory() {
  modal(
    `<h2>Brilliant!</h2><div class="answer">${esc(solo.answer?.toUpperCase())}</div><div class="stat-grid"><div class="count"><strong>${solo.guesses.length}</strong><span>GUESSES</span></div><div class="count"><strong>${solo.hints}</strong><span>HINTS USED</span></div></div><button class="primary" id="share-result">${icon("share")} Share result</button><button class="outline" id="play-another">Play another</button>${soloMode === "daily" ? '<div class="countdown"><span>NEXT PUZZLE IN</span><strong id="countdown"></strong></div>' : ""}`,
    "victory",
  );
  $("#share-result").onclick = () =>
    copy(
      `CloseWord ${soloMode === "daily" ? `#${solo.number}` : "Practice"}\nFound ${solo.answer} in ${solo.guesses.length} guesses · ${solo.hints} hints\n${location.origin}`,
    );
  $("#play-another").onclick = () => {
    closeModal();
    startSolo("practice");
  };
  updateCountdown();
}
function showRoomVictory() {
  const won = room.winner === credentials.playerId;
  const key = `${room.code}:${room.round}`;
  const history = JSON.parse(localStorage.getItem("cw-mp-stats") || "[]");
  if (!history.some((g) => g.key === key)) {
    history.push({
      key,
      won,
      mode: room.mode,
      guesses: room.guesses.filter((g) => g.playerId === credentials.playerId)
        .length,
    });
    localStorage.setItem("cw-mp-stats", JSON.stringify(history));
  }
  const winner = room.players.find((p) => p.id === room.winner);
  modal(
    `<div style="font-size:38px">${won ? "🎉" : "🏆"}</div><h2>${won ? "You won!" : `${esc(winner?.name || "A player")} won!`}</h2><p>The secret word was</p><div class="answer">${esc(room.answer?.toUpperCase())}</div><p>${room.guesses.filter((g) => g.playerId === room.winner).length} guesses by the winner · Round ${room.round}</p>${room.host === credentials.playerId ? '<button class="primary" id="result-rematch">Play again</button>' : "<p>Waiting for the host to start a rematch.</p>"}<button class="outline" id="view-board">View board</button>`,
    "victory",
  );
  $("#view-board").onclick = closeModal;
  $("#result-rematch")?.addEventListener("click", () => {
    closeModal();
    roomAction("rematch");
  });
  if (settings.sound && won) {
    try {
      const context = new AudioContext(),
        osc = context.createOscillator(),
        gain = context.createGain();
      osc.connect(gain);
      gain.connect(context.destination);
      osc.frequency.setValueAtTime(523, context.currentTime);
      osc.frequency.setValueAtTime(659, context.currentTime + 0.12);
      osc.frequency.setValueAtTime(784, context.currentTime + 0.24);
      gain.gain.setValueAtTime(0.05, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.5);
      osc.start();
      osc.stop(context.currentTime + 0.5);
      osc.onended = () => context.close();
    } catch {}
  }
}
function updateCountdown() {
  const el = $("#countdown");
  if (!el) return;
  const secs = 86400 - (Math.floor(Date.now() / 1000) % 86400);
  el.textContent = [
    Math.floor(secs / 3600),
    Math.floor((secs % 3600) / 60),
    secs % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
setInterval(updateCountdown, 1000);
function renderChallenge() {
  app.innerHTML =
    header(false, true) +
    `<main class="challenge-page"><h1>Create a challenge</h1><p>Choose a secret word and challenge your friends to find it. Share a link so they can play the same puzzle.</p><form id="challenge-form"><label for="secret" class="field-label">Your secret word</label><div class="guess-form"><input id="secret" placeholder="Enter an English word" autocomplete="off" autocapitalize="none" maxlength="40" required><button class="square" aria-label="Create challenge">${icon("arrow")}</button></div></form><p id="form-error" class="error empty-error" role="alert"></p><div id="challenge-result"></div></main>`;
  bindCommon();
  $("#challenge-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = await api("/api/challenge", { word: $("#secret").value });
      const link = `${location.origin}/challenge/${data.code}`;
      $("#challenge-result").innerHTML =
        `<div class="status-banner">Your challenge is ready!</div><div class="share-form"><input id="share-url" aria-label="Challenge link" value="${esc(link)}" readonly><button class="primary" id="copy-challenge">Copy</button></div>`;
      $("#copy-challenge").onclick = () => copy(link);
    } catch (e) {
      errorText(e.message);
    }
  };
}
function onboard() {
  const slides = [
    [
      "Welcome to CloseWord!",
      "Find the secret word using semantic clues.<br>Let’s walk through how it works.",
    ],
    [
      "Guess any word",
      "Type any English word and press Enter. You have unlimited guesses.",
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
    [
      "Ready to play?",
      "Try your first word. A new puzzle is waiting every day!",
    ],
  ];
  modal(
    `<div class="dots">${slides.map((_, i) => `<i class="${i === onboardStep ? "active" : ""}"></i>`).join("")}</div><h2>${slides[onboardStep][0]}</h2><p>${slides[onboardStep][1]}</p><div class="onboard-actions"><button class="text-btn" id="skip-intro">Skip</button><button class="primary" id="next-intro">${onboardStep === 5 ? "Let’s play" : "Next"}</button></div>`,
    "onboarding",
  );
  const finish = () => {
    localStorage.setItem("cw-onboarded", "1");
    closeModal();
    $("#guess-input")?.focus();
  };
  $("#skip-intro").onclick = finish;
  $(".modal .close").onclick = finish;
  $("#next-intro").onclick = () => {
    if (onboardStep < 5) {
      onboardStep++;
      onboard();
    } else finish();
  };
}
async function route() {
  const path = location.pathname;
  if (
    [
      "/signup",
      "/login",
      "/verify",
      "/forgot-password",
      "/reset-password",
    ].includes(path)
  ) {
    renderAuthPage(path);
    return;
  }
  if (path === "/account") {
    await renderAccountPage();
    return;
  }
  if (path.startsWith("/account/games/")) {
    await renderGameDetails(path.split("/").at(-1));
    return;
  }
  document.title = path.includes("multiplayer")
    ? "Multiplayer — CloseWord"
    : "CloseWord — Daily Word Game";
  const match = path.match(/^\/multiplayer\/m\/([A-Z0-9]{6})$/i);
  if (match) {
    const code = match[1].toUpperCase();
    const saved = localStorage.getItem(`cw-room-${code}`);
    if (saved) {
      app.innerHTML =
        header(true) +
        '<main><p class="loading">Connecting…</p><p id="form-error" class="error"></p></main>';
      await joinRoom(code);
      if (!room) {
        renderLobby(code);
        errorText(
          "This room is no longer available. Ask the host for a new invite link.",
        );
      }
    } else renderLobby(code);
  } else if (path === "/multiplayer") renderLobby();
  else if (path === "/challenge") renderChallenge();
  else if (path.startsWith("/challenge/"))
    await startSolo("challenge", path.split("/").at(-1));
  else {
    await startSolo("daily");
    if (!localStorage.getItem("cw-onboarded")) onboard();
  }
}
window.addEventListener("popstate", async () => {
  events?.close();
  events = null;
  room = null;
  credentials = null;
  closeModal();
  route();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
  if (e.key === "Tab" && $(".modal")) {
    const focusable = [
      ...$(".modal").querySelectorAll("button,input,a,select"),
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
});
window.addEventListener("storage", async (e) => {
  if (e.key === "cw-auth-event") {
    events?.close();
    events = null;
    room = null;
    credentials = null;
    await refreshAccount();
    route();
  }
});
refreshAccount().then(route);
