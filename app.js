/* HotPadel – týdenní Americano (4 hráči, 21 míčků) */
'use strict';

/* ============ KONFIGURACE ============ */
const SUPABASE_URL = 'https://jrbaxjtpatskvcdqvjnb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_TcHGhvjBw-FBgatur5ZS3A_VO4kziJq';
const SITE_URL = 'https://joey7500.github.io/hotpadel/';
const TOTAL = 21;
const STALE_HOURS = 10; // rozehraný večer bez aktivity déle než 10 h se automaticky ukončí
const PLAYERS = ['Honza', 'Martin', 'Pepa', 'Matouš'];
const SLUG = { Honza: 'honza', Martin: 'martin', Pepa: 'pepa', 'Matouš': 'matous' };
const COLORS = { Honza: '#b08a00', Martin: '#3987e5', Pepa: '#e0606a', 'Matouš': '#22a8a0' };
const ROTATIONS = [
  { teamA: ['Honza', 'Martin'], teamB: ['Pepa', 'Matouš'] },
  { teamA: ['Honza', 'Pepa'], teamB: ['Martin', 'Matouš'] },
  { teamA: ['Honza', 'Matouš'], teamB: ['Martin', 'Pepa'] },
];
const QUICK = [[11, 10], [12, 9], [13, 8], [14, 7], [10, 11], [9, 12], [8, 13], [7, 14]];
const ELO_START = 1000;
const ELO_K = 24;
const CACHE_KEY = 'hotpadel_cache_v1';
const OUTBOX_KEY = 'hotpadel_outbox_v1';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ============ STAV ============ */
// server = poslední známá data z databáze; state = server + neodeslané zápasy z fronty (outbox)
const server = { sessions: [], matches: [] };
const state = { sessions: [], matches: [], loaded: false };
let outbox = [];
let online = navigator.onLine;
let flushing = false;
let inFlightUid = null;
let pendingOps = 0;
let reloadDeferred = false;
let currentView = 'hrat';
let sheet = null; // { kind: 'session', id } | { kind: 'player', name }
let lastStatsSig = '';
let lastSheetSig = '';
const charts = {};

const $ = (id) => document.getElementById(id);
const el = {
  syncChip: $('syncChip'), sessionDate: $('sessionDate'), sessionSub: $('sessionSub'), liveBadge: $('liveBadge'),
  outboxBanner: $('outboxBanner'),
  tonightTable: $('tonightTable'), matchNo: $('matchNo'), rotationLabel: $('rotationLabel'),
  teamANames: $('teamANames'), teamBNames: $('teamBNames'), scoreA: $('scoreA'), scoreB: $('scoreB'),
  quickGrid: $('quickGrid'), validationMsg: $('validationMsg'), confirmBtn: $('confirmBtn'),
  undoBtn: $('undoBtn'), finishBtn: $('finishBtn'), tonightCount: $('tonightCount'), tonightMatches: $('tonightMatches'),
  sessionList: $('sessionList'), kpis: $('kpis'), playerStrip: $('playerStrip'), overallTable: $('overallTable'), formList: $('formList'),
  records: $('records'), funFacts: $('funFacts'), pairs: $('pairs'), h2hTable: $('h2hTable'), scoreDist: $('scoreDist'),
  legendWins: $('legendWins'), legendNights: $('legendNights'),
  sheet: $('sheet'), sheetTitle: $('sheetTitle'), sheetSub: $('sheetSub'), sheetBody: $('sheetBody'),
  modal: $('modal'), modalCard: $('modalCard'), toast: $('toast'),
};

/* ============ POMOCNÉ ============ */
const pad = (n) => String(n).padStart(2, '0');
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dateObj(iso) { return new Date(iso + 'T12:00:00'); }
function fmtLong(iso) { return dateObj(iso).toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' }); }
function fmtShort(iso) { const d = dateObj(iso); return `${d.getDate()}. ${d.getMonth() + 1}.`; }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }); }
function plural(n, one, few, many) { return n === 1 ? one : (n >= 2 && n <= 4 ? few : many); }
function nZap(n) { return `${n} ${plural(n, 'zápas', 'zápasy', 'zápasů')}`; }
function pct(w, n) { return n ? Math.round((w / n) * 100) : 0; }
function dec(x) { return x.toFixed(1).replace('.', ','); }
function signed(d) { const r = Math.round(d); return r > 0 ? `+${r}` : r < 0 ? `−${Math.abs(r)}` : '±0'; }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : `u${Date.now()}${Math.random().toString(16).slice(2)}`); }
function avatarUrl(p) { return `avatars/${SLUG[p]}.jpg?v=1`; }
/** Avatar. mode: 'auto' (velký ≥40 px → role + 🔥, malý → nic), 'evening' (malý v Tabulce večera → jen role),
 *  'strip' (karty na Statistikách → role + 🔥 + ✨ lídr), 'leader' (Celková tabulka → jen ✨ lídr), 'none'. */
function av(p, size = 26, cls = '', mode = 'auto') {
  const img = `<img class="av ${cls}" src="${avatarUrl(p)}" alt="" width="${size}" height="${size}" style="--c:${COLORS[p] || '#888'};width:${size}px;height:${size}px" loading="lazy">`;
  if (mode === 'auto') mode = size >= FX_MIN_SIZE ? 'big' : 'none';
  if (mode === 'none') return img;
  const role = mode === 'leader' ? 0 : (FX.role[p] || 0);
  const fire = (mode === 'big' || mode === 'strip') && FX.fire.has(p);
  const lead = (mode === 'strip' || mode === 'leader') && FX.leader === p;
  if (!role && !fire && !lead) return img;
  const cl = ['fx', role ? `fx-r${role}` : '', fire ? 'fx-fire' : '', lead ? 'fx-lead' : '', size < FX_MIN_SIZE ? 'fx-sm' : ''].filter(Boolean).join(' ');
  const title = [role ? FX_TITLES[role - 1] : '', fire ? 'série 3+ výher 🔥' : '', lead ? 'lídr celkové tabulky ✨' : ''].filter(Boolean).join(' · ');
  return `<span class="${cl}" title="${title}">${lead ? LEAD_HTML : ''}${fire ? FIRE_HTML : ''}${role === 4 ? PAN_BACK : ''}${img}`
    + `${role === 4 ? PAN_FRONT + SMOKE_HTML : ''}${role === 1 ? CROWN_HTML : ''}${role === 2 ? ANGRY_HTML : ''}${role === 3 ? SWEAT_HTML : ''}</span>`;
}

/* ============ EFEKTY: 👑 1. · 😡 2. · 😰 3. · 🍳 4. večera, 🔥 série 3+, ✨ lídr celkové tabulky ============ */
const FX = { sid: null, role: {}, fire: new Set(), leader: null };
const FX_MIN_SIZE = 40;
const FX_STREAK = 3;
const FX_TITLES = ['1. místo večera 👑', '2. místo – naštvaný 😡', '3. místo – nervózní 😰', 'poslední – upečený 🍳'];
// 👑 koruna nad hlavou (otáčí se)
const CROWN_HTML = `<span class="fx-crown" aria-hidden="true"><svg viewBox="0 0 100 72">
  <path d="M8 60 L3 18 L28 40 L50 5 L72 40 L97 18 L92 60 Z" fill="#ffcf33" stroke="#a87400" stroke-width="3.5" stroke-linejoin="round"/>
  <rect x="7" y="55" width="86" height="13" rx="3" fill="#f2b100" stroke="#a87400" stroke-width="3.5"/>
  <circle cx="50" cy="61.5" r="4.5" fill="#e0245e"/><circle cx="27" cy="61.5" r="3.6" fill="#3987e5"/><circle cx="73" cy="61.5" r="3.6" fill="#22a8a0"/>
  <circle cx="3" cy="18" r="5" fill="#fff1a6"/><circle cx="50" cy="5" r="5.5" fill="#fff1a6"/><circle cx="97" cy="18" r="5" fill="#fff1a6"/>
  <path d="M20 46 L30 50" stroke="#fff6cf" stroke-width="3" stroke-linecap="round" opacity=".8"/></svg></span>`;
// 😡 2. místo: baseballka (máchá), 💢 a zrudnutí
const ANGRY_HTML = `<span class="fx-flush" aria-hidden="true"></span><span class="fx-bat" aria-hidden="true"><svg viewBox="0 0 20 100">
  <path d="M8.6 97 L8.1 62 Q6.2 34 3.6 9 Q10 -1 16.4 9 Q13.8 34 11.9 62 L11.4 97 Z" fill="#d39a5c" stroke="#6e4019" stroke-width="1.6"/>
  <path d="M6 14 Q10 8 14 14" fill="none" stroke="#f0c48e" stroke-width="2" stroke-linecap="round"/>
  <rect x="7.6" y="74" width="4.8" height="20" rx="1.5" fill="#2b2b33"/><ellipse cx="10" cy="97.5" rx="4.6" ry="2.4" fill="#6e4019"/></svg></span>
  <span class="fx-anger" aria-hidden="true"><svg viewBox="0 0 40 40"><g fill="none" stroke="#ff3030" stroke-width="5.5" stroke-linecap="round">
  <path d="M16 3 Q16 16 3 16"/><path d="M24 3 Q24 16 37 16"/><path d="M16 37 Q16 24 3 24"/><path d="M24 37 Q24 24 37 24"/></g></svg></span>`;
// 😰 3. místo: kapky potu
const DROP = '<svg viewBox="0 0 20 28"><path d="M10 1 C10 1 2 13 2 19 A8 8 0 0 0 18 19 C18 13 10 1 10 1 Z" fill="#8fd3ff" stroke="#2b7fd0" stroke-width="1.6"/><ellipse cx="7" cy="18" rx="2" ry="3.2" fill="#fff" opacity=".75"/></svg>';
const SWEAT_HTML = `<span class="fx-sweat" aria-hidden="true"><i style="left:6%;top:14%;animation-delay:0s">${DROP}</i><i style="right:4%;top:20%;animation-delay:-.7s">${DROP}</i><i style="left:20%;top:2%;animation-delay:-1.3s">${DROP}</i></span>`;
// ✨ lídr celkové tabulky: zlatá svatozář + jiskry
const SPARK = '<svg viewBox="0 0 20 20"><path d="M10 0 L12 8 L20 10 L12 12 L10 20 L8 12 L0 10 L8 8 Z" fill="#fff3a6"/></svg>';
const LEAD_HTML = `<span class="fx-halo" aria-hidden="true"></span><span class="fx-sparks" aria-hidden="true"><i style="left:-14%;top:4%;animation-delay:0s">${SPARK}</i><i style="right:-16%;top:30%;animation-delay:-.6s">${SPARK}</i><i style="left:62%;top:-18%;animation-delay:-1.2s">${SPARK}</i></span>`;
// Plameny: špičaté jazyky po obvodu, naklopené vzhůru (oheň stoupá), nahoře větší, dole jen malé.
// Vše v % avataru → funguje pro každou velikost.
const FIRE_HTML = '<span class="fx-glow" aria-hidden="true"></span><span class="fx-flames" aria-hidden="true">' + Array.from({ length: 14 }, (_, i) => {
  const ang = -180 + (i + 0.5) * (360 / 14); // poloha na obvodu (0 = nahoře)
  const up = (1 + Math.cos((ang * Math.PI) / 180)) / 2; // 1 nahoře … 0 dole
  const k = 0.45 + 0.55 * up + (i % 2 ? 0.08 : -0.06); // velikost (střídavě větší/menší)
  const lean = -ang * 0.35; // jazyk se stáčí vzhůru
  const w = 27 * k; // šířka v % avataru
  const lift = (40 / w) * 100; // základna 40 % od středu (v % vlastní výšky; prvek je čtverec)
  return `<b style="width:${w.toFixed(1)}%;margin-left:-${(w / 2).toFixed(1)}%;transform:rotate(${ang.toFixed(0)}deg) translateY(-${lift.toFixed(0)}%) rotate(${lean.toFixed(0)}deg)"><i style="animation-duration:${(0.5 + (i % 5) * 0.08).toFixed(2)}s;animation-delay:-${((i * 0.29) % 0.9).toFixed(2)}s"><u></u></i></b>`;
}).join('') + '</span>';
// Pánev: zadní část (za avatarem) + přední stěna (před avatarem), stejná animace → pohybují se spolu.
const PAN_VB = 'viewBox="-14 62 160 54"';
const PAN_BACK = `<span class="fx-pan" aria-hidden="true"><svg ${PAN_VB}>
  <line x1="106" y1="92" x2="126" y2="96" stroke="#15161a" stroke-width="7" stroke-linecap="round"/>
  <line x1="124" y1="95.5" x2="143" y2="99.5" stroke="#7a5230" stroke-width="10" stroke-linecap="round"/>
  <line x1="127" y1="94" x2="140" y2="96.8" stroke="#a5754a" stroke-width="2.5" stroke-linecap="round"/>
  <ellipse cx="50" cy="86" rx="62" ry="15" fill="#0e0f12" stroke="#2c3038" stroke-width="2.5"/>
  <ellipse cx="50" cy="88" rx="52" ry="10" fill="#1a1c21"/></svg></span>`;
