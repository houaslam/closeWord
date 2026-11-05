function accountNav() {
  return `<div class="account-nav"><div><span>${account ? `Signed in as <strong>${esc(account.nickname)}</strong>` : "Keep your games, wherever you play"}</span><nav aria-label="Account">${account ? '<a href="/account">My account</a><button id="logout-account">Log out</button>' : '<a href="/login">Log in</a><a class="account-signup" href="/signup">Create account</a>'}</nav></div></div>`;
}
function accountNotice() {
  return emailAvailable
    ? ""
    : '<p class="notice" role="status">Verification emails are temporarily unavailable. Please try again later.</p>';
}
function passwordFields(prefix = "", current = false) {
  return `${current ? '<label for="current-password">Current password</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required maxlength="128">' : ""}<label for="${prefix}password">${current ? "New password" : "Password"}</label><input id="${prefix}password" name="password" type="password" autocomplete="new-password" minlength="15" maxlength="128" aria-describedby="password-guidance" required><small id="password-guidance" class="field-help">Use 15–128 characters. A long, unique passphrase works well.</small><label for="${prefix}confirmation">Confirm password</label><input id="${prefix}confirmation" name="passwordConfirmation" type="password" autocomplete="new-password" minlength="15" maxlength="128" required>`;
}
async function refreshAccount() {
  try {
    const data = await api("/api/auth/me");
    account = data.user;
    emailAvailable = data.emailAvailable;
    nickname = account?.nickname || localStorage.getItem("cw-name") || "";
  } catch {
    account = null;
  }
}
function announceAccountChange() {
  localStorage.setItem("cw-auth-event", String(Date.now()));
}
async function logoutAccount() {
  try {
    if (room) await leaveRoom();
    await api("/api/auth/logout", {});
    account = null;
    nickname = localStorage.getItem("cw-name") || "";
    announceAccountChange();
    navigate("/multiplayer");
    toast("You have been logged out.");
  } catch (e) {
    toast(e.message);
  }
}
function setChallenge(data, purpose) {
  sessionStorage.setItem(
    "cw-verification",
    JSON.stringify({
      id: data.challengeId,
      email: data.email,
      purpose,
      sentAt: Date.now(),
    }),
  );
}
function getChallenge() {
  try {
    return JSON.parse(sessionStorage.getItem("cw-verification") || "null");
  } catch {
    return null;
  }
}
function renderAuthPage(path) {
  if (account && ["/signup", "/login"].includes(path)) {
    navigate("/account");
    return;
  }
  const signup = path === "/signup",
    forgot = path === "/forgot-password",
    reset = path === "/reset-password",
    verify = path === "/verify";
  const challenge = getChallenge();
  if (
    (reset || verify) &&
    (!challenge || challenge.purpose !== (reset ? "reset" : "signup"))
  ) {
    navigate(reset ? "/forgot-password" : "/signup");
    return;
  }
  const title = signup
    ? "Create your account"
    : forgot
      ? "Forgot your password?"
      : reset
        ? "Choose a new password"
        : verify
          ? "Check your email"
          : "Welcome back";
  document.title = `${title} — CloseWord`;
  app.innerHTML =
    header(false, true) +
    `<main class="auth-page"><h1>${title}</h1><p class="auth-intro">${signup ? "Save your games, track your progress, and play with friends." : forgot ? "Enter your email and we’ll send a code to reset your password." : reset ? "Enter the code from your email, then choose a new password." : verify ? `Enter the six-digit code sent to <strong>${esc(challenge.email)}</strong>. Your account is created only after verification.` : "Log in to see your latest games and results."}</p>${signup || forgot ? accountNotice() : ""}<form id="auth-form" class="auth-form">${verify || reset ? '<label for="email-code">Verification code</label><input id="email-code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000" required><small class="field-help">The code expires after 10 minutes.</small>' : `<label for="account-email">Email</label><input id="account-email" name="email" type="email" autocomplete="email" maxlength="254" required>`}${signup ? '<label for="account-nickname">Nickname</label><input id="account-nickname" name="nickname" autocomplete="nickname" minlength="2" maxlength="24" required>' : ""}${signup || reset ? passwordFields() : !forgot && !verify ? '<label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" maxlength="128" required>' : ""}<p id="form-error" class="error empty-error" role="alert"></p><button class="primary" id="auth-submit" type="submit">${signup ? "Send verification code" : forgot ? "Send reset code" : reset ? "Reset password" : verify ? "Verify email & create account" : "Log in"}</button></form>${verify || reset ? `<div class="auth-links"><button class="text-btn" id="resend-code">Resend code</button><a href="${reset ? "/forgot-password" : "/signup"}">${reset ? "Use another email" : "Change signup details"}</a></div>` : forgot ? '<div class="auth-links"><a href="/login">Back to login</a></div>' : `<div class="auth-links">${signup ? 'Already have an account? <a href="/login">Log in</a>' : '<a href="/forgot-password">Forgot password?</a><span>New here? <a href="/signup">Create account</a></span>'}</div>`}<p class="fine">${signup ? "Your email stays private. Your nickname appears in games." : "Your game history belongs to your verified account."}</p></main>`;
  bindCommon();
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = $("#auth-submit"),
      data = Object.fromEntries(new FormData(e.target));
    button.disabled = true;
    $("#form-error").textContent = "";
    try {
      if (signup) {
        const result = await api("/api/auth/register", data);
        setChallenge(result, "signup");
        navigate("/verify");
      } else if (forgot) {
        const result = await api("/api/auth/forgot", data);
        setChallenge(result, "reset");
        navigate("/reset-password");
        toast(result.message);
      } else if (reset) {
        await api("/api/auth/reset", { ...data, challengeId: challenge.id });
        sessionStorage.removeItem("cw-verification");
        account = null;
        announceAccountChange();
        navigate("/login");
        toast("Password reset. Log in with your new password.");
      } else {
        const result = await api(
          verify ? "/api/auth/verify" : "/api/auth/login",
          verify ? { challengeId: challenge.id, code: data.code } : data,
        );
        account = result.user;
        nickname = account.nickname;
        sessionStorage.removeItem("cw-verification");
        announceAccountChange();
        navigate("/account");
        toast(
          verify ? "Email verified. Your account is ready!" : "Welcome back!",
        );
      }
    } catch (error) {
      errorText(error.message);
    } finally {
      button.disabled = false;
    }
  };
  const resend = $("#resend-code");
  if (resend) {
    const update = () => {
      if (!$("#resend-code")) {
        clearInterval(resend.timer);
        return;
      }
      const remaining = Math.max(
        0,
        60 - Math.floor((Date.now() - challenge.sentAt) / 1000),
      );
      resend.disabled = remaining > 0;
      resend.textContent = remaining
        ? `Resend in ${remaining}s`
        : "Resend code";
    };
    update();
    resend.timer = setInterval(update, 1000);
    resend.onclick = async () => {
      resend.disabled = true;
      try {
        await api("/api/auth/resend", { challengeId: challenge.id });
        challenge.sentAt = Date.now();
        sessionStorage.setItem("cw-verification", JSON.stringify(challenge));
        update();
        toast("A new code has been sent.");
      } catch (e) {
        errorText(e.message);
        resend.disabled = false;
      }
    };
  }
}
const resultNames = {
  won: "Won",
  lost: "Lost",
  left: "Left early",
  playing: "In progress",
  abandoned: "Abandoned",
};
const modeNames = {
  turn: "Turn-by-turn",
  race: "Speed race",
  daily: "Daily puzzle",
  practice: "Practice",
  challenge: "Challenge",
};
function gameDate(value) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function historyCard(game) {
  return `<a href="/account/games/${esc(game.id)}" class="history-card"><div class="history-top"><strong>${modeNames[game.mode] || esc(game.mode)}</strong><span class="result-pill ${game.outcome}">${resultNames[game.outcome]}</span></div><div class="history-opponents">${game.kind === "solo" ? "Solo puzzle" : game.players.map((p) => esc(p.you ? "You" : p.name)).join(" · ")}</div><div class="history-bottom"><span>${gameDate(game.startedAt)}</span><span>${game.guessCount} ${game.guessCount === 1 ? "guess" : "guesses"}${game.winner ? ` · ${esc(game.winner)} won` : ""}</span></div>${game.word ? `<div class="history-answer">Secret word: <strong>${esc(game.word)}</strong></div>` : ""}</a>`;
}
async function renderAccountPage() {
  document.title = "My account — CloseWord";
  if (!account) {
    renderSignInRequired();
    return;
  }
  app.innerHTML =
    header(false, true) +
    '<main class="account-page"><p class="loading">Loading your games…</p></main>';
  bindCommon();
  try {
    const data = await api("/api/account");
    if (location.pathname !== "/account") return;
    const s = data.stats;
    app.innerHTML =
      header(false, true) +
      `<main class="account-page"><div class="account-title"><div><div class="eyebrow">YOUR WORD JOURNEY</div><h1>${esc(data.user.nickname)}</h1><p class="account-email">${esc(data.user.email)} <span class="verified-badge">✓ Verified</span></p></div><span class="large-avatar">🦁</span></div><div class="account-summary">${[
        [s.games, "GAMES"],
        [s.wins, "WINS"],
        [s.losses, "LOSSES"],
        [s.winRate + "%", "WIN RATE"],
      ]
        .map(
          ([n, label]) =>
            `<div class="count"><strong>${n}</strong><span>${label}</span></div>`,
        )
        .join(
          "",
        )}</div><div class="account-substats"><span>${s.totalGuesses} total guesses</span><span>${s.playing} in progress · ${s.left} left or abandoned</span></div><div class="history-heading"><h2>Latest games</h2><select id="history-filter" aria-label="Filter games by result"><option value="all">All results</option><option value="won">Wins</option><option value="lost">Losses</option><option value="playing">In progress</option><option value="left">Left early</option><option value="abandoned">Abandoned</option></select></div><div id="game-history"></div><button class="outline" id="more-games" hidden>Load more games</button><div class="account-tools"><a class="primary" href="/multiplayer">Play with friends ${icon("arrow")}</a><button class="outline" id="change-password">Change password</button></div><p class="fine">Your verified account and game history are saved on the server.</p></main>`;
    let page = 0,
      result = "all";
    const load = async (append) => {
      try {
        const rows = await api(
          `/api/account/games?page=${page}&result=${result}`,
        );
        if (!$("#game-history")) return;
        const content = rows.games.map(historyCard).join("");
        if (append) $("#game-history").insertAdjacentHTML("beforeend", content);
        else
          $("#game-history").innerHTML =
            content ||
            '<div class="history-empty"><span>✦</span><h3>No games here yet</h3><p>Play a puzzle or invite your friends. Your results will appear here.</p></div>';
        $("#more-games").hidden = !rows.hasMore;
        bindCommon();
      } catch (e) {
        toast(e.message);
      }
    };
    bindCommon();
    $("#history-filter").onchange = (e) => {
      page = 0;
      result = e.target.value;
      load(false);
    };
    $("#more-games").onclick = () => {
      page++;
      load(true);
    };
    $("#change-password").onclick = showChangePassword;
    await load(false);
  } catch (e) {
    if (!$("#app")) return;
    app.innerHTML =
      header(false, true) +
      `<main class="account-page"><h1>Your account</h1><p class="error">${esc(e.message)}</p><a class="outline" href="/login">Log in</a></main>`;
    bindCommon();
  }
}
function renderSignInRequired() {
  app.innerHTML =
    header(false, true) +
    '<main class="auth-page"><h1>Your games, saved</h1><p class="auth-intro">Log in to see your game history, wins, losses, and opponents.</p><a class="primary" href="/login">Log in</a><a class="outline" style="margin-top:12px" href="/signup">Create account</a></main>';
  bindCommon();
}
async function renderGameDetails(id) {
  document.title = "Game history — CloseWord";
  if (!account) {
    renderSignInRequired();
    return;
  }
  app.innerHTML =
    header(false, true) + '<main><p class="loading">Loading game…</p></main>';
  bindCommon();
  try {
    const { game } = await api(`/api/account/games/${encodeURIComponent(id)}`);
    if (location.pathname !== `/account/games/${id}`) return;
    const minutes = game.finishedAt
      ? Math.max(1, Math.round((game.finishedAt - game.startedAt) / 1000))
      : null;
    app.innerHTML =
      header(false, true) +
      `<main class="account-page"><a class="back-history" href="/account">${icon("back")} Game history</a><div class="history-top"><h1>${modeNames[game.mode] || esc(game.mode)}</h1><span class="result-pill ${game.outcome}">${resultNames[game.outcome]}</span></div><p class="account-email">${gameDate(game.startedAt)}${game.round ? ` · Round ${game.round}` : ""}</p>${game.word ? `<div class="game-secret"><span>SECRET WORD</span><strong>${esc(game.word)}</strong>${game.winner ? `<p>${esc(game.winner)} found it!</p>` : ""}</div>` : '<div class="status-banner">The secret word stays hidden until the game finishes.</div>'}<div class="account-summary"><div class="count"><strong>${game.guessCount}</strong><span>YOUR GUESSES</span></div><div class="count"><strong>${game.bestRank || "—"}</strong><span>YOUR BEST</span></div><div class="count"><strong>${game.hints}</strong><span>HINTS</span></div>${minutes ? `<div class="count"><strong>${minutes < 60 ? minutes + "s" : Math.floor(minutes / 60) + "m"}</strong><span>DURATION</span></div>` : ""}</div><h2 class="detail-heading">${game.kind === "solo" ? "Player" : "Players & results"}</h2><div class="result-players">${game.players.map((p) => `<div><strong>${esc(p.name)} ${p.you ? "<small>(you)</small>" : ""}</strong><span class="result-pill ${p.outcome}">${resultNames[p.outcome]}</span></div>`).join("")}</div><h2 class="detail-heading">${game.mode === "race" && game.status !== "finished" ? "Your guesses" : "Guess board"}</h2><div>${
        [...game.guesses]
          .sort((a, b) => a.rank - b.rank)
          .map((g) => guessRow(g))
          .join("") || '<p class="mini-empty">No guesses yet.</p>'
      }</div></main>`;
    bindCommon();
  } catch (e) {
    app.innerHTML =
      header(false, true) +
      `<main><h1>Game unavailable</h1><p class="auth-intro">${esc(e.message)}</p><a class="outline" href="/account">Back to your games</a></main>`;
    bindCommon();
  }
}
function showChangePassword() {
  modal(
    `<h2>Change password</h2><form class="auth-form" id="change-password-form">${passwordFields("new-", true)}<p class="error empty-error" id="form-error" role="alert"></p><button class="primary" type="submit">Update password</button></form><p class="fine">Other devices will be logged out.</p>`,
  );
  $("#change-password-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector("button");
    button.disabled = true;
    try {
      await api(
        "/api/auth/password",
        Object.fromEntries(new FormData(e.target)),
      );
      closeModal();
      announceAccountChange();
      toast("Password updated. Other devices have been logged out.");
    } catch (e) {
      errorText(e.message);
    } finally {
      button.disabled = false;
    }
  };
}
