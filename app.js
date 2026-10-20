import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { TEAMS } from "./teams.js";
import { CONFIG } from "./config.js";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);

const configured = !CONFIG.supabaseUrl.startsWith("YOUR_") && !CONFIG.supabaseAnonKey.startsWith("YOUR_");
const sb = window.__PICKS_TEST_CLIENT__ || (configured ? createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey) : null);

let user = null;
let games = [];            // rows from public.games
let byId = {};
let picks = {};            // gameId -> team
let split = {};            // gameId -> {total, [team]: n}
let sel = null;
let view = "sheet";
let authMode = "in";       // in | up | reset | newpass
let timers = [];
let channel = null;

// ---------------------------------------------------------------------------
// Game windows, judged in Eastern time
// ---------------------------------------------------------------------------
const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
function windowOf(g) {
  if (g.intl) return "International";
  const p = Object.fromEntries(ET.formatToParts(new Date(g.kickoff)).map(x => [x.type, x.value]));
  const md = p.month + "/" + p.day, hm = (+p.hour % 24) * 60 + +p.minute;
  if (md === "11/26") return "Thanksgiving";
  if (md === "11/27") return "Black Friday";
  if (md === "12/25") return "Christmas";
  if (p.weekday === "Sun" && hm === 0) return "Time TBD";   // ESPN's placeholder for unscheduled games
  if (p.weekday === "Sun") return hm < 15 * 60 ? "Sunday Early" : hm < 19 * 60 ? "Sunday Late" : "Sunday Night";
  return { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday" }[p.weekday];
}

const isLocked = g => Date.now() >= Date.parse(g.kickoff) || g.state !== "pre";
// The site launched partway through 2026: games in Weeks 1-7 that were already played can
// still be picked once, and that pick is final. The database enforces the same rule.
const CATCH_UP_LAST_WEEK = 7;
const isCatchUp = g => g.week <= CATCH_UP_LAST_WEEK && Date.parse(g.kickoff) < Date.parse("2027-03-01") && isLocked(g);
const canPick = g => !isLocked(g) || (isCatchUp(g) && !picks[g.id]);
let pending = null;        // {id, team}: a catch-up pick tapped once, waiting for the confirming tap
function grade(g) {
  const p = picks[g.id];
  if (!p || !g.winner) return null;
  return g.winner === "TIE" ? "push" : p === g.winner ? "win" : "loss";
}
function recordFor(list) {
  let w = 0, l = 0, t = 0;
  for (const g of list) { const r = grade(g); if (r === "win") w++; else if (r === "loss") l++; else if (r === "push") t++; }
  return { w, l, t };
}
// Ties are a wash: they never show up in a record.
const fmtRec = r => `${r.w}–${r.l}`;
function currentWeek() {
  const now = Date.now();
  for (const w of WEEKS) {
    const ks = games.filter(g => g.week === w).map(g => Date.parse(g.kickoff));
    if (ks.length && Math.max(...ks) + 12 * 3600e3 > now) return w;
  }
  return 18;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function show(which) {
  view = which;
  for (const v of ["authView", "sheetView", "standingsView", "setupView"]) $(v).hidden = v !== which + "View";
  const inApp = which === "sheet" || which === "standings";
  $("side").hidden = !inApp;
  $("recordBox").hidden = which !== "sheet";
  $("pageTitle").hidden = !inApp;
  $("pageTitle").textContent = which === "standings" ? "Standings" : sel ? `Week ${sel}` : "";
  $("toStandings").hidden = which !== "sheet";
  $("toPicks").hidden = which !== "standings";
}

function renderSheet() {
  if (view !== "sheet") return;
  if (sel == null) sel = currentWeek();
  $("pageTitle").textContent = `Week ${sel}`;
  const cur = currentWeek();
  $("weeks").innerHTML = WEEKS.map(w => {
    const r = recordFor(games.filter(g => g.week === w));
    return `<button class="wk${w === sel ? " sel" : ""}${w === cur ? " cur" : ""}" data-week="${w}" aria-pressed="${w === sel}"><span class="n"><span class="wk-pre">Wk </span>${w}</span><span class="r">${r.w + r.l + r.t ? fmtRec(r) : "—"}</span></button>`;
  }).join("");

  const wk = games.filter(g => g.week === sel).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  $("catchNote").hidden = !wk.some(isCatchUp);
  $("rec").textContent = fmtRec(recordFor(games));
  $("wkLabel").textContent = `Week ${sel}`;
  $("wkRec").textContent = fmtRec(recordFor(wk));
  $("wkPicked").textContent = `${wk.filter(g => picks[g.id]).length} of ${wk.length} picked`;

  const groups = new Map();
  for (const g of wk) {
    const k = windowOf(g);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(g);
  }
  const ordered = [...groups].sort((a, b) => (a[0] === "Time TBD") - (b[0] === "Time TBD") || Date.parse(a[1][0].kickoff) - Date.parse(b[1][0].kickoff));
  $("slate").innerHTML = ordered.length
    ? ordered.map(([name, gs]) => `<div class="group"><h3 class="win-h">${esc(name)}</h3>${gameHTML(gs[0])}</div>${gs.slice(1).map(gameHTML).join("")}`).join("")
    : `<p class="empty">No games loaded yet.</p>`;
}

function gameHTML(g) {
  const locked = !canPick(g), r = grade(g), mine = picks[g.id];
  const when = windowOf(g) === "Time TBD" ? "time TBD" : new Date(g.kickoff).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const tile = side => {
    const ab = side === "a" ? g.away : g.home, other = side === "a" ? g.home : g.away;
    const t = TEAMS[ab] || { name: ab, city: "", color: "#333" };
    const cls = ["tile"];
    if (mine === ab) cls.push("picked", r === "win" ? "right" : r === "loss" ? "wrong" : r === "push" ? "push" : "");
    if (!mine && pending?.id === g.id && pending.team === ab) cls.push("pending");
    const tl = mine && split[g.id];
    const tag = tl && tl.total ? `<span class="tag">${Math.round((tl[ab] || 0) / tl.total * 100)}%</span>` : "";
    const scoreVal = side === "a" ? g.away_score : g.home_score;
    const score = g.state !== "pre" && scoreVal != null ? `<span class="score">${scoreVal}</span>` : "";
    const label = `${t.city} ${t.name} ${side === "a" ? "at" : "vs"} ${(TEAMS[other] || { name: other }).name}, ${when}${g.detail && g.state !== "pre" ? " · " + g.detail : ""}`;
    return `<button class="${cls.join(" ").trim()}" style="background-color:${esc(t.color)}" data-game="${esc(g.id)}" data-team="${esc(ab)}" ${locked ? "disabled" : ""} aria-pressed="${mine === ab}" title="${esc(label)}" aria-label="${esc(label)}"><img src="logos/${esc(ab)}.png" alt="">${score}${tag}</button>`;
  };
  return `<div class="game${mine ? " has-pick" : ""}${locked ? " locked" : ""}${!mine && pending?.id === g.id ? " has-pending" : ""}">${tile("a")}${tile("h")}</div>`;
}

async function renderStandings() {
  const body = $("standingsBody");
  body.innerHTML = `<tr><td colspan="5" class="empty">Loading…</td></tr>`;
  const { data, error } = await sb.rpc("standings");
  if (error) { body.innerHTML = `<tr><td colspan="5" class="empty">Couldn't load standings. Try again in a moment.</td></tr>`; return; }
  const rows = (data || []).map(r => ({ ...r, wins: +r.wins, losses: +r.losses, ties: +r.ties, picked: +r.picked }))
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.display_name.localeCompare(b.display_name));
  if (!rows.length) { body.innerHTML = `<tr><td colspan="5" class="empty">No players yet.</td></tr>`; return; }
  let rank = 0, prev = null;
  body.innerHTML = rows.map((r, i) => {
    if (!prev || prev.wins !== r.wins || prev.losses !== r.losses) rank = i + 1;
    prev = r;
    const dec = r.wins + r.losses;
    const pct = dec ? (r.wins / dec).toFixed(3).replace(/^0/, "") : "—";
    return `<tr class="${r.player_id === user?.id ? "me" : ""}"><td>${rank}</td><td>${esc(r.display_name)}</td><td class="num">${fmtRec({ w: r.wins, l: r.losses })}</td><td class="num">${pct}</td><td class="num">${r.picked}</td></tr>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadGames() {
  const { data, error } = await sb.from("games").select("*").order("kickoff");
  if (error) throw error;
  games = data || [];
  byId = Object.fromEntries(games.map(g => [g.id, g]));
}
async function loadPicks() {
  const { data, error } = await sb.from("picks").select("game_id, team");
  if (error) throw error;
  picks = Object.fromEntries((data || []).map(p => [p.game_id, p.team]));
}
async function loadSplit(week) {
  const { data, error } = await sb.rpc("pick_split", { p_week: week });
  if (error) return;
  const next = {};
  for (const r of data || []) {
    const t = next[r.game_id] || (next[r.game_id] = { total: 0 });
    t[r.team] = +r.n; t.total += +r.n;
  }
  split = next;
}
function applyGame(row) {
  if (!row || !row.id) return;
  if (byId[row.id]) Object.assign(byId[row.id], row);
  else { games.push(row); byId[row.id] = row; }
}

const setSave = text => { $("save").textContent = text; };

async function chooseCatchUp(g, team) {
  if (picks[g.id]) return;   // catch-up picks are final
  if (!(pending?.id === g.id && pending.team === team)) {
    pending = { id: g.id, team };
    setSave("Tap again to lock in this pick. It can't be changed after.");
    renderSheet();
    return;
  }
  pending = null;
  picks[g.id] = team;
  renderSheet();
  setSave("Saving…");
  const { error } = await sb.from("picks").insert({ user_id: user.id, game_id: g.id, team });
  if (error) {
    delete picks[g.id];
    if (error.code === "23505") await loadPicks();   // already locked in from another device
    setSave(error.code === "23505" ? "You already locked in a pick for that game." : "Couldn't save that pick. Check your connection and try again.");
  } else {
    setSave("Locked in");
    await loadSplit(sel);
  }
  renderSheet();
}

async function choose(g, team) {
  if (isCatchUp(g)) return chooseCatchUp(g, team);
  if (isLocked(g)) { renderSheet(); return; }
  const prev = picks[g.id];
  const clearing = prev === team;
  if (clearing) delete picks[g.id]; else picks[g.id] = team;
  renderSheet();
  setSave("Saving…");
  let { data, error } = clearing
    ? await sb.from("picks").delete().eq("game_id", g.id).eq("user_id", user.id).select()
    : await sb.from("picks").upsert({ user_id: user.id, game_id: g.id, team, updated_at: new Date().toISOString() }, { onConflict: "user_id,game_id" });
  // The database silently skips a delete it won't allow, so an empty result means the game locked.
  if (!error && clearing && !(data || []).length) error = { code: "42501" };
  if (error) {
    if (prev) picks[g.id] = prev; else delete picks[g.id];
    setSave(error.code === "42501" ? "That game has kicked off. Picks are locked." : "Couldn't save that pick. Check your connection and try again.");
  } else {
    setSave("All picks saved");
    await loadSplit(sel);
  }
  renderSheet();
}

async function startApp() {
  show("sheet");
  setSave("Loading…");
  try {
    await Promise.all([loadGames(), loadPicks()]);
  } catch (e) {
    $("slate").innerHTML = `<p class="empty">Couldn't load the schedule. Reload the page to try again.</p>`;
    setSave("");
    return;
  }
  sel = currentWeek();
  await loadSplit(sel);
  setSave("All picks saved");
  renderSheet();
  $("weeks").querySelector(".sel")?.scrollIntoView({ inline: "center", block: "nearest" });

  // Live scores: Supabase pushes changes as the sync job writes them; a slow poll backs it up.
  channel = sb.channel("games-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "games" }, payload => { applyGame(payload.new); renderSheet(); })
    .subscribe();
  timers.push(setInterval(renderSheet, 30000));                   // flips games to locked at kickoff
  timers.push(setInterval(async () => { await loadSplit(sel); renderSheet(); }, 60000));
  timers.push(setInterval(async () => { try { await loadGames(); renderSheet(); } catch (e) {} }, 180000));
}
function stopApp() {
  timers.forEach(clearInterval); timers = [];
  if (channel) { sb.removeChannel(channel); channel = null; }
  games = []; byId = {}; picks = {}; split = {}; sel = null;
}

// ---------------------------------------------------------------------------
// Sign in, create account, reset password
// ---------------------------------------------------------------------------
function setAuthMode(mode) {
  authMode = mode;
  $("tabIn").classList.toggle("on", mode === "in");
  $("tabUp").classList.toggle("on", mode === "up");
  $("tabIn").setAttribute("aria-selected", mode === "in");
  $("tabUp").setAttribute("aria-selected", mode === "up");
  $("nameField").hidden = mode !== "up";
  $("emailField").hidden = mode === "newpass";
  $("passField").hidden = mode === "reset";
  $("password").autocomplete = mode === "in" ? "current-password" : "new-password";
  $("forgot").hidden = mode !== "in";
  $("authSubmit").textContent = { in: "Sign in", up: "Create account", reset: "Email me a reset link", newpass: "Save new password" }[mode];
  $("passField").firstChild.textContent = mode === "newpass" ? "New password" : "Password";
  authMsg("");
}
function authMsg(text, kind) { const m = $("authMsg"); m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); }

$("tabIn").addEventListener("click", () => setAuthMode("in"));
$("tabUp").addEventListener("click", () => setAuthMode("up"));
$("forgot").addEventListener("click", () => setAuthMode("reset"));

$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("email").value.trim(), password = $("password").value, name = $("displayName").value.trim();
  if (authMode !== "newpass" && !/^\S+@\S+\.\S+$/.test(email)) return authMsg("Enter a valid email address.", "err");
  if (authMode !== "reset" && password.length < 6) return authMsg("Passwords need at least 6 characters.", "err");
  if (authMode === "up" && !name) return authMsg("Pick a display name for the standings.", "err");
  $("authSubmit").disabled = true;
  try {
    if (authMode === "in") {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) authMsg(error.message === "Invalid login credentials" ? "That email and password don't match an account." : error.message, "err");
    } else if (authMode === "up") {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: location.origin + location.pathname } });
      if (error) authMsg(error.message, "err");
      else if (!data.session) authMsg("Check your email for a confirmation link, then sign in.", "ok");
    } else if (authMode === "reset") {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      authMsg(error ? error.message : "If that email has an account, a reset link is on its way.", error ? "err" : "ok");
    } else if (authMode === "newpass") {
      const { error } = await sb.auth.updateUser({ password });
      if (error) authMsg(error.message, "err");
      else { authMsg("Password updated.", "ok"); setTimeout(startApp, 600); }
    }
  } finally {
    $("authSubmit").disabled = false;
  }
});