const PAN_FRONT = `<span class="fx-pan fx-pan-front" aria-hidden="true"><svg ${PAN_VB}>
  <path d="M -12 86 A 62 15 0 0 0 112 86 L 108 98 A 58 15 0 0 1 -8 98 Z" fill="#26292f"/>
  <path d="M -10 92 A 60 15 0 0 0 110 92" fill="none" stroke="#17181c" stroke-width="5"/>
  <path d="M -12 86 A 62 15 0 0 0 112 86" fill="none" stroke="#4b515c" stroke-width="2"/></svg></span>`;
const SMOKE_HTML = '<span class="fx-smoke" aria-hidden="true"><i style="--x:-35%;animation-delay:0s"></i><i style="--x:25%;animation-delay:-.8s"></i><i style="--x:-5%;animation-delay:-1.6s"></i></span>';
function playerBySlug(slug) { return PLAYERS.find((p) => SLUG[p] === slug); }
function sameId(a, b) { return String(a) === String(b); }
function teamKey(t) { return [...t].sort().join('|'); }
function sameMatch(a, b) {
  return a.score_a === b.score_a && a.score_b === b.score_b && teamKey(a.team_a) === teamKey(b.team_a) && teamKey(a.team_b) === teamKey(b.team_b);
}
function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* plné úložiště / privátní režim */ } }

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const VALID_PLAYERS = new Set(PLAYERS);
/** Do aplikace pustíme jen zápasy našich 4 hráčů (ochrana proti nesmyslným / podvrženým datům). */
function validMatch(m) {
  const ps = [...(m.team_a || []), ...(m.team_b || [])];
  return Array.isArray(m.team_a) && Array.isArray(m.team_b) && m.team_a.length === 2 && m.team_b.length === 2 && ps.every((p) => VALID_PLAYERS.has(p)) && new Set(ps).size === 4
    && Number.isInteger(m.score_a) && Number.isInteger(m.score_b) && m.score_a + m.score_b === TOTAL;
}
function validSession(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s.played_on)); }

function sessionById(id) { return state.sessions.find((s) => sameId(s.id, id)); }
function matchesOf(sessionId) { return state.matches.filter((m) => sameId(m.session_id, sessionId)).sort((a, b) => a.match_no - b.match_no); }
function byCreated(a, b) { return new Date(a.created_at) - new Date(b.created_at); }
function lastActivity(s, matches) {
  const ts = [s.created_at, ...matches.filter((m) => sameId(m.session_id, s.id)).map((m) => m.created_at)]
    .map((t) => new Date(t).getTime()).filter((t) => !isNaN(t));
  return ts.length ? Math.max(...ts) : Date.now();
}
/** Zapomenutý neukončený večer (bez aktivity déle než STALE_HOURS) už nepočítáme jako rozehraný. */
function isStale(s, matches = state.matches) { return Date.now() - lastActivity(s, matches) > STALE_HOURS * 3600e3; }
function openSession() { return state.sessions.filter((s) => !s.finished && !isStale(s)).sort(byCreated).pop() || null; }
function sortedSessions() { return [...state.sessions].sort((a, b) => b.played_on.localeCompare(a.played_on) || byCreated(b, a)); }
function nextMatchNo(ms) { return ms.length ? Math.max(...ms.map((m) => m.match_no)) + 1 : 1; }
function rotationFor(no) { return ROTATIONS[(no - 1) % ROTATIONS.length]; }
/** všechny zápasy chronologicky (večer → číslo zápasu) */
function chronoMatches() {
  const order = new Map([...state.sessions].sort((a, b) => a.played_on.localeCompare(b.played_on) || byCreated(a, b)).map((s, i) => [String(s.id), i]));
  return state.matches.filter((m) => order.has(String(m.session_id)))
    .sort((a, b) => (order.get(String(a.session_id)) - order.get(String(b.session_id))) || (a.match_no - b.match_no));
}
function isTransient(res) {
  const e = res.error;
  return !e.code || !res.status || res.status >= 500 || /fetch|network|load failed|timeout/i.test(e.message || '');
}

function standings(matches) {
  const st = {};
  PLAYERS.forEach((p) => { st[p] = { name: p, played: 0, wins: 0, points: 0 }; });
  matches.forEach((m) => {
    const aWon = m.score_a > m.score_b;
    m.team_a.forEach((p) => { if (!st[p]) return; st[p].played++; st[p].points += m.score_a; if (aWon) st[p].wins++; });
    m.team_b.forEach((p) => { if (!st[p]) return; st[p].played++; st[p].points += m.score_b; if (!aWon) st[p].wins++; });
  });
  // Pořadí: body (= +/−) → výhry → rating (ELO + bonusy) na začátku večera (u celkové tabulky aktuální rating).
  const one = matches.length && matches.every((m) => sameId(m.session_id, matches[0].session_id));
  const tr = (one && state.startTotal && state.startTotal[String(matches[0].session_id)]) || state.total || {};
  return Object.values(st).sort((a, b) => (b.points - a.points) || (b.wins - a.wins)
    || ((tr[b.name] || 0) - (tr[a.name] || 0)) || (PLAYERS.indexOf(a.name) - PLAYERS.indexOf(b.name)));
}

/* ============ ELO ============ */
/* Bonusy (nikdy se neodečítají, NEvstupují do šancí na výhru):
   účast +10 a pořadí večera 1.–4. +12/+8/+4/0 → po ukončení večera (při shodě výher i bodů se dělí),
   série +5 za každých 5 výher v řadě (i přes více večerů), +5 hráčům týmu, který v zápase uhraje 15+ míčků. */
const BONUS = { ucast: 10, poradi: [12, 8, 4, 0], serie: 5, serieKazdych: 5, body15: 5, body15Min: 15 };
const BONUS_LABEL = { ucast: '🎟️ účast', poradi: '🏅 pořadí', serie: '🔥 série 5 výher', body15: '💥 15+ míčků' };
const emptyBonus = () => ({ ucast: 0, poradi: 0, serie: 0, body15: 0 });
const fmtBonus = (v) => (Number.isInteger(v) ? String(v) : dec(v));
function bonusChips(b) {
  return Object.keys(BONUS_LABEL).filter((k) => b[k]).map((k) => `<span class="chip">${BONUS_LABEL[k]} +${fmtBonus(b[k])}</span>`).join('');
}
const bonusSum = (b) => b.ucast + b.poradi + b.serie + b.body15;
/** Bonus za pořadí večera; hráči se shodnými výhrami i body si bonusy svých míst rozdělí. */
function placementBonus(st) {
  const out = {};
  for (let i = 0; i < st.length;) {
    let j = i;
    while (j + 1 < st.length && st[j + 1].wins === st[i].wins && st[j + 1].points === st[i].points) j++;
    const share = BONUS.poradi.slice(i, j + 1).reduce((s, x) => s + x, 0) / (j - i + 1);
    for (let k = i; k <= j; k++) out[st[k].name] = share;
    i = j + 1;
  }
  return out;
}

/** Týmové ELO ze zápasů: tým = průměr hráčů; výhra větším rozdílem dá víc (0,83× při 11:10 … 2× při 18:3).
 *  rating = čisté ELO ze zápasů (z něj se počítají šance), total = ELO + bonusy (zobrazuje se všude). */
function computeElo(all) {
  const rating = Object.fromEntries(PLAYERS.map((p) => [p, ELO_START]));
  const bonus = Object.fromEntries(PLAYERS.map((p) => [p, emptyBonus()]));
  const hist = Object.fromEntries(PLAYERS.map((p) => [p, [ELO_START]]));
  const perSession = {}; // změna celkem (zápasy + bonusy) za večer
  const startTotal = {}; // id večera → rating (ELO + bonusy) před prvním zápasem večera
  const sessionBonus = {}; // id večera → hráč → rozpis bonusů
  const probs = new Map(); // id zápasu → šance týmu A na výhru PŘED zápasem (jen z čistého ELO)
  const streak = Object.fromEntries(PLAYERS.map((p) => [p, 0]));
  const tot = (p) => rating[p] + bonusSum(bonus[p]);
  const give = (sid, p, kind, v) => {
    if (!v) return;
    bonus[p][kind] += v;
    ((sessionBonus[sid] ||= Object.fromEntries(PLAYERS.map((q) => [q, emptyBonus()])))[p])[kind] += v;
    perSession[sid][p] += v;
  };
  const closeEvening = (sid, ms) => {
    const s = sessionById(sid);
    if (!s || !s.finished || !ms.length) return;
    const pb = placementBonus(standings(ms));
    PLAYERS.forEach((p) => { give(sid, p, 'ucast', BONUS.ucast); give(sid, p, 'poradi', pb[p] || 0); });
    PLAYERS.forEach((p) => { hist[p][hist[p].length - 1] = tot(p); });
  };
  let curSid = null; let curMs = [];
  all.forEach((m) => {
    if (![...m.team_a, ...m.team_b].every((p) => p in rating)) return;
    if (!sameId(m.session_id, curSid)) {
      if (curSid !== null) closeEvening(curSid, curMs);
      curSid = m.session_id; curMs = [];
      startTotal[String(curSid)] = Object.fromEntries(PLAYERS.map((p) => [p, tot(p)]));
    }
    curMs.push(m);
    const sid = m.session_id;
    perSession[sid] ||= Object.fromEntries(PLAYERS.map((p) => [p, 0]));
    const ea = winProb(rating, m.team_a, m.team_b);
    probs.set(String(m.id), ea);
    const sa = m.score_a > m.score_b ? 1 : 0;
    const mult = 0.75 + Math.abs(m.score_a - m.score_b) / 12;
    const d = ELO_K * mult * (sa - ea);
    m.team_a.forEach((p) => { rating[p] += d; perSession[sid][p] += d; });
    m.team_b.forEach((p) => { rating[p] -= d; perSession[sid][p] -= d; });
    const winners = sa ? m.team_a : m.team_b;
    PLAYERS.forEach((p) => {
      if (winners.includes(p)) { streak[p]++; if (streak[p] % BONUS.serieKazdych === 0) give(sid, p, 'serie', BONUS.serie); } else if (m.team_a.includes(p) || m.team_b.includes(p)) streak[p] = 0;
    });
    if (Math.max(m.score_a, m.score_b) >= BONUS.body15Min) winners.forEach((p) => give(sid, p, 'body15', BONUS.body15));
    PLAYERS.forEach((p) => hist[p].push(tot(p)));
  });
  if (curSid !== null) closeEvening(curSid, curMs);
  const total = Object.fromEntries(PLAYERS.map((p) => [p, tot(p)]));
  const ranked = [...PLAYERS].sort((a, b) => total[b] - total[a]);
  return { rating, total, bonus, hist, perSession, sessionBonus, ranked, probs, startTotal };
}
/** Šance týmu A porazit tým B podle ELO (tým = průměr hráčů). */
function winProb(rating, teamA, teamB) {
  const ra = (rating[teamA[0]] + rating[teamA[1]]) / 2;
  const rb = (rating[teamB[0]] + rating[teamB[1]]) / 2;
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}
/** Štěstí (výhry − očekávané výhry podle ELO) a bilance míčků (získané − ztracené) pro každého hráče. */
function luckBalance(all, probs) {
  const out = Object.fromEntries(PLAYERS.map((p) => [p, { wins: 0, exp: 0, luck: 0, bal: 0 }]));
  all.forEach((m) => {
    const pa = probs.get(String(m.id));
    if (pa == null) return;
    const aWon = m.score_a > m.score_b;
    const diff = m.score_a - m.score_b;
    m.team_a.forEach((p) => { const o = out[p]; o.exp += pa; o.wins += aWon ? 1 : 0; o.bal += diff; });
    m.team_b.forEach((p) => { const o = out[p]; o.exp += 1 - pa; o.wins += aWon ? 0 : 1; o.bal -= diff; });
  });
  PLAYERS.forEach((p) => { out[p].luck = out[p].wins - out[p].exp; });
  return out;
}
/** Nejméně pravděpodobná výhra ze všech zápasů (null, když favorit vždy vyhrál). */
function biggestUpset(all, probs) {
  let best = null;
  all.forEach((m) => {
    const pa = probs.get(String(m.id));
    if (pa == null) return;
    const aWon = m.score_a > m.score_b;
    const pw = aWon ? pa : 1 - pa;
    if (pw < 0.5 - 1e-9 && (!best || pw < best.p)) best = { m, p: pw, winners: aWon ? m.team_a : m.team_b };
  });
  return best;
}
/** Desetinné číslo se znaménkem: +3,4 / −2,5 / ±0,0. */
function sdec(x) { const r = Math.round(x * 10) / 10; return r > 0 ? `+${dec(r)}` : r < 0 ? `−${dec(-r)}` : '±0,0'; }
function sessDateOf(m) { const s = sessionById(m.session_id); return s ? fmtShort(s.played_on) : ''; }
function upDown(x) { return x > 0.05 ? 'up' : x < -0.05 ? 'down' : ''; }

/** Zaokrouhlená procenta, která dají vždy dohromady 100. */
function pctPair(pa) { const a = Math.round(pa * 100); return [a, 100 - a]; }

/* ============ HTML STAVEBNÍ BLOKY ============ */
function standingsTable(rows, { clickable = false, elo = null, fx = 'none' } = {}) {
  const any = rows.some((r) => r.played > 0);
  let html = `<thead><tr><th>#</th><th>Hráč</th><th>Z</th><th style="color:var(--win)">Body</th><th>Výhry</th>${elo ? '<th>ELO</th>' : ''}</tr></thead><tbody>`;
  rows.forEach((r, i) => {
    const rank = i + 1;
    const cls = any && rank <= 3 ? `r${rank}` : '';
    html += `<tr class="${any && rank === 1 ? 'lead' : ''} ${clickable ? 'tap' : ''}" ${clickable ? `data-player="${SLUG[r.name]}"` : ''}>
      <td><span class="rank ${cls}">${rank}</span></td>
      <td class="name">${av(r.name, 26, '', fx)}${r.name}</td>
      <td class="dim">${r.played}</td>
      <td class="w">${r.points}</td>
      <td class="p">${r.wins}</td>
      ${elo ? `<td class="delta ${elo[r.name] >= 0 ? 'up' : 'down'}">${signed(elo[r.name])}</td>` : ''}</tr>`;
  });
  return html + '</tbody>';
}

function matchRow(m, { editable = false } = {}) {
  const aWon = m.score_a > m.score_b;
  const sc = aWon
    ? `<b>${m.score_a}</b><s>:</s><i>${m.score_b}</i>`
    : `<i>${m.score_a}</i><s>:</s><b>${m.score_b}</b>`;
  const canEdit = editable && !m._pending;
  const tag = canEdit ? 'button' : 'div';
  // šance na výhru, jakou měly týmy před zápasem (+ 🚨 když vyhrál outsider)
  const pa = state.probs && state.probs.get(String(m.id));
  let prA = ''; let prB = '';
  if (pa != null) {
    const [a, b] = pctPair(pa);
    const upset = aWon ? a < 50 : b < 50;
    prA = `<em class="pr" title="Šance před zápasem">${a} %${aWon && upset ? ' 🚨' : ''}</em>`;
    prB = `<em class="pr" title="Šance před zápasem">${b} %${!aWon && upset ? ' 🚨' : ''}</em>`;
  }
  const q = m._pending ? `<span class="q ${m._failed ? 'fail' : ''}" title="${m._failed ? 'Nepodařilo se uložit' : 'Čeká na odeslání'}">${m._failed ? '⚠' : '⏳'}</span>` : '';
  return `<${tag} class="m-row ${canEdit ? 'editable' : ''} ${m._pending ? 'pending' : ''}" ${canEdit ? `type="button" data-edit="${m.id}"` : ''}>
    <span class="no">#${m.match_no}</span>
    <span class="teams-txt">
      <span class="t ${aWon ? 'win' : ''}"><span class="tn">${m.team_a[0]} & ${m.team_a[1]}</span>${prA}</span>
      <span class="t ${!aWon ? 'win' : ''}"><span class="tn">${m.team_b[0]} & ${m.team_b[1]}</span>${prB}</span>
    </span>
    <span class="sc">${q}${sc}</span>
  </${tag}>`;
}

function formDots(results) {
  return `<div class="form-dots">${results.map((r) => `<span class="${r.win ? 'W' : 'L'}" title="#${r.m.match_no} ${r.m.score_a}:${r.m.score_b}">${r.win ? 'V' : 'P'}</span>`).join('')}</div>`;
}

/* ============ TOAST / MODAL / SYNC ============ */
let toastT;
function toast(text, err = false) {
  el.toast.textContent = text;
  el.toast.classList.toggle('err', err);
  el.toast.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.toast.classList.remove('show'), err ? 3800 : 2200);
}
function updateSyncChip() {
  const waiting = outbox.filter((o) => o.kind === 'match' && !o.failed).length;
  const failed = outbox.filter((o) => o.failed).length;
  const chip = el.syncChip; const txt = chip.querySelector('.txt');
  chip.classList.remove('ok', 'err', 'wait');
  if (failed) { chip.classList.add('err'); txt.textContent = `⚠ ${failed} neuloženo`; }
  else if (waiting && (!online || !navigator.onLine)) { chip.classList.add('wait'); txt.textContent = `Offline · ${waiting} čeká`; }
  else if (waiting) { chip.classList.add('wait'); txt.textContent = `Ukládám ${waiting}…`; }
  else if (!online || !navigator.onLine) { chip.classList.add('err'); txt.textContent = 'Offline'; }
  else if (state.loaded) { chip.classList.add('ok'); txt.textContent = 'Online'; }
  else txt.textContent = 'Načítám…';
}
function openModal(html, bind) {
  el.modalCard.innerHTML = html;
  el.modal.classList.remove('hidden');
  bind && bind(el.modalCard);
}
function closeModal() { el.modal.classList.add('hidden'); el.modalCard.innerHTML = ''; }
el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeModal(); });
function confirmModal({ title, text, ok = 'Ano', danger = false }) {
  return new Promise((resolve) => {
    openModal(`<h3>${title}</h3><p>${text}</p>
      <div class="modal-actions"><button class="btn sec" data-r="0">Zrušit</button><button class="btn ${danger ? 'red' : 'pri'}" data-r="1">${ok}</button></div>`,
    (c) => c.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => { closeModal(); resolve(b.dataset.r === '1'); })));
  });
}
/** Zeptá se na PIN; vrátí zadaný text nebo null při zrušení. */
function pinModal({ title, text, ok = 'Potvrdit', danger = true }) {
  return new Promise((resolve) => {
    openModal(`<h3>🔒 ${title}</h3><p>${text}</p>
      <input id="pinInput" class="pin-input" type="password" autocomplete="off" autocapitalize="off" placeholder="PIN" aria-label="PIN">
      <div class="modal-actions"><button class="btn sec" data-r="0">Zrušit</button><button class="btn ${danger ? 'red' : 'pri'}" data-r="1">${ok}</button></div>`,
    (c) => {
      const inp = c.querySelector('#pinInput');
      setTimeout(() => inp.focus(), 50);
      const done = (v) => { closeModal(); resolve(v); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(inp.value); });
      c.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => done(b.dataset.r === '1' ? inp.value : null)));
    });
  });
}
/** Zavolá chráněnou funkci v databázi; vrátí true při úspěchu. */
async function adminCall(fn, args, pin) {
  const { error } = await db.rpc(fn, { ...args, p_pin: pin });
  if (!error) return true;
  console.error(error);
  const msg = /WRONG_PIN/.test(error.message) ? 'Špatný PIN 🔒'
    : error.code === 'PGRST202' ? 'Ochrana PINem ještě není v databázi zapnutá.'
    : !error.code ? 'Bez připojení – zkus to, až bude signál.'
    : 'Nepovedlo se – zkus znovu.';
  toast(msg, true);
  return false;
}

/* ============ DATA: SERVER + FRONTA ============ */
function rebuildState() {
  const sessions = server.sessions.filter(validSession);
  const matches = server.matches.filter(validMatch);
  outbox.forEach((op) => {
    if (op.kind === 'session') {
      if (!sessions.some((s) => sameId(s.id, op.ref))) {
        sessions.push({ id: op.ref, played_on: op.played_on, finished: false, created_at: op.created_at, _local: true });
      }
    } else if (op.kind === 'match') {
      const dup = matches.some((m) => sameId(m.session_id, op.session_id) && m.match_no === op.match_no && sameMatch(m, op));
      if (!dup) {
        matches.push({
          id: op.uid, session_id: op.session_id, match_no: op.match_no, team_a: op.team_a, team_b: op.team_b,
          score_a: op.score_a, score_b: op.score_b, created_at: op.created_at, _pending: true, _failed: op.failed || null,
        });
      }
    }
  });
  state.sessions = sessions;
  state.matches = matches;
  // ELO včetně zápasů čekajících na odeslání → šance pro další zápas i zpětně pro každý odehraný
  const elo = computeElo(chronoMatches().filter((m) => !m._failed));
  state.probs = elo.probs;
  state.rating = elo.rating;
  state.total = elo.total;
  state.startTotal = elo.startTotal;
  updateFx();
}
/** Role pro animace:
 *  pořadí aktuálního večera (od 1. zapsaného zápasu), jinak posledního odehraného → 👑 1. · 😡 2. · 😰 3. · 🍳 4.
 *  🔥 = aktuální série 3+ výher v řadě (trvá do prohry, i přes týden) · ✨ = lídr celkové tabulky (podle bodů). */
function updateFx() {
  const ok = (m) => !m._failed;
  const open = openSession();
  let cur = open && matchesOf(open.id).some(ok) ? open : null;
  if (!cur) {
    cur = state.sessions.filter((s) => s.finished && matchesOf(s.id).some(ok))
      .sort((a, b) => a.played_on.localeCompare(b.played_on) || byCreated(a, b)).pop() || null;
  }
  FX.sid = cur ? String(cur.id) : null;
  FX.role = {};
  if (cur) standings(matchesOf(cur.id).filter(ok)).forEach((r, i) => { FX.role[r.name] = i + 1; });
  const chrono = chronoMatches().filter(ok);
  FX.fire = new Set(PLAYERS.filter((p) => {
    let n = 0;
    for (let i = chrono.length - 1; i >= 0; i--) {
      const m = chrono[i];
      const inA = m.team_a.includes(p); const inB = m.team_b.includes(p);
      if (!inA && !inB) continue;
      if ((inA && m.score_a > m.score_b) || (inB && m.score_b > m.score_a)) n++; else break;
    }
    return n >= FX_STREAK;
  }));
  const done = chrono.filter((m) => !m._pending);
  FX.leader = done.length ? standings(done)[0].name : null;
}
function saveOutbox() { lsSet(OUTBOX_KEY, outbox); }
function saveCache() { lsSet(CACHE_KEY, { sessions: server.sessions, matches: server.matches, savedAt: Date.now() }); }
function refresh() { rebuildState(); updateSyncChip(); renderAll(); }

async function fetchAll(table) {
  const size = 1000; let from = 0; let out = [];
  for (;;) {
    const { data, error } = await db.from(table).select('*').order('id').range(from, from + size - 1);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < size) break;
    from += size;
  }
  return out;
}

let loading = false;
async function loadAll() {
  if (pendingOps > 0 || loading) { reloadDeferred = true; return; }
  loading = true;
  try {
    const [s, m] = await Promise.all([fetchAll('sessions'), fetchAll('matches')]);
    if (pendingOps > 0) { reloadDeferred = true; return; }
    server.sessions = s; server.matches = m; state.loaded = true; online = true;
    saveCache();
    await autoCloseStale();
  } catch (e) {
    console.warn('Načtení selhalo', e);
    online = false;
  } finally {
    loading = false;
  }
  refresh();
  if (outbox.length) flushOutbox();
  if (reloadDeferred && pendingOps === 0) { reloadDeferred = false; scheduleReload(); }
}
let reloadT;
function scheduleReload() { clearTimeout(reloadT); reloadT = setTimeout(loadAll, 250); }
function opDone() {
  pendingOps = Math.max(0, pendingOps - 1);
  if (pendingOps === 0 && reloadDeferred) { reloadDeferred = false; scheduleReload(); }
}

/** Zapomenutý večer: se zápasy → ukončit, prázdný → smazat (aby v historii nezůstávaly prázdné večery). */
async function closeStaleSession(s, hasMatches) {
  const { error } = hasMatches
    ? await db.from('sessions').update({ finished: true }).eq('id', s.id)
    : await db.from('sessions').delete().eq('id', s.id);
  if (error) return false;
  if (hasMatches) s.finished = true;
  else server.sessions = server.sessions.filter((x) => x.id !== s.id);
  return true;
}
async function autoCloseStale() {
  for (const s of server.sessions.filter((x) => !x.finished)) {
    if (outbox.some((o) => sameId(o.session_id, s.id))) continue;
    if (!isStale(s, server.matches)) continue;
    await closeStaleSession(s, server.matches.some((m) => m.session_id === s.id));
  }
}

/** Odešle frontu neuložených zápasů. Bezpečné opakovat – duplicity se rozpoznají. */
async function flushOutbox() {
  if (flushing || !outbox.some((o) => !o.failed)) return;
  flushing = true;
  updateSyncChip();
  try {
    for (const op of [...outbox]) {
      if (op.failed || !outbox.includes(op)) continue;
      inFlightUid = op.uid || op.ref;
      const ok = op.kind === 'session' ? await flushSession(op) : await flushMatch(op);
      inFlightUid = null;
      saveOutbox();
      refresh();
      if (ok === 'stop') { online = false; break; }
      online = true;
    }
  } catch (e) {
    console.error(e);
  } finally {
    inFlightUid = null;
    flushing = false;
    updateSyncChip();
  }
}

async function flushSession(op, attempt = 0) {
  let real = null;
  const res = await db.from('sessions').insert({ played_on: op.played_on }).select().single();
  if (!res.error) real = res.data;
  else if (res.error.code === '23505') {
    // už existuje rozehraný večer (jiný telefon nebo náš dřívější pokus) → použijeme ho…
    const r2 = await db.from('sessions').select('*').eq('finished', false).limit(1);
    if (r2.error || !r2.data.length) return 'stop';
    const cand = r2.data[0];
    const r3 = await db.from('matches').select('session_id,created_at').eq('session_id', cand.id);
    if (r3.error) return 'stop';
    // …ledaže je to zapomenutý večer z minula – ten ukončíme a založíme nový
    if (isStale(cand, r3.data)) {
      if (attempt > 1 || !(await closeStaleSession(cand, r3.data.length > 0))) return 'stop';
      return flushSession(op, attempt + 1);
    }
    real = cand;
  } else if (isTransient(res)) return 'stop';
  else { op.failed = res.error.message; return 'failed'; }
  outbox.forEach((o) => { if (o.kind === 'match' && sameId(o.session_id, op.ref)) o.session_id = real.id; });
  if (sheet && sheet.kind === 'session' && sameId(sheet.id, op.ref)) sheet.id = real.id;
  outbox = outbox.filter((o) => o !== op);
  if (!server.sessions.some((s) => s.id === real.id)) server.sessions.push(real);
  return 'ok';
}