$("signOut").addEventListener("click", () => sb.auth.signOut());
$("toStandings").addEventListener("click", () => { show("standings"); renderStandings(); });
$("toPicks").addEventListener("click", () => { show("sheet"); renderSheet(); });
$("weeks").addEventListener("click", async e => {
  const b = e.target.closest("[data-week]");
  if (!b) return;
  sel = +b.dataset.week;
  pending = null;
  renderSheet();
  await loadSplit(sel);
  renderSheet();
});
document.addEventListener("click", e => {
  const tb = e.target.closest(".tile[data-game]");
  if (tb && byId[tb.dataset.game]) choose(byId[tb.dataset.game], tb.dataset.team);
});

async function setUser(session) {
  const next = session?.user || null;
  if (next?.id === user?.id) return;
  user = next;
  stopApp();
  if (!user) { show("auth"); setAuthMode("in"); return; }
  const { data } = await sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
  $("who").textContent = data?.display_name || user.email;
  await startApp();
}

if (!sb) {
  show("setup");
} else {
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { user = session?.user || null; stopApp(); show("auth"); setAuthMode("newpass"); return; }
    // Defer so Supabase finishes its own bookkeeping before we query.
    setTimeout(() => setUser(session), 0);
  });
  const { data } = await sb.auth.getSession();
  if (!data.session) { show("auth"); setAuthMode("in"); }
}