async function flushMatch(op) {
  if (typeof op.session_id === 'string' && op.session_id.startsWith('local-')) return 'ok'; // čeká na založení večera
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = { session_id: op.session_id, match_no: op.match_no, team_a: op.team_a, team_b: op.team_b, score_a: op.score_a, score_b: op.score_b };
    const res = await db.from('matches').insert(row).select().single();
    if (!res.error) {
      outbox = outbox.filter((o) => o !== op);
      server.matches.push(res.data);
      return 'ok';
    }
    if (res.error.code === '23505') {
      // číslo zápasu už je obsazené: buď je to tentýž zápas (ztracená odpověď), nebo jiný → přečíslovat
      const ex = await db.from('matches').select('*').eq('session_id', op.session_id).eq('match_no', op.match_no).maybeSingle();
      if (ex.error) return 'stop';
      if (ex.data && sameMatch(ex.data, op)) {
        outbox = outbox.filter((o) => o !== op);
        if (!server.matches.some((m) => m.id === ex.data.id)) server.matches.push(ex.data);
        return 'ok';
      }
      const mx = await db.from('matches').select('match_no').eq('session_id', op.session_id).order('match_no', { ascending: false }).limit(1);
      if (mx.error) return 'stop';
      op.match_no = (mx.data[0] ? mx.data[0].match_no : 0) + 1;
      continue;
    }
    if (isTransient(res)) return 'stop';
    op.failed = res.error.code === '42501' ? 'Večer už byl mezitím ukončen' : res.error.message;
    return 'failed';
  }
  return 'stop';
}

function renderOutboxBanner() {
  const failed = outbox.filter((o) => o.failed);
  const waiting = outbox.filter((o) => o.kind === 'match' && !o.failed).length;
  if (!failed.length && !waiting) { el.outboxBanner.classList.add('hidden'); return; }
  el.outboxBanner.classList.remove('hidden');
  if (failed.length) {
    el.outboxBanner.className = 'outbox-banner err';
    el.outboxBanner.innerHTML = `<div><b>⚠ ${failed.length} ${plural(failed.length, 'zápas se nepodařilo', 'zápasy se nepodařilo', 'zápasů se nepodařilo')} uložit.</b>
      <div class="small">${esc(failed[0].failed || '')}</div></div>
      <div class="ob-actions"><button type="button" class="btn sec" data-ob="retry">Zkusit znovu</button><button type="button" class="btn red" data-ob="drop">Zahodit</button></div>`;
  } else {
    el.outboxBanner.className = 'outbox-banner';
    el.outboxBanner.innerHTML = `<div><b>⏳ ${waiting} ${plural(waiting, 'zápas čeká', 'zápasy čekají', 'zápasů čeká')} na odeslání</b>
      <div class="small">Je uložený v telefonu a odešle se sám, jakmile bude signál. Klidně hrajte dál.</div></div>`;
  }
}

/* ============ HRÁT ============ */
function currentPlay() {
  const sess = openSession();
  const ms = sess ? matchesOf(sess.id) : [];
  const no = nextMatchNo(ms);
  return { sess, ms, no, rot: rotationFor(no), rotIdx: (no - 1) % ROTATIONS.length };
}

function renderPlay() {
  const { sess, ms, no, rot, rotIdx } = currentPlay();
  if (sess) {
    el.sessionDate.textContent = fmtLong(sess.played_on);
    el.sessionSub.textContent = ms.length ? `${nZap(ms.length)} · začátek ${fmtTime(ms[0].created_at)}` : 'Večer založen – zapiš první zápas';
    el.liveBadge.classList.remove('hidden');
  } else {
    el.sessionDate.textContent = fmtLong(todayISO());
    el.sessionSub.textContent = 'Nový večer se založí s dnešním datem prvním zapsaným zápasem';
    el.liveBadge.classList.add('hidden');
  }
  renderOutboxBanner();
  el.tonightTable.innerHTML = standingsTable(standings(ms), { fx: 'evening' });
  el.matchNo.textContent = no;
  el.rotationLabel.textContent = `Kombinace ${rotIdx + 1}/3`;
  const names = (t) => `<div class="team-avs">${av(t[0], 46)}${av(t[1], 46)}</div>${t[0]}<span class="amp">&</span>${t[1]}`;
  el.teamANames.innerHTML = names(rot.teamA);
  el.teamBNames.innerHTML = names(rot.teamB);
  const [pa, pb] = pctPair(winProb(state.rating || {}, rot.teamA, rot.teamB) || 0.5);
  $('probA').textContent = `${pa} %`;
  $('probB').textContent = `${pb} %`;
  $('probFillA').style.flexGrow = pa;
  $('probFillB').style.flexGrow = pb;
  $('probA').classList.toggle('fav', pa > pb);
  $('probB').classList.toggle('fav', pb > pa);
  el.tonightCount.textContent = ms.length;
  el.tonightMatches.innerHTML = ms.length
    ? [...ms].reverse().map((m) => matchRow(m, { editable: true })).join('')
    : '<p class="empty">Zatím žádný zápas. Hurá na kurt! 🎾</p>';
  el.undoBtn.disabled = !ms.length;
  el.finishBtn.disabled = !sess;
  validateScores();
}

function handleScoreInput(team) {
  const src = team === 'A' ? el.scoreA : el.scoreB;
  const dst = team === 'A' ? el.scoreB : el.scoreA;
  const raw = src.value.trim();
  if (raw === '') { dst.value = ''; validateScores(); return; }
  let n = parseInt(raw, 10);
  if (isNaN(n)) { src.value = ''; dst.value = ''; validateScores(); return; }
  n = Math.max(0, Math.min(TOTAL, n));
  src.value = n;
  dst.value = TOTAL - n;
  validateScores();
}
function adjustScore(team, d) {
  const inp = team === 'A' ? el.scoreA : el.scoreB;
  let v = parseInt(inp.value, 10);
  v = isNaN(v) ? (d > 0 ? 11 : 10) : Math.max(0, Math.min(TOTAL, v + d));
  inp.value = v;
  handleScoreInput(team);
  if (navigator.vibrate) navigator.vibrate(8);
}
function setScores(a, b) { el.scoreA.value = a; el.scoreB.value = b; validateScores(); }
function clearScores() { el.scoreA.value = ''; el.scoreB.value = ''; validateScores(); }

function validateScores() {
  const a = parseInt(el.scoreA.value, 10);
  const b = parseInt(el.scoreB.value, 10);
  el.scoreA.classList.remove('winner'); el.scoreB.classList.remove('winner');
  el.quickGrid.querySelectorAll('button').forEach((btn) => btn.classList.toggle('sel', +btn.dataset.a === a && +btn.dataset.b === b));
  if (el.scoreA.value === '' || el.scoreB.value === '') {
    el.confirmBtn.disabled = true; el.validationMsg.textContent = ''; el.validationMsg.className = 'validation';
    return false;
  }
  const ok = !isNaN(a) && !isNaN(b) && a >= 0 && b >= 0 && a + b === TOTAL;
  el.confirmBtn.disabled = !ok;
  if (ok) {
    const { rot } = currentPlay();
    const winners = a > b ? rot.teamA : rot.teamB;
    (a > b ? el.scoreA : el.scoreB).classList.add('winner');
    const pA = winProb(state.rating || {}, rot.teamA, rot.teamB) || 0.5;
    const upset = (a > b ? pA : 1 - pA) < 0.5;
    el.validationMsg.textContent = `Vítězí ${winners[0]} & ${winners[1]} (${a}:${b})${upset ? ' · 🚨 překvapení!' : ''}`;
    el.validationMsg.className = 'validation ok';
  } else {
    el.validationMsg.textContent = 'Součet míčků musí být přesně 21.';
    el.validationMsg.className = 'validation';
  }
  return ok;
}

/** Zápas se nejdřív uloží do telefonu (fronta), pak se odešle. Funguje i bez signálu. */
function confirmMatch() {
  if (!validateScores()) return;
  const a = parseInt(el.scoreA.value, 10);
  const b = parseInt(el.scoreB.value, 10);
  let sess = openSession();
  if (!sess) {
    const ref = `local-${uid()}`;
    outbox.push({ kind: 'session', ref, played_on: todayISO(), created_at: new Date().toISOString() });
    sess = { id: ref };
  }
  const no = nextMatchNo(matchesOf(sess.id));
  const rot = rotationFor(no);
  outbox.push({
    kind: 'match', uid: `q-${uid()}`, session_id: sess.id, match_no: no, team_a: [...rot.teamA], team_b: [...rot.teamB],
    score_a: a, score_b: b, created_at: new Date().toISOString(),
  });
  saveOutbox();
  clearScores();
  refresh();
  toast(`Zápas #${no} zapsán (${a}:${b})`);
  if (navigator.vibrate) navigator.vibrate([10, 40, 10]);
  flushOutbox();
}

async function undoLast() {
  const { ms } = currentPlay();
  const last = ms[ms.length - 1];
  if (!last) return;
  if (last._pending) {
    if (inFlightUid === last.id) { toast('Právě se ukládá – zkus to za vteřinu.', true); return; }
    outbox = outbox.filter((o) => o.uid !== last.id);
    // prázdný lokální večer už nepotřebujeme
    outbox = outbox.filter((o) => o.kind !== 'session' || outbox.some((m) => m.kind === 'match' && m.session_id === o.ref));
    saveOutbox();
    refresh();
    setScores(last.score_a, last.score_b);
    toast(`Zápas #${last.match_no} vrácen k úpravě`);
    return;
  }
  pendingOps++;
  server.matches = server.matches.filter((m) => m.id !== last.id);
  refresh();
  setScores(last.score_a, last.score_b);
  const { error } = await db.from('matches').delete().eq('id', last.id);
  if (error) {
    server.matches.push(last); clearScores();
    toast(!error.code ? 'Bez signálu nejde vrátit – zkus to, až se připojíš.' : 'Vrácení se nepovedlo – zkus znovu.', true);
  } else toast(`Zápas #${last.match_no} vrácen k úpravě`);
  opDone();
  refresh();
}

async function finishSession() {
  const sess = openSession();
  if (!sess) return;
  const ms = matchesOf(sess.id);
  if (ms.some((m) => m._pending)) { toast('Nejdřív se musí odeslat všechny zápasy (čeká se na signál).', true); return; }
  const ok = await confirmModal({
    title: 'Ukončit večer?',
    text: ms.length ? `Večer se uloží do historie (${nZap(ms.length)}). Další zapsaný zápas založí nový večer.` : 'Večer nemá žádné zápasy – bude smazán.',
    ok: ms.length ? 'Ukončit' : 'Smazat',
    danger: !ms.length,
  });
  if (!ok) return;
  if (sess._local) { outbox = outbox.filter((o) => o.ref !== sess.id); saveOutbox(); refresh(); return; }
  pendingOps++;
  const { error } = ms.length
    ? await db.from('sessions').update({ finished: true }).eq('id', sess.id)
    : await db.from('sessions').delete().eq('id', sess.id);
  opDone();
  if (error) { toast(!error.code ? 'Bez signálu nejde ukončit – zkus to po připojení.' : 'Nepovedlo se – zkus znovu.', true); return; }
  if (ms.length) sess.finished = true;
  else server.sessions = server.sessions.filter((s) => s !== sess);
  clearScores();
  refresh();
  if (ms.length) showFinishedModal(sess.id);
}

function showFinishedModal(sid) {
  const st = standings(matchesOf(sid));
  openModal(`<div class="finish-hero">${av(st[0].name, 96, 'big')}</div>
    <h3 class="center">Večer vyhrál ${st[0].name}!</h3>
    <p class="center">${st[0].points} bodů · ${st[0].wins} výher</p>
    <button class="btn pri wide" id="fShare">📤 Sdílet výsledky do skupiny</button>
    <button class="btn sec wide mt" id="fClose">Zavřít</button>`, (c) => {
    c.querySelector('#fShare').onclick = () => { closeModal(); openSharePreview(sid); };
    c.querySelector('#fClose').onclick = closeModal;
  });
}

/* ============ EDITACE ZÁPASU ============ */
function openEditMatch(id) {
  const m = state.matches.find((x) => sameId(x.id, id));
  if (!m || m._pending) return;
  const sess = sessionById(m.session_id);
  const locked = sess.finished; // ukončený večer → změny jen s PINem
  openModal(`
    <h3>${locked ? '🔒 ' : ''}Upravit zápas #${m.match_no}</h3>
    <p>${fmtLong(sess.played_on)}${locked ? '<br>Večer je ukončený – úprava vyžaduje PIN.' : ''}</p>
    <div class="edit-scores">
      <div><div class="lbl">${m.team_a[0]} & ${m.team_a[1]}</div><input class="score-input" id="eA" type="number" inputmode="numeric" value="${m.score_a}"></div>
      <div class="muted" style="padding-top:18px;font-weight:800">:</div>
      <div><div class="lbl">${m.team_b[0]} & ${m.team_b[1]}</div><input class="score-input" id="eB" type="number" inputmode="numeric" value="${m.score_b}"></div>
    </div>
    ${locked ? '<input id="ePin" class="pin-input" type="password" autocomplete="off" autocapitalize="off" placeholder="PIN" aria-label="PIN">' : ''}
    <div class="modal-actions"><button class="btn sec" id="eCancel">Zrušit</button><button class="btn pri" id="eSave">Uložit</button></div>
    <button class="link-danger" id="eDel">Smazat tento zápas</button>`, (c) => {
    const eA = c.querySelector('#eA'); const eB = c.querySelector('#eB');
    const sync = (src, dst) => { let n = parseInt(src.value, 10); if (isNaN(n)) return; n = Math.max(0, Math.min(TOTAL, n)); src.value = n; dst.value = TOTAL - n; };
    eA.addEventListener('input', () => sync(eA, eB));
    eB.addEventListener('input', () => sync(eB, eA));
    [eA, eB].forEach((i) => i.addEventListener('focus', () => i.select()));
    c.querySelector('#eCancel').onclick = closeModal;
    c.querySelector('#eSave').onclick = async () => {
      const a = parseInt(eA.value, 10); const b = parseInt(eB.value, 10);
      if (isNaN(a) || isNaN(b) || a + b !== TOTAL) { toast('Součet musí být 21.', true); return; }
      const pin = locked ? c.querySelector('#ePin').value : null;
      closeModal();
      if (locked) {
        if (!(await adminCall('admin_update_match', { p_id: m.id, p_a: a, p_b: b }, pin))) return;
      } else {
        const { error } = await db.from('matches').update({ score_a: a, score_b: b }).eq('id', m.id);
        if (error) { toast(!error.code ? 'Bez signálu nejde upravit.' : 'Uložení se nepovedlo.', true); return; }
      }
      m.score_a = a; m.score_b = b; refresh(); toast('Zápas upraven');
    };
    c.querySelector('#eDel').onclick = async () => {
      closeModal();
      if (locked) {
        const pin = await pinModal({ title: `Smazat zápas #${m.match_no}?`, text: 'Večer je ukončený. Zadej PIN pro smazání zápasu.', ok: 'Smazat' });
        if (pin === null || !(await adminCall('admin_delete_match', { p_id: m.id }, pin))) return;
      } else {
        if (!(await confirmModal({ title: `Smazat zápas #${m.match_no}?`, text: 'Zápas zmizí z výsledků i statistik.', ok: 'Smazat', danger: true }))) return;
        const { error } = await db.from('matches').delete().eq('id', m.id);
        if (error) { toast(!error.code ? 'Bez signálu nejde smazat.' : 'Smazání se nepovedlo.', true); return; }
      }
      server.matches = server.matches.filter((x) => x.id !== m.id); refresh(); toast('Zápas smazán');
    };
  });
}

/* ============ HISTORIE ============ */
function renderHistory() {
  const list = sortedSessions();
  if (!list.length) {
    el.sessionList.innerHTML = `<div class="card"><p class="empty">${state.loaded ? 'Zatím žádné odehrané večery.' : 'Načítám…'}</p></div>`;
    return;
  }
  el.sessionList.innerHTML = list.map((s) => {
    const ms = matchesOf(s.id);
    const st = standings(ms);
    return `<button type="button" class="s-card" data-session="${s.id}">
      <div class="s-top">
        <div><div class="s-date">${fmtLong(s.played_on)}</div>
        <div class="s-meta">${nZap(ms.length)} · ${ms.length * TOTAL} míčků</div></div>
        ${!s.finished ? '<span class="s-open">LIVE</span>' : ''}
      </div>
      ${ms.length ? `<div class="podium">${st.map((r, i) => `<div class="${i === 0 ? 'first' : ''}">${av(r.name, 34)}<div class="nm">${r.name}</div><div class="vl">${r.points} b · ${r.wins} V</div></div>`).join('')}</div>` : ''}
    </button>`;
  }).join('');
}

function renderSessionSheet() {
  const s = sessionById(sheet.id);
  if (!s) { if (state.loaded) closeSheet(); return; }
  const ms = matchesOf(s.id);
  const st = standings(ms);
  const elo = computeElo(chronoMatches().filter((m) => !m._pending));
  const deltas = elo.perSession[s.id];
  const sb = elo.sessionBonus[s.id];
  const bonusCard = ms.length ? `<div class="card"><div class="card-title"><span>Bonusy večera</span><span class="muted small">přičtené k ELO</span></div>
      ${st.map((r) => { const b = sb ? sb[r.name] : emptyBonus(); return `<div class="bonus-row">${av(r.name, 22)}<b>${r.name}</b>
        <span class="bonus-chips">${bonusChips(b) || '<span class="muted">–</span>'}</span><span class="bonus-sum">${bonusSum(b) ? '+' + fmtBonus(bonusSum(b)) : '0'}</span></div>`; }).join('')}
      ${s.finished ? '' : '<p class="muted small ff-note">Účast a pořadí se připíšou po ukončení večera.</p>'}</div>` : '';
  el.sheetTitle.textContent = fmtLong(s.played_on);
  el.sheetSub.textContent = `${nZap(ms.length)}${s.finished ? '' : ' · probíhá'}${ms.length ? ` · vítěz ${st[0].name} 🏆` : ''}`;
  const canReopen = s.finished && !openSession();
  el.sheetBody.innerHTML = `
    <div class="card"><div class="card-title"><span>Tabulka večera</span><span class="muted small">klepni na hráče</span></div>
      <table class="standings">${standingsTable(st, { clickable: true, elo: deltas, fx: sameId(s.id, FX.sid) ? 'evening' : 'none' })}</table>
      <p class="muted small ff-note">ELO = změna ze zápasů + bonusy večera.</p></div>
    ${bonusCard}
    ${ms.length ? '<button type="button" class="btn-share" id="shareBtn">📤 Sdílet výsledky do Messengeru</button>' : ''}
    <div class="card"><div class="card-title"><span>Zápasy</span><span class="muted small">klepni pro úpravu</span></div>
      <div class="match-list">${ms.length ? ms.map((m) => matchRow(m, { editable: true })).join('') : '<p class="empty">Žádné zápasy.</p>'}</div></div>
    ${s._local ? '' : `<div class="row-2">
      ${canReopen ? '<button type="button" class="btn-ghost ball" id="reopenBtn">🔒 Znovu otevřít</button>' : '<span></span>'}
      <button type="button" class="btn-ghost danger" id="deleteSessionBtn">🔒 Smazat večer</button>
    </div>`}`;
  const sh = $('shareBtn');
  if (sh) sh.onclick = () => openSharePreview(s.id);
  const r = $('reopenBtn');
  if (r) r.onclick = async () => {
    const pin = await pinModal({ title: 'Znovu otevřít večer?', text: 'Ukončený večer je chráněný. Zadej PIN.', ok: 'Otevřít', danger: false });
    if (pin === null || !(await adminCall('admin_reopen_session', { p_id: s.id }, pin))) return;
    s.finished = false; toast('Večer znovu otevřen – pokračuj v záložce Hrát'); refresh();
  };
  const d = $('deleteSessionBtn');
  if (d) d.onclick = async () => {
    const pin = await pinModal({ title: 'Smazat celý večer?', text: `${fmtLong(s.played_on)} – ${nZap(ms.length)} se nenávratně smaže (zůstane jen v denní záloze). Zadej PIN.`, ok: 'Smazat' });
    if (pin === null || !(await adminCall('admin_delete_session', { p_id: s.id }, pin))) return;
    server.sessions = server.sessions.filter((x) => x.id !== s.id);
    server.matches = server.matches.filter((m) => m.session_id !== s.id);
    toast('Večer smazán'); closeSheet(); refresh();
  };
}

/* ============ STATISTIKY ============ */
function computeStats() {
  const all = chronoMatches().filter((m) => !m._pending);
  const sessions = [...state.sessions].filter((s) => matchesOf(s.id).some((m) => !m._pending))
    .sort((a, b) => a.played_on.localeCompare(b.played_on) || byCreated(a, b));
  const overall = standings(all);
  const nightsWon = Object.fromEntries(PLAYERS.map((p) => [p, 0]));
  const nightRows = sessions.map((s) => {
    const st = standings(matchesOf(s.id).filter((m) => !m._pending));
    nightsWon[st[0].name]++;
    return { s, st };
  });
  const elo = computeElo(all);
  return { all, sessions, overall, nightsWon, nightRows, elo };
}

function playerResults(all) {
  const res = Object.fromEntries(PLAYERS.map((p) => [p, []]));
  all.forEach((m) => {
    const aWon = m.score_a > m.score_b;
    m.team_a.forEach((p) => res[p] && res[p].push({ m, win: aWon }));
    m.team_b.forEach((p) => res[p] && res[p].push({ m, win: !aWon }));
  });
  return res;
}
function streaks(results) {
  let longest = 0; let run = 0;
  results.forEach((r) => { run = r.win ? run + 1 : 0; longest = Math.max(longest, run); });
  let cur = 0; const lastWin = results.length ? results[results.length - 1].win : null;
  for (let i = results.length - 1; i >= 0 && results[i].win === lastWin; i--) cur++;
  return { longest, cur, curWin: lastWin };
}

function renderStats() {
  if (!state.loaded) return;
  const { all, sessions, overall, nightsWon, nightRows, elo } = computeStats();
  const close = all.filter((m) => Math.abs(m.score_a - m.score_b) === 1).length;
  el.kpis.innerHTML = [
    [sessions.length, plural(sessions.length, 'večer', 'večery', 'večerů'), true],
    [all.length, plural(all.length, 'zápas', 'zápasy', 'zápasů')],
    [all.length * TOTAL, 'odehraných míčků'],
    [close, 'těsných 11:10'],
  ].map(([v, l, acc]) => `<div class="kpi ${acc ? 'accent' : ''}"><div class="kpi-val">${v.toLocaleString('cs-CZ')}</div><div class="kpi-lbl">${l}</div></div>`).join('');

  el.playerStrip.innerHTML = elo.ranked.map((p) => `<button type="button" class="pcard" data-player="${SLUG[p]}">
      ${av(p, 56, '', 'strip')}<div class="pc-name">${p}</div><div class="pc-elo">${Math.round(elo.total[p])}</div></button>`).join('');

  if (!all.length) {
    el.overallTable.innerHTML = '<tbody><tr><td class="empty">Zatím žádná data.</td></tr></tbody>';
    [el.formList, el.records, el.funFacts, el.pairs, el.h2hTable, el.scoreDist].forEach((x) => { x.innerHTML = '<p class="empty">Zatím žádná data.</p>'; });
    return;
  }

  // Celková tabulka (ELO jako číslo pod jménem)
  const any = overall.some((r) => r.played);
  el.overallTable.innerHTML = `<thead><tr><th>#</th><th>Hráč</th><th>Z</th><th style="color:var(--win)">Body</th><th title="Míčky získané − ztracené">+/−</th><th>V</th><th>Ø</th><th title="Vyhrané večery">👑</th></tr></thead><tbody>` +
    overall.map((r, i) => `<tr class="tap ${any && i === 0 ? 'lead' : ''}" data-player="${SLUG[r.name]}">
      <td><span class="rank ${any && i < 3 ? 'r' + (i + 1) : ''}">${i + 1}</span></td>
      <td class="name">${av(r.name, 24, '', 'leader')}<span class="nm-elo">${r.name}<small>ELO ${Math.round(elo.total[r.name])}</small></span></td>
      <td class="dim">${r.played}</td>
      <td class="w">${r.points}</td>
      <td class="pm ${2 * r.points - TOTAL * r.played >= 0 ? 'up' : 'down'}">${signed(2 * r.points - TOTAL * r.played)}</td>
      <td class="p">${r.wins}</td>
      <td class="dim">${r.played ? dec(r.points / r.played) : '–'}</td>
      <td class="p">${nightsWon[r.name]}</td></tr>`).join('') + '</tbody>';

  // Zajímavosti (štěstí, největší překvapení, bilance míčků)
  const lb = luckBalance(all, elo.probs);
  const lucky = PLAYERS.slice().sort((a, b) => lb[b].luck - lb[a].luck)[0];
  const balKing = PLAYERS.slice().sort((a, b) => lb[b].bal - lb[a].bal)[0];
  const up = biggestUpset(all, elo.probs);
  const ffRow = (attr, label, who, desc, val, cls = '') => `<button type="button" class="rec tap" ${attr}>
      <div><div class="l">${label}</div><div class="d"><b class="ff-who">${who}</b>${desc ? ` · ${desc}` : ''}</div></div>
      <div class="v ${cls}">${val}</div></button>`;
  el.funFacts.innerHTML = [
    ffRow(`data-player="${SLUG[lucky]}"`, '🍀 Štístko', lucky, 'výhry nad očekávání', sdec(lb[lucky].luck), upDown(lb[lucky].luck)),
    up
      ? ffRow(`data-session="${up.m.session_id}"`, '🚨 Překvapení', `${up.winners[0]} & ${up.winners[1]} ${Math.max(up.m.score_a, up.m.score_b)}:${Math.min(up.m.score_a, up.m.score_b)}`,
        sessDateOf(up.m), `<small>šance</small> ${Math.round(up.p * 100)} %`)
      : '<div class="rec"><div><div class="l">🚨 Překvapení</div><div class="d">favorit zatím vždy vyhrál</div></div><div class="v">–</div></div>',
    ffRow(`data-player="${SLUG[balKing]}"`, '⚖️ Bilance', balKing, 'míčky získané − ztracené', signed(lb[balKing].bal), upDown(lb[balKing].bal)),
  ].join('') + '<p class="muted small ff-note">Štístko = výhry navíc oproti šancím podle ELO. Bilance = rozdíl míčků ze všech zápasů.</p>';

  // Forma
  const res = playerResults(all);
  el.formList.innerHTML = PLAYERS.map((p) => `<button type="button" class="form-row tap" data-player="${SLUG[p]}"><span>${av(p, 22)}${p}</span>${formDots(res[p].slice(-10))}</button>`).join('') +
    '<p class="muted small" style="margin:2px 0 0">V = výhra, P = prohra · nejnovější vpravo</p>';

  // Rekordy
  const sessDate = sessDateOf;
  const big = [...all].sort((x, y) => Math.abs(y.score_a - y.score_b) - Math.abs(x.score_a - x.score_b))[0];
  const bigWinners = big.score_a > big.score_b ? big.team_a : big.team_b;
  let bestNightPts = null; let bestNightWins = null;
  nightRows.forEach(({ s, st }) => st.forEach((r) => {
    if (!bestNightPts || r.points > bestNightPts.v) bestNightPts = { v: r.points, p: r.name, d: s.played_on };
    if (!bestNightWins || r.wins > bestNightWins.v) bestNightWins = { v: r.wins, p: r.name, d: s.played_on };
  }));
  let longest = { v: 0, p: '' }; const current = {};
  PLAYERS.forEach((p) => {
    const sk = streaks(res[p]);
    if (sk.longest > longest.v) longest = { v: sk.longest, p };
    current[p] = { cur: sk.cur, win: sk.curWin };
  });
  const hot = PLAYERS.filter((p) => current[p].win).sort((a, b) => current[b].cur - current[a].cur)[0];
  const clutch = Object.fromEntries(PLAYERS.map((p) => [p, 0]));
  all.filter((m) => Math.abs(m.score_a - m.score_b) === 1).forEach((m) => (m.score_a > m.score_b ? m.team_a : m.team_b).forEach((p) => clutch[p]++));
  const clutchKing = PLAYERS.slice().sort((a, b) => clutch[b] - clutch[a])[0];
  const recs = [
    ['Největší výhra', `${bigWinners[0]} & ${bigWinners[1]} · ${sessDate(big)}`, `${Math.max(big.score_a, big.score_b)}:${Math.min(big.score_a, big.score_b)}`],
    ['Nejvíc bodů za večer', `${bestNightPts.p} · ${fmtShort(bestNightPts.d)}`, bestNightPts.v],
    ['Nejvíc výher za večer', `${bestNightWins.p} · ${fmtShort(bestNightWins.d)}`, bestNightWins.v],
    ['Nejdelší série výher', longest.p, `${longest.v}×`],
    ['Má formu (zmrd) 🔥', hot ? `${hot} – aktuální série` : 'nikdo nemá sérii', hot ? `${current[hot].cur}×` : '–'],
    ['Král těsných zápasů', `${clutchKing} – výhry o 1 míček`, clutch[clutchKing]],
    ['Nejvyšší ELO', elo.ranked[0], Math.round(elo.total[elo.ranked[0]])],
  ];
  el.records.innerHTML = recs.map(([l, d, v]) => `<div class="rec"><div><div class="l">${l}</div><div class="d">${d}</div></div><div class="v">${v}</div></div>`).join('');

  // Dvojice
  const pairStats = ROTATIONS.flatMap((r) => [r.teamA, r.teamB]).map((pair) => {
    const key = teamKey(pair);
    let n = 0; let w = 0;
    all.forEach((m) => {
      if (teamKey(m.team_a) === key) { n++; if (m.score_a > m.score_b) w++; }
      if (teamKey(m.team_b) === key) { n++; if (m.score_b > m.score_a) w++; }
    });
    return { pair, n, w, pct: n ? w / n : 0 };
  }).sort((a, b) => (b.pct - a.pct) || (b.n - a.n));
  el.pairs.innerHTML = pairStats.map((s, i) => `<div class="bar-row"><div><div class="lbl">${av(s.pair[0], 20, 'mini')}${av(s.pair[1], 20, 'mini ov')} ${s.pair[0]} & ${s.pair[1]}</div>
      <div class="bar-track"><div class="bar-fill ${i === 0 ? 'ball' : ''}" style="width:${Math.round(s.pct * 100)}%"></div></div></div>
      <div class="val">${Math.round(s.pct * 100)} % <div class="sub">${s.w} z ${s.n}</div></div></div>`).join('');

  // Head to head
  const h2h = {};
  PLAYERS.forEach((p) => { h2h[p] = {}; PLAYERS.forEach((q) => { h2h[p][q] = { w: 0, l: 0 }; }); });
  all.forEach((m) => {
    const aWon = m.score_a > m.score_b;
    m.team_a.forEach((p) => m.team_b.forEach((q) => {
      if (!h2h[p] || !h2h[q]) return;
      h2h[p][q][aWon ? 'w' : 'l']++; h2h[q][p][aWon ? 'l' : 'w']++;
    }));
  });
  el.h2hTable.innerHTML = `<thead><tr><th></th>${PLAYERS.map((q) => `<th title="${q}">${av(q, 28)}</th>`).join('')}</tr></thead><tbody>` +
    PLAYERS.map((p) => `<tr><th class="rowh">${av(p, 22)}${p}</th>${PLAYERS.map((q) => {
      if (p === q) return '<td class="self">·</td>';
      const { w, l } = h2h[p][q];
      return `<td class="${w > l ? 'good' : w < l ? 'bad' : ''}">${w}–${l}</td>`;
    }).join('')}</tr>`).join('') + '</tbody>';

  // Nejčastější výsledky
  const dist = {};
  all.forEach((m) => { const k = `${Math.max(m.score_a, m.score_b)}:${Math.min(m.score_a, m.score_b)}`; dist[k] = (dist[k] || 0) + 1; });
  const distArr = Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxD = distArr[0][1];
  el.scoreDist.innerHTML = distArr.map(([k, v]) => `<div class="bar-row"><div><div class="lbl">${k}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${(v / maxD) * 100}%"></div></div></div>
    <div class="val">${v}× <div class="sub">${pct(v, all.length)} %</div></div></div>`).join('');

  renderCharts(all, nightRows);
}

/* ============ PROFIL HRÁČE ============ */
function playerProfile(p, all, nightRows, elo) {
  const res = all.filter((m) => m.team_a.includes(p) || m.team_b.includes(p)).map((m) => {
    const inA = m.team_a.includes(p);
    const my = inA ? m.score_a : m.score_b;
    const opp = inA ? m.score_b : m.score_a;
    return { m, win: my > opp, my, opp, partner: (inA ? m.team_a : m.team_b).find((x) => x !== p), opps: inA ? m.team_b : m.team_a };
  });
  const others = PLAYERS.filter((q) => q !== p);
  const partners = others.map((q) => {
    const rs = res.filter((r) => r.partner === q);
    const w = rs.filter((r) => r.win).length;
    return { q, n: rs.length, w, rate: rs.length ? w / rs.length : 0, avgPts: rs.length ? rs.reduce((s, r) => s + r.my, 0) / rs.length : 0 };
  }).sort((a, b) => (b.rate - a.rate) || (b.avgPts - a.avgPts));
  const opponents = others.map((q) => {
    const rs = res.filter((r) => r.opps.includes(q));
    const w = rs.filter((r) => r.win).length;
    return { q, n: rs.length, w, l: rs.length - w, rate: rs.length ? w / rs.length : 0 };
  }).sort((a, b) => (b.rate - a.rate) || (b.n - a.n));
  const nights = nightRows.map(({ s, st }) => {
    const idx = st.findIndex((r) => r.name === p);
    const row = st[idx];
    return { s, rank: idx + 1, wins: row.wins, played: row.played, points: row.points, delta: (elo.perSession[s.id] || {})[p] || 0 };
  }).filter((n) => n.played > 0);
  const nightOrder = [...nights].sort((a, b) => (a.rank - b.rank) || (b.wins - a.wins) || (b.points - a.points));
  const wins = res.filter((r) => r.win);
  const losses = res.filter((r) => !r.win);
  const bestWin = [...wins].sort((a, b) => (b.my - b.opp) - (a.my - a.opp))[0];
  const worstLoss = [...losses].sort((a, b) => (b.opp - b.my) - (a.opp - a.my))[0];
  return {
    res, partners, opponents, nights, best: nightOrder[0], worst: nightOrder.length > 1 ? nightOrder[nightOrder.length - 1] : null,
    bestWin, worstLoss, sk: streaks(res),
    played: res.length, wins: wins.length, points: res.reduce((s, r) => s + r.my, 0),
    nightsWon: nights.filter((n) => n.rank === 1).length,
  };
}

function renderPlayerSheet() {
  const p = sheet.name;
  const { all, nightRows, elo } = computeStats();
  const pr = playerProfile(p, all, nightRows, elo);
  const lb = luckBalance(all, elo.probs)[p];
  const rating = Math.round(elo.total[p]);
  const eloRank = elo.ranked.indexOf(p) + 1;
  const lastNight = pr.nights[pr.nights.length - 1];
  el.sheetTitle.textContent = p;
  el.sheetSub.textContent = `${eloRank}. místo v ELO · ${nZap(pr.played)}`;
  const nightTile = (n, label) => n ? `<button type="button" class="nt" data-session="${n.s.id}">
      <div class="l">${label}</div><div class="d">${fmtShort(n.s.played_on)}</div>
      <div class="v">${n.rank}. místo</div><div class="d">${n.wins} V · ${n.points} b · ELO ${signed(n.delta)}</div></button>` : '';
  const matchLine = (r, label) => r ? `<div class="rec"><div><div class="l">${label}</div>
      <div class="d">s ${r.partner} vs ${r.opps[0]} & ${r.opps[1]} · ${fmtShort(sessionById(r.m.session_id).played_on)}</div></div>
      <div class="v">${r.my}:${r.opp}</div></div>` : '';
  const nemesis = pr.opponents[pr.opponents.length - 1];
  const victim = pr.opponents[0];

  el.sheetBody.innerHTML = `
    <div class="card p-hero" style="--c:${COLORS[p]}">
      ${av(p, 104, 'big')}
      <div class="p-hero-txt">
        <div class="p-elo-lbl">ELO rating</div>
        <div class="p-elo">${rating}</div>
        <div class="p-elo-sub">${eloRank}. ze 4 ${lastNight ? `· poslední večer <b class="${lastNight.delta >= 0 ? 'up' : 'down'}">${signed(lastNight.delta)}</b>` : ''}</div>
      </div>
    </div>

    <div class="kpis kpis-3">
      <div class="kpi"><div class="kpi-val">${pr.wins}–${pr.played - pr.wins}</div><div class="kpi-lbl">výhry–prohry</div></div>
      <div class="kpi accent"><div class="kpi-val">${pct(pr.wins, pr.played)} %</div><div class="kpi-lbl">úspěšnost</div></div>
      <div class="kpi"><div class="kpi-val">${pr.played ? dec(pr.points / pr.played) : '–'}</div><div class="kpi-lbl">Ø bodů / zápas</div></div>
      <div class="kpi"><div class="kpi-val">${pr.nightsWon}</div><div class="kpi-lbl">👑 vyhrané večery</div></div>
      <div class="kpi"><div class="kpi-val">${pr.sk.cur}×</div><div class="kpi-lbl">${pr.sk.curWin === false ? 'aktuální série proher' : 'aktuální série výher 🔥'}</div></div>
      <div class="kpi"><div class="kpi-val">${pr.sk.longest}</div><div class="kpi-lbl">nejdelší série výher</div></div>
    </div>
    <div class="kpis kpis-3 kpis-2">
      <div class="kpi"><div class="kpi-val ${upDown(lb.luck)}">${sdec(lb.luck)}</div><div class="kpi-lbl">🍀 štěstí · výhry nad očekávání ELO</div></div>
      <div class="kpi"><div class="kpi-val ${upDown(lb.bal)}">${signed(lb.bal)}</div><div class="kpi-lbl">⚖️ bilance · míčky získané − ztracené</div></div>
    </div>

    <div class="card">
      <div class="card-title"><span>Složení ELO</span><span class="muted small">zápasy + bonusy</span></div>
      <div class="elo-split"><div><b>${Math.round(elo.rating[p])}</b><span>ze zápasů</span></div><i>+</i>
        <div><b class="up">${fmtBonus(Math.round(bonusSum(elo.bonus[p]) * 10) / 10)}</b><span>bonusy</span></div><i>=</i>
        <div><b>${rating}</b><span>ELO</span></div></div>
      <div class="bonus-chips mt">${bonusChips(elo.bonus[p]) || '<span class="muted small">Zatím žádné bonusy.</span>'}</div>
    </div>

    <div class="card">
      <div class="card-title"><span>Vývoj ELO</span><span class="muted small">po každém zápase</span></div>
      <div class="chart-box"><canvas id="chartProfile" role="img" aria-label="Vývoj ELO hráče ${p}"></canvas></div>
    </div>

    <div class="card">
      <div class="card-title"><span>Forma</span><span class="muted small">posledních 10</span></div>
      ${formDots(pr.res.slice(-10))}
    </div>

    <div class="card">
      <div class="card-title"><span>Parťáci</span><span class="muted small">když hraje s…</span></div>
      <div class="bars">${pr.partners.map((x, i) => `<button type="button" class="bar-row tap" data-player="${SLUG[x.q]}"><div>
          <div class="lbl">${av(x.q, 22)}${x.q} ${i === 0 && x.n ? '<span class="tag ball">🤝 Nejlepší parťák</span>' : ''}</div>
          <div class="bar-track"><div class="bar-fill ${i === 0 ? 'ball' : ''}" style="width:${Math.round(x.rate * 100)}%"></div></div>
          <div class="sub">${nZap(x.n)} · Ø ${dec(x.avgPts)} b</div></div>
        <div class="val">${Math.round(x.rate * 100)} %<div class="sub">${x.w} z ${x.n}</div></div></button>`).join('')}</div>
    </div>

    <div class="card">
      <div class="card-title"><span>Soupeři</span><span class="muted small">když hraje proti…</span></div>
      <div class="bars">${pr.opponents.map((x) => `<button type="button" class="bar-row tap" data-player="${SLUG[x.q]}"><div>
          <div class="lbl">${av(x.q, 22)}${x.q}
            ${x === victim && x.n ? '<span class="tag ball">🎯 Oblíbená oběť</span>' : ''}${x === nemesis && x !== victim && x.n ? '<span class="tag red">😈 Nemesis</span>' : ''}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(x.rate * 100)}%"></div></div></div>
        <div class="val">${x.w}–${x.l}<div class="sub">${Math.round(x.rate * 100)} % výher</div></div></button>`).join('')}</div>
    </div>

    <div class="nt-grid">${nightTile(pr.best, '🌟 Nejlepší večer')}${nightTile(pr.worst, '🥶 Nejhorší večer')}</div>

    <div class="card">
      <div class="card-title"><span>Zápasy na hraně</span></div>
      <div class="records">${matchLine(pr.bestWin, '💪 Nejvyšší výhra')}${matchLine(pr.worstLoss, '🙈 Nejtěžší porážka')}</div>
    </div>

    <div class="card">
      <div class="card-title"><span>Všechny večery</span><span class="muted small">klepni pro detail</span></div>
      <div class="night-list">${[...pr.nights].reverse().map((n) => `<button type="button" class="night-row" data-session="${n.s.id}">
        <span class="rank ${n.rank <= 3 ? 'r' + n.rank : ''}">${n.rank}</span>
        <span class="nd">${fmtLong(n.s.played_on)}</span>
        <span class="nv">${n.wins} V · ${n.points} b</span>
        <span class="delta ${n.delta >= 0 ? 'up' : 'down'}">${signed(n.delta)}</span></button>`).join('') || '<p class="empty">Zatím žádný večer.</p>'}</div>
    </div>`;

  renderProfileChart(p, all, elo);
}

/* ============ GRAFY ============ */
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const items = [];
    chart.data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden || !meta.data.length || ds._noLabel) return;
      const pt = meta.data[meta.data.length - 1];
      items.push({ y: pt.y, x: pt.x, text: ds.endLabel || ds.label });
    });
    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < 14) items[i].y = items[i - 1].y + 14;
    ctx.save();
    ctx.font = '600 11.5px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    items.forEach((it) => { ctx.fillStyle = '#cfdcec'; ctx.fillText(it.text, it.x + 7, it.y); });
    ctx.restore();
  },
};
const baseline1000 = {
  id: 'baseline1000',
  beforeDatasetsDraw(chart) {
    const y = chart.scales.y.getPixelForValue(ELO_START);
    const { left, right } = chart.chartArea;
    const { ctx } = chart;
    ctx.save();
    ctx.strokeStyle = 'rgba(169,187,210,.35)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = 'rgba(169,187,210,.7)'; ctx.font = '500 10px Inter, sans-serif';
    ctx.fillText('start 1000', left + 4, y - 6);
    ctx.restore();
  },
};

function chartBase() {
  Chart.defaults.color = '#a9bbd2';
  Chart.defaults.font.family = 'Inter, sans-serif';
  Chart.defaults.font.size = 11;
  return {
    xTicks: { maxTicksLimit: window.innerWidth < 380 ? 3 : 5, maxRotation: 0, autoSkip: true, autoSkipPadding: 14 },
    grid: { color: 'rgba(125,180,255,.08)', drawTicks: false },
    tooltip: {
      backgroundColor: '#10243f', borderColor: 'rgba(125,180,255,.28)', borderWidth: 1, padding: 10,
      titleColor: '#eef4fb', bodyColor: '#cfdcec', usePointStyle: true, boxPadding: 4,
    },
  };
}
function legendHtml() { return PLAYERS.map((p) => `<span><i style="background:${COLORS[p]}"></i>${p}</span>`).join(''); }
function matchLabels(all) { return ['Start', ...all.map((m) => `${fmtShort(sessionById(m.session_id).played_on)} #${m.match_no}`)]; }

function renderCharts(all, nightRows) {
  if (typeof Chart === 'undefined') return;
  const { grid, tooltip, xTicks } = chartBase();
  el.legendWins.innerHTML = legendHtml();
  el.legendNights.innerHTML = legendHtml();

  // Kumulativní výhry (plná čára) a body (čárkovaná) – dva zarovnané panely se společnou osou X,
  // stejné barvy a jména; klepnutí v jednom panelu ukáže stejný okamžik i ve druhém.
  const cumW = Object.fromEntries(PLAYERS.map((p) => [p, [0]]));
  const cumP = Object.fromEntries(PLAYERS.map((p) => [p, [0]]));
  all.forEach((m) => {
    const aWon = m.score_a > m.score_b;
    PLAYERS.forEach((p) => {
      const inA = m.team_a.includes(p); const inB = m.team_b.includes(p);
      const won = (aWon && inA) || (!aWon && inB);
      cumW[p].push(cumW[p][cumW[p].length - 1] + (won ? 1 : 0));
      cumP[p].push(cumP[p][cumP[p].length - 1] + (inA ? m.score_a : inB ? m.score_b : 0));
    });
  });
  const labels = matchLabels(all);
  const both = (i, p) => `${p}: ${cumW[p][i]} V · ${cumP[p][i]} b`;
  const syncLine = {
    id: 'syncLine',
    afterDatasetsDraw(chart) {
      const i = chart.$syncIdx;
      if (i == null) return;
      const meta = chart.getDatasetMeta(0); const pt = meta.data[i];
      if (!pt) return;
      const { top, bottom } = chart.chartArea; const { ctx } = chart;
      ctx.save(); ctx.strokeStyle = 'rgba(207,220,236,.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pt.x, top); ctx.lineTo(pt.x, bottom); ctx.stroke(); ctx.restore();
    },
  };
  const panel = (canvas, cum, dash, showX) => new Chart($(canvas), {
    type: 'line',
    data: {
      labels,
      datasets: PLAYERS.map((p) => ({
        label: p, data: cum[p], borderColor: COLORS[p], backgroundColor: COLORS[p], borderWidth: 2, borderDash: dash,
        pointRadius: 0, pointHoverRadius: 5, pointHoverBorderColor: '#0b1a30', pointHoverBorderWidth: 2, tension: 0.25,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      layout: { padding: { right: 58, top: 4 } },
      interaction: { mode: 'index', intersect: false },
      onHover: (e, act, chart) => syncCharts(chart, act.length ? act[0].index : null),
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltip, itemSort: (a, b) => cumP[b.dataset.label][b.dataIndex] - cumP[a.dataset.label][a.dataIndex],
          callbacks: { label: (c) => both(c.dataIndex, c.dataset.label) },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { ...xTicks, display: showX } },
        // pevná šířka osy Y → oba panely mají graf přesně pod sebou
        y: { beginAtZero: true, grid, border: { display: false }, ticks: { precision: 0, padding: 6 }, afterFit: (sc) => { sc.width = 40; } },
      },
    },
    plugins: [endLabels, syncLine],
  });
  charts.wins && charts.wins.destroy();
  charts.points && charts.points.destroy();
  charts.wins = panel('chartWins', cumW, [], false);
  charts.points = panel('chartPoints', cumP, [6, 4], true);
  const pair = [charts.wins, charts.points];
  function syncCharts(src, idx) {
    pair.forEach((ch) => {
      if (ch.$syncIdx === idx) return;
      ch.$syncIdx = idx;
      if (ch !== src) {
        ch.setActiveElements(idx == null ? [] : PLAYERS.map((_, d) => ({ datasetIndex: d, index: idx })));
        ch.tooltip.setActiveElements([], { x: 0, y: 0 });
      }
      ch.update('none');
    });
  }
  pair.forEach((ch) => ch.canvas.addEventListener('mouseleave', () => syncCharts(null, null)));

  charts.nights && charts.nights.destroy();
  charts.nights = new Chart($('chartNights'), {
    type: 'line',
    data: {
      labels: nightRows.map(({ s }) => fmtShort(s.played_on)),
      datasets: PLAYERS.map((p) => ({
        label: p, data: nightRows.map(({ st }) => st.find((r) => r.name === p).points),
        borderColor: COLORS[p], backgroundColor: COLORS[p], borderWidth: 2, pointRadius: 4, pointHoverRadius: 6,
        pointBorderColor: '#0b1a30', pointBorderWidth: 2, tension: 0.2,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      layout: { padding: { right: 58, left: 4 } },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { ...tooltip, itemSort: (a, b) => b.raw - a.raw } },
      scales: {
        x: { grid: { display: false }, offset: true },
        y: { grid, border: { display: false }, ticks: { precision: 0, padding: 6 }, grace: '10%' },
      },
    },
    plugins: [endLabels],
  });
}

function renderProfileChart(p, all, elo) {
  if (typeof Chart === 'undefined') return;
  const { grid, tooltip, xTicks } = chartBase();
  const data = elo.hist[p].map((v) => Math.round(v));
  charts.profile && charts.profile.destroy();
  charts.profile = new Chart($('chartProfile'), {
    type: 'line',
    data: {
      labels: matchLabels(all),
      datasets: [{
        label: 'ELO', endLabel: String(data[data.length - 1]), data, borderColor: COLORS[p], borderWidth: 2,
        pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: COLORS[p], pointHoverBorderColor: '#0b1a30', pointHoverBorderWidth: 2,
        tension: 0.25, fill: true,
        backgroundColor: (ctx) => {
          const { chartArea, ctx: c } = ctx.chart;
          if (!chartArea) return 'transparent';
          const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0, COLORS[p] + '55'); g.addColorStop(1, COLORS[p] + '00');
          return g;
        },
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { padding: { right: 40 } },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { ...tooltip, displayColors: false } },
      scales: {
        x: { grid: { display: false }, ticks: xTicks },
        y: { grid, border: { display: false }, ticks: { precision: 0, padding: 6 }, grace: '8%' },
      },
    },
    plugins: [endLabels, baseline1000],
  });
}

/* ============ SDÍLENÍ (Messenger, WhatsApp…) ============ */
const AV_IMG = {};
function preloadAvatars() { PLAYERS.forEach((p) => { const i = new Image(); i.src = avatarUrl(p); AV_IMG[p] = i; }); }

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawAvatar(ctx, p, cx, cy, r, ring, ringColor) {
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = COLORS[p]; ctx.fill(); ctx.clip();
  const img = AV_IMG[p];
  if (img && img.complete && img.naturalWidth) ctx.drawImage(img, cx - r, cy - r, 2 * r, 2 * r);
  else { ctx.fillStyle = '#fff'; ctx.font = `800 ${r}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p[0], cx, cy); }
  ctx.restore();
  ctx.beginPath(); ctx.arc(cx, cy, r + ring / 2, 0, Math.PI * 2);
  ctx.strokeStyle = ringColor || COLORS[p]; ctx.lineWidth = ring; ctx.stroke();
}

function drawShareImage(sid) {
  const s = sessionById(sid);
  const ms = matchesOf(sid).filter((m) => !m._pending);
  const st = standings(ms);
  const elo = computeElo(chronoMatches().filter((m) => !m._pending));
  const deltas = elo.perSession[sid] || {};
  const W = 1080; const H = 1350;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const BC = '"Barlow Condensed", Inter, sans-serif';
  const LIME = '#d4f53c';

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#14468a'); bg.addColorStop(0.42, '#0b1f3c'); bg.addColorStop(1, '#06111f');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 3;
  rr(ctx, 36, 36, W - 72, H - 72, 30); ctx.stroke();
  ctx.setLineDash([14, 12]); ctx.beginPath(); ctx.moveTo(36, 700); ctx.lineTo(W - 36, 700); ctx.stroke(); ctx.setLineDash([]);

  // hlavička
  ctx.fillStyle = LIME; ctx.beginPath(); ctx.arc(108, 112, 38, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#0b1a30'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(72, 112, 30, -0.9, 0.9); ctx.stroke();
  ctx.beginPath(); ctx.arc(144, 112, 30, Math.PI - 0.9, Math.PI + 0.9); ctx.stroke();
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.font = `italic 900 72px ${BC}`; ctx.fillStyle = '#fff'; ctx.fillText('HOT', 164, 138);
  const hw = ctx.measureText('HOT').width; ctx.fillStyle = LIME; ctx.fillText('PADEL', 164 + hw, 138);
  ctx.textAlign = 'right'; ctx.fillStyle = '#eef4fb'; ctx.font = `800 40px ${BC}`;
  const dl = fmtLong(s.played_on); ctx.fillText(dl.charAt(0).toUpperCase() + dl.slice(1), W - 72, 106);
  ctx.fillStyle = '#a9bbd2'; ctx.font = '500 26px Inter, sans-serif';
  ctx.fillText(`${nZap(ms.length)} · ${ms.length * TOTAL} míčků`, W - 72, 146);

  // vítěz
  const win = st[0];
  ctx.textAlign = 'center'; ctx.fillStyle = LIME; ctx.font = '800 30px Inter, sans-serif';
  ctx.fillText('🏆  VÍTĚZ VEČERA', W / 2, 250);
  ctx.save(); ctx.shadowColor = 'rgba(212,245,60,.55)'; ctx.shadowBlur = 50;
  ctx.beginPath(); ctx.arc(W / 2, 420, 132, 0, Math.PI * 2); ctx.fillStyle = 'rgba(212,245,60,.25)'; ctx.fill(); ctx.restore();
  drawAvatar(ctx, win.name, W / 2, 420, 124, 10, LIME);
  ctx.save(); ctx.translate(W / 2 + 108, 312); ctx.rotate(0.35); ctx.font = '84px sans-serif'; ctx.fillText('👑', 0, 0); ctx.restore();
  ctx.fillStyle = '#fff'; ctx.font = `italic 900 104px ${BC}`; ctx.fillText(win.name.toUpperCase(), W / 2, 640);
  ctx.fillStyle = '#cfdcec'; ctx.font = '600 32px Inter, sans-serif';
  ctx.fillText(`${win.points} bodů · ${win.wins} výher · ELO ${Math.round(elo.total[win.name])} (${signed(deltas[win.name] || 0)})`, W / 2, 690);

  // tabulka
  const colV = 700; const colB = 850; const colE = 1005;
  ctx.font = '700 22px Inter, sans-serif'; ctx.fillStyle = '#6f86a3'; ctx.textAlign = 'right';
  ctx.fillText('BODY', colV, 752); ctx.fillText('VÝHRY', colB, 752); ctx.fillText('ELO', colE, 752);
  const rankBg = [LIME, 'rgba(143,196,255,.25)', 'rgba(245,177,61,.25)', 'rgba(255,255,255,.08)'];
  const rankFg = ['#0b1a30', '#bfe0ff', '#f5b13d', '#a9bbd2'];
  st.forEach((r, i) => {
    const y = 772 + i * 104;
    rr(ctx, 64, y, W - 128, 90, 22); ctx.fillStyle = i === 0 ? 'rgba(212,245,60,.10)' : 'rgba(255,255,255,.05)'; ctx.fill();
    ctx.beginPath(); ctx.arc(116, y + 45, 24, 0, Math.PI * 2); ctx.fillStyle = rankBg[i]; ctx.fill();
    ctx.fillStyle = rankFg[i]; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '800 26px Inter, sans-serif'; ctx.fillText(String(i + 1), 116, y + 46);
    drawAvatar(ctx, r.name, 196, y + 45, 32, 4);
    ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = '800 40px Inter, sans-serif'; ctx.fillText(r.name, 244, y + 47);
    ctx.textAlign = 'right';
    ctx.fillStyle = LIME; ctx.font = `italic 900 54px ${BC}`; ctx.fillText(String(r.points), colV, y + 47);
    ctx.fillStyle = '#fff'; ctx.font = `800 48px ${BC}`; ctx.fillText(String(r.wins), colB, y + 47);
    const d = deltas[r.name] || 0;
    ctx.fillStyle = d >= 0 ? LIME : '#ff9aa2'; ctx.font = '700 30px Inter, sans-serif'; ctx.fillText(signed(d), colE, y + 47);
    ctx.textBaseline = 'alphabetic';
  });

  // zajímavosti
  if (ms.length) {
    const big = [...ms].sort((x, y) => Math.abs(y.score_a - y.score_b) - Math.abs(x.score_a - x.score_b))[0];
    const bw = big.score_a > big.score_b ? big.team_a : big.team_b;
    const close = ms.filter((m) => Math.abs(m.score_a - m.score_b) === 1).length;
    ctx.textAlign = 'center'; ctx.fillStyle = '#a9bbd2'; ctx.font = '500 27px Inter, sans-serif';
    ctx.fillText(`Největší výhra ${Math.max(big.score_a, big.score_b)}:${Math.min(big.score_a, big.score_b)} (${bw[0]} & ${bw[1]}) · těsných 11:10: ${close}×`, W / 2, 1222);
  }
  ctx.fillStyle = '#6f86a3'; ctx.font = '600 24px Inter, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(SITE_URL.replace('https://', '').replace(/\/$/, ''), W / 2, 1282);
  return cv;
}

function shareText(sid) {
  const s = sessionById(sid);
  const st = standings(matchesOf(sid).filter((m) => !m._pending));
  const medal = ['🏆', '🥈', '🥉', '4.'];
  return `🎾 HotPadel – ${fmtLong(s.played_on)}\n` +
    st.map((r, i) => `${medal[i]} ${r.name} – ${r.points} b, ${r.wins} V`).join('\n') +
    `\n${SITE_URL}#vecer-${sid}`;
}
function dataUrlToFile(dataUrl, name) {
  const [head, b64] = dataUrl.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}

async function openSharePreview(sid) {
  try { await Promise.all([document.fonts.load(`italic 900 72px "Barlow Condensed"`), document.fonts.load(`800 40px "Barlow Condensed"`), document.fonts.load('800 40px Inter')]); } catch (e) { /* nevadí */ }
  await Promise.all(PLAYERS.map((p) => (AV_IMG[p].complete ? null : new Promise((r) => { AV_IMG[p].onload = r; AV_IMG[p].onerror = r; }))));
  const cv = drawShareImage(sid);
  const dataUrl = cv.toDataURL('image/jpeg', 0.9);
  const s = sessionById(sid);
  const fileName = `hotpadel-${s.played_on}.jpg`;
  const file = dataUrlToFile(dataUrl, fileName);
  const text = shareText(sid);
  const canFiles = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  openModal(`<h3>Sdílet výsledky</h3>
    <img class="share-preview" src="${dataUrl}" alt="Náhled obrázku s výsledky večera">
    <button class="btn pri wide" id="sGo">📤 ${canFiles ? 'Sdílet do skupiny' : 'Sdílet odkaz'}</button>
    <div class="modal-actions mt"><button class="btn sec" id="sDl">⬇️ Uložit obrázek</button><button class="btn sec" id="sClose">Zavřít</button></div>
    <p class="small muted mt">V nabídce sdílení vyber <b>Messenger</b> a pak naši skupinu.</p>`, (c) => {
    c.querySelector('#sGo').onclick = () => {
      // navigator.share musí běžet přímo v kliknutí (bez await před ním)
      if (canFiles) {
        navigator.share({ files: [file], text, title: 'HotPadel' }).catch((e) => { if (e.name !== 'AbortError') toast('Sdílení se nepovedlo – ulož obrázek.', true); });
      } else if (navigator.share) {
        navigator.share({ title: 'HotPadel', text, url: `${SITE_URL}#vecer-${sid}` }).catch(() => {});
      } else {
        try { navigator.clipboard.writeText(text); toast('Text zkopírován – vlož ho do Messengeru'); } catch (e) { toast('Sdílení tady nejde – ulož obrázek.', true); }
      }
    };
    c.querySelector('#sDl').onclick = () => {
      const a = document.createElement('a'); a.href = dataUrl; a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
    };
    c.querySelector('#sClose').onclick = closeModal;
  });
}

/* ============ EXPORT ============ */
function exportJson() {
  const data = { exported_at: new Date().toISOString(), sessions: server.sessions, matches: server.matches, unsent: outbox };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hotpadel-zaloha-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ============ ROUTING / RENDER ============ */
/** Otisk dat – překreslujeme statistiky jen když se něco opravdu změnilo. */
function dataSig() {
  let h = 7;
  for (const m of server.matches) h = (Math.imul(h, 31) + m.id * 7 + m.score_a * 131 + m.match_no * 3 + m.session_id) | 0;
  for (const s of server.sessions) h = (Math.imul(h, 31) + s.id * 17 + (s.finished ? 1 : 2)) | 0;
  return [h, server.matches.length, server.sessions.length, outbox.length, state.loaded].join('/');
}
/** Navigace uvnitř aplikace (tlačítko ← pak vrací zpět v aplikaci, ne ven z ní). */
function navigate(hash) { history.pushState({ inApp: true }, '', hash); route(); }
let lastRouted = null;
function route() {
  const h = decodeURIComponent((location.hash || '#hrat').slice(1));
  lastRouted = location.hash;
  let view = h;
  sheet = null;
  if (h.startsWith('vecer-')) { view = 'historie'; sheet = { kind: 'session', id: h.slice(6) }; }
  else if (h.startsWith('hrac-')) { const p = playerBySlug(h.slice(5)); view = 'statistiky'; if (p) sheet = { kind: 'player', name: p }; }
  if (sheet) {
    el.sheet.classList.remove('hidden');
    el.sheet.scrollTop = 0;
    document.body.style.overflow = 'hidden';
  } else {
    el.sheet.classList.add('hidden');
    document.body.style.overflow = '';
  }
  if (!['hrat', 'historie', 'statistiky'].includes(view)) view = 'hrat';
  const changedView = view !== currentView;
  currentView = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== view));
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === view));
  lastStatsSig = ''; lastSheetSig = '';
  renderAll();
  if (!sheet && changedView) window.scrollTo(0, 0);
}
function closeSheet() {
  const base = sheet && sheet.kind === 'player' ? '#statistiky' : '#historie';
  history.replaceState(null, '', base);
  route();
}

function renderAll() {
  renderPlay();
  const sig = dataSig();
  if (currentView === 'historie') renderHistory();
  if (currentView === 'statistiky' && sig !== lastStatsSig) { renderStats(); lastStatsSig = sig; }
  if (sheet) {
    const key = `${sig}|${sheet.kind}|${sheet.id || sheet.name}`;
    if (key !== lastSheetSig) {
      lastSheetSig = key;
      if (sheet.kind === 'session') renderSessionSheet();
      else renderPlayerSheet();
    }
  }
}

/* ============ UDÁLOSTI ============ */
el.quickGrid.innerHTML = QUICK.map(([a, b]) => `<button type="button" data-a="${a}" data-b="${b}">${a}:${b}</button>`).join('');
el.quickGrid.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setScores(+b.dataset.a, +b.dataset.b); });
document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => adjustScore(b.dataset.team, +b.dataset.d)));
el.scoreA.addEventListener('input', () => handleScoreInput('A'));
el.scoreB.addEventListener('input', () => handleScoreInput('B'));
[el.scoreA, el.scoreB].forEach((i) => {
  i.addEventListener('focus', () => i.select());
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.confirmBtn.disabled) { e.preventDefault(); i.blur(); confirmMatch(); } });
});
el.confirmBtn.addEventListener('click', confirmMatch);
el.undoBtn.addEventListener('click', undoLast);
el.finishBtn.addEventListener('click', finishSession);
el.outboxBanner.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ob]');
  if (!b) return;
  if (b.dataset.ob === 'retry') { outbox.forEach((o) => { delete o.failed; }); saveOutbox(); refresh(); flushOutbox(); }
  else {
    confirmModal({ title: 'Zahodit neuložené zápasy?', text: 'Zápasy, které se nepodařilo uložit, se z telefonu smažou.', ok: 'Zahodit', danger: true })
      .then((ok) => {
        if (!ok) return;
        const dropRefs = outbox.filter((o) => o.failed && o.kind === 'session').map((o) => o.ref);
        outbox = outbox.filter((o) => !o.failed && !dropRefs.includes(o.session_id));
        saveOutbox(); refresh();
      });
  }
});
document.addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) { openEditMatch(edit.dataset.edit); return; }
  const pl = e.target.closest('[data-player]');
  if (pl) { navigate(`#hrac-${pl.dataset.player}`); return; }
  const s = e.target.closest('[data-session]');
  if (s) navigate(`#vecer-${s.dataset.session}`);
});
// ← zpět: v rámci aplikace krok zpět; když přišel odkaz zvenku (Messenger), jen zavřít detail
$('sheetClose').addEventListener('click', () => { if (history.state && history.state.inApp) history.back(); else closeSheet(); });
$('exportBtn').addEventListener('click', exportJson);
window.addEventListener('hashchange', () => { if (location.hash !== lastRouted) route(); });
window.addEventListener('popstate', () => { if (location.hash !== lastRouted) route(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { scheduleReload(); flushOutbox(); } });
window.addEventListener('online', () => { online = true; updateSyncChip(); flushOutbox(); scheduleReload(); });
window.addEventListener('offline', () => { online = false; updateSyncChip(); });
setInterval(() => { if (!document.hidden) loadAll(); }, 30000);
setInterval(() => { if (outbox.some((o) => !o.failed)) flushOutbox(); }, 5000);

db.channel('hotpadel-live')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, scheduleReload)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, scheduleReload)
  .subscribe();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

/* ============ START ============ */
// 1) okamžitě zobrazit poslední známá data z telefonu (funguje i bez signálu)
const cached = lsGet(CACHE_KEY, null);
if (cached && Array.isArray(cached.sessions)) {
  server.sessions = cached.sessions; server.matches = cached.matches || []; state.loaded = true;
}
outbox = lsGet(OUTBOX_KEY, []);
if (!Array.isArray(outbox)) outbox = [];
preloadAvatars();
rebuildState();
route();
updateSyncChip();
// 2) načíst čerstvá data a odeslat, co čeká
loadAll();
