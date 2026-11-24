/* HotPadel – týdenní Americano (4 hráči, 21 míčků) */
'use strict';

/* ============ KONFIGURACE ============ */
const SUPABASE_URL = 'https://jrbaxjtpatskvcdqvjnb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_TcHGhvjBw-FBgatur5ZS3A_VO4kziJq';
const TOTAL = 21;
const STALE_HOURS = 10; // rozehraný večer bez aktivity déle než 10 h se automaticky ukončí
const PLAYERS = ['Honza', 'Martin', 'Pepa', 'Matouš'];
const COLORS = { Honza: '#b08a00', Martin: '#3987e5', Pepa: '#e0606a', 'Matouš': '#22a8a0' };
const ROTATIONS = [
  { teamA: ['Honza', 'Martin'], teamB: ['Pepa', 'Matouš'] },
  { teamA: ['Honza', 'Pepa'], teamB: ['Martin', 'Matouš'] },
  { teamA: ['Honza', 'Matouš'], teamB: ['Martin', 'Pepa'] },
];
const QUICK = [[11, 10], [12, 9], [13, 8], [14, 7], [10, 11], [9, 12], [8, 13], [7, 14]];

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ============ STAV ============ */
const state = { sessions: [], matches: [], loaded: false };
let pendingOps = 0;
let reloadDeferred = false;
let currentView = 'hrat';
let sheetSessionId = null;
const charts = {};

const $ = (id) => document.getElementById(id);
const el = {
  syncChip: $('syncChip'), sessionDate: $('sessionDate'), sessionSub: $('sessionSub'), liveBadge: $('liveBadge'),
  tonightTable: $('tonightTable'), matchNo: $('matchNo'), rotationLabel: $('rotationLabel'),
  teamANames: $('teamANames'), teamBNames: $('teamBNames'), scoreA: $('scoreA'), scoreB: $('scoreB'),
  quickGrid: $('quickGrid'), validationMsg: $('validationMsg'), confirmBtn: $('confirmBtn'),
  undoBtn: $('undoBtn'), finishBtn: $('finishBtn'), tonightCount: $('tonightCount'), tonightMatches: $('tonightMatches'),
  sessionList: $('sessionList'), kpis: $('kpis'), overallTable: $('overallTable'), formList: $('formList'),
  records: $('records'), pairs: $('pairs'), h2hTable: $('h2hTable'), scoreDist: $('scoreDist'),
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
function dot(p) { return `<span class="pdot" style="background:${COLORS[p] || '#888'}"></span>`; }
function plural(n, one, few, many) { return n === 1 ? one : (n >= 2 && n <= 4 ? few : many); }

function sessionById(id) { return state.sessions.find((s) => s.id === id); }
function matchesOf(sessionId) { return state.matches.filter((m) => m.session_id === sessionId).sort((a, b) => a.match_no - b.match_no); }
function openSession() { return state.sessions.filter((s) => !s.finished).sort((a, b) => b.id - a.id)[0] || null; }
function sortedSessions() {
  return [...state.sessions].sort((a, b) => (b.played_on.localeCompare(a.played_on)) || (b.id - a.id));
}
function nextMatchNo(ms) { return ms.length ? Math.max(...ms.map((m) => m.match_no)) + 1 : 1; }
function rotationFor(no) { return ROTATIONS[(no - 1) % ROTATIONS.length]; }
/** všechny zápasy chronologicky (večer → číslo zápasu) */
function chronoMatches() {
  const order = new Map([...state.sessions].sort((a, b) => a.played_on.localeCompare(b.played_on) || a.id - b.id).map((s, i) => [s.id, i]));
  return state.matches.filter((m) => order.has(m.session_id))
    .sort((a, b) => (order.get(a.session_id) - order.get(b.session_id)) || (a.match_no - b.match_no));
}

function standings(matches) {
  const st = {};
  PLAYERS.forEach((p) => { st[p] = { name: p, played: 0, wins: 0, points: 0 }; });
  matches.forEach((m) => {
    const aWon = m.score_a > m.score_b;
    m.team_a.forEach((p) => { if (!st[p]) return; st[p].played++; st[p].points += m.score_a; if (aWon) st[p].wins++; });
    m.team_b.forEach((p) => { if (!st[p]) return; st[p].played++; st[p].points += m.score_b; if (!aWon) st[p].wins++; });
  });
  return Object.values(st).sort((a, b) => (b.wins - a.wins) || (b.points - a.points) || (PLAYERS.indexOf(a.name) - PLAYERS.indexOf(b.name)));
}

function standingsTable(rows, { compact = true } = {}) {
  const any = rows.some((r) => r.played > 0);
  let html = `<thead><tr><th>#</th><th>Hráč</th><th>Z</th><th style="color:var(--win)">Výhry</th><th>Body</th></tr></thead><tbody>`;
  rows.forEach((r, i) => {
    const rank = i + 1;
    const cls = any && rank <= 3 ? `r${rank}` : '';
    html += `<tr class="${any && rank === 1 ? 'lead' : ''}">
      <td><span class="rank ${cls}">${rank}</span></td>
      <td class="name">${dot(r.name)}${r.name}</td>
      <td class="dim">${r.played}</td>
      <td class="w">${r.wins}</td>
      <td class="p">${r.points}</td></tr>`;
  });
  return html + '</tbody>';
}

function matchRow(m, { editable = false } = {}) {
  const aWon = m.score_a > m.score_b;
  const sc = aWon
    ? `<b>${m.score_a}</b><s>:</s><i>${m.score_b}</i>`
    : `<i>${m.score_a}</i><s>:</s><b>${m.score_b}</b>`;
  const tag = editable ? 'button' : 'div';
  return `<${tag} class="m-row ${editable ? 'editable' : ''} ${m._pending ? 'pending' : ''}" ${editable ? `type="button" data-edit="${m.id}"` : ''}>
    <span class="no">#${m.match_no}</span>
    <span class="teams-txt">
      <span class="t ${aWon ? 'win' : ''}">${m.team_a[0]} & ${m.team_a[1]}</span>
      <span class="t ${!aWon ? 'win' : ''}">${m.team_b[0]} & ${m.team_b[1]}</span>
    </span>
    <span class="sc">${sc}</span>
  </${tag}>`;
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
function setSync(s) {
  el.syncChip.classList.remove('ok', 'err');
  if (s === 'ok') { el.syncChip.classList.add('ok'); el.syncChip.querySelector('.txt').textContent = 'Online'; }
  else if (s === 'err') { el.syncChip.classList.add('err'); el.syncChip.querySelector('.txt').textContent = 'Offline'; }
  else el.syncChip.querySelector('.txt').textContent = 'Načítám…';
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

/* ============ NAČTENÍ DAT ============ */
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

async function loadAll() {
  if (pendingOps > 0) { reloadDeferred = true; return; }
  try {
    const [s, m] = await Promise.all([fetchAll('sessions'), fetchAll('matches')]);
    if (pendingOps > 0) { reloadDeferred = true; return; }
    state.sessions = s; state.matches = m; state.loaded = true;
    setSync('ok');
    await autoCloseStale();
  } catch (e) {
    console.error(e);
    setSync('err');
  }
  renderAll();
}
let reloadT;
function scheduleReload() { clearTimeout(reloadT); reloadT = setTimeout(loadAll, 250); }
function opDone() {
  pendingOps = Math.max(0, pendingOps - 1);
  if (pendingOps === 0 && reloadDeferred) { reloadDeferred = false; scheduleReload(); }
}

async function autoCloseStale() {
  const s = openSession();
  if (!s) return;
  const times = [s.created_at, ...matchesOf(s.id).map((m) => m.created_at)].map((t) => new Date(t).getTime());
  if (Date.now() - Math.max(...times) > STALE_HOURS * 3600e3) {
    s.finished = true;
    await db.from('sessions').update({ finished: true }).eq('id', s.id);
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
    el.sessionSub.textContent = ms.length
      ? `${ms.length} ${plural(ms.length, 'zápas', 'zápasy', 'zápasů')} · začátek ${fmtTime(ms[0].created_at)}`
      : 'Večer založen – zapiš první zápas';
    el.liveBadge.classList.remove('hidden');
  } else {
    el.sessionDate.textContent = fmtLong(todayISO());
    el.sessionSub.textContent = 'Nový večer se založí s dnešním datem prvním zapsaným zápasem';
    el.liveBadge.classList.add('hidden');
  }
  el.tonightTable.innerHTML = standingsTable(standings(ms));
  el.matchNo.textContent = no;
  el.rotationLabel.textContent = `Kombinace ${rotIdx + 1}/3`;
  el.teamANames.innerHTML = `${rot.teamA[0]}<span class="amp">&</span>${rot.teamA[1]}`;
  el.teamBNames.innerHTML = `${rot.teamB[0]}<span class="amp">&</span>${rot.teamB[1]}`;
  el.tonightCount.textContent = ms.length;
  el.tonightMatches.innerHTML = ms.length
    ? [...ms].reverse().map((m) => matchRow(m, { editable: !m._pending })).join('')
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
    el.validationMsg.textContent = `Vítězí ${winners[0]} & ${winners[1]} (${a}:${b})`;
    el.validationMsg.className = 'validation ok';
  } else {
    el.validationMsg.textContent = 'Součet míčků musí být přesně 21.';
    el.validationMsg.className = 'validation';
  }
  return ok;
}

async function ensureOpenSession() {
  let sess = openSession();
  if (sess) return sess;
  const { data, error } = await db.from('sessions').insert({ played_on: todayISO() }).select().single();
  if (!error) { state.sessions.push(data); return data; }
  if (error.code === '23505') { // někdo jiný mezitím založil večer
    const s = await fetchAll('sessions'); state.sessions = s;
    sess = openSession();
    if (sess) { state.matches = await fetchAll('matches'); return sess; }
  }
  throw error;
}

async function confirmMatch() {
  if (!validateScores()) return;
  const a = parseInt(el.scoreA.value, 10);
  const b = parseInt(el.scoreB.value, 10);
  el.confirmBtn.disabled = true;
  pendingOps++;
  let temp = null;
  try {
    const sess = await ensureOpenSession();
    const no = nextMatchNo(matchesOf(sess.id));
    const rot = rotationFor(no);
    const row = { session_id: sess.id, match_no: no, team_a: rot.teamA, team_b: rot.teamB, score_a: a, score_b: b };
    temp = { ...row, id: 'tmp' + Date.now(), created_at: new Date().toISOString(), _pending: true };
    state.matches.push(temp);
    clearScores();
    renderAll();
    toast(`Zápas #${no} uložen (${a}:${b})`);
    if (navigator.vibrate) navigator.vibrate([10, 40, 10]);
    const { data, error } = await db.from('matches').insert(row).select().single();
    state.matches = state.matches.filter((m) => m !== temp);
    if (error) {
      if (error.code === '23505') {
        toast(`Zápas #${no} už mezitím zapsal někdo jiný – zkontroluj výsledky.`, true);
        reloadDeferred = true;
      } else throw error;
      setScores(a, b);
    } else {
      state.matches.push(data);
    }
  } catch (e) {
    console.error(e);
    if (temp) state.matches = state.matches.filter((m) => m !== temp);
    setScores(a, b);
    toast('Nepodařilo se uložit – zkontroluj připojení a zkus znovu.', true);
    setSync('err');
  } finally {
    opDone();
    renderAll();
  }
}

async function undoLast() {
  const { ms } = currentPlay();
  const last = ms[ms.length - 1];
  if (!last || last._pending) return;
  pendingOps++;
  state.matches = state.matches.filter((m) => m !== last);
  renderAll();
  setScores(last.score_a, last.score_b);
  const { error } = await db.from('matches').delete().eq('id', last.id);
  if (error) { state.matches.push(last); clearScores(); toast('Vrácení se nepovedlo – zkus znovu.', true); }
  else toast(`Zápas #${last.match_no} vrácen k úpravě`);
  opDone();
  renderAll();
}

async function finishSession() {
  const sess = openSession();
  if (!sess) return;
  const ms = matchesOf(sess.id);
  const ok = await confirmModal({
    title: 'Ukončit večer?',
    text: ms.length ? `Večer se uloží do historie (${ms.length} ${plural(ms.length, 'zápas', 'zápasy', 'zápasů')}). Další zapsaný zápas založí nový večer.` : 'Večer nemá žádné zápasy – bude smazán.',
    ok: ms.length ? 'Ukončit' : 'Smazat',
    danger: !ms.length,
  });
  if (!ok) return;
  pendingOps++;
  const { error } = ms.length
    ? await db.from('sessions').update({ finished: true }).eq('id', sess.id)
    : await db.from('sessions').delete().eq('id', sess.id);
  if (error) toast('Nepovedlo se – zkus znovu.', true);
  else {
    if (ms.length) { sess.finished = true; toast(`🏆 Večer vyhrál ${standings(ms)[0].name}!`); }
    else state.sessions = state.sessions.filter((s) => s !== sess);
    clearScores();
  }
  opDone();
  renderAll();
}

/* ============ EDITACE ZÁPASU ============ */
function openEditMatch(id) {
  const m = state.matches.find((x) => String(x.id) === String(id));
  if (!m) return;
  openModal(`
    <h3>Upravit zápas #${m.match_no}</h3>
    <p>${fmtLong(sessionById(m.session_id).played_on)}</p>
    <div class="edit-scores">
      <div><div class="lbl">${m.team_a[0]} & ${m.team_a[1]}</div><input class="score-input" id="eA" type="number" inputmode="numeric" value="${m.score_a}"></div>
      <div class="muted" style="padding-top:18px;font-weight:800">:</div>
      <div><div class="lbl">${m.team_b[0]} & ${m.team_b[1]}</div><input class="score-input" id="eB" type="number" inputmode="numeric" value="${m.score_b}"></div>
    </div>
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
      closeModal();
      const { error } = await db.from('matches').update({ score_a: a, score_b: b }).eq('id', m.id);
      if (error) { toast('Uložení se nepovedlo.', true); return; }
      m.score_a = a; m.score_b = b; renderAll(); toast('Zápas upraven');
    };
    c.querySelector('#eDel').onclick = async () => {
      closeModal();
      if (!(await confirmModal({ title: `Smazat zápas #${m.match_no}?`, text: 'Zápas zmizí z výsledků i statistik.', ok: 'Smazat', danger: true }))) return;
      const { error } = await db.from('matches').delete().eq('id', m.id);
      if (error) { toast('Smazání se nepovedlo.', true); return; }
      state.matches = state.matches.filter((x) => x !== m); renderAll(); toast('Zápas smazán');
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
    const pts = ms.length * TOTAL;
    return `<button type="button" class="s-card" data-session="${s.id}">
      <div class="s-top">
        <div><div class="s-date">${fmtLong(s.played_on)}</div>
        <div class="s-meta">${ms.length} ${plural(ms.length, 'zápas', 'zápasy', 'zápasů')} · ${pts} míčků</div></div>
        ${!s.finished ? '<span class="s-open">LIVE</span>' : ''}
      </div>
      ${ms.length ? `<div class="podium">${st.map((r, i) => `<div class="${i === 0 ? 'first' : ''}"><div class="nm">${r.name}</div><div class="vl">${r.wins} V · ${r.points}</div></div>`).join('')}</div>` : ''}
    </button>`;
  }).join('');
}

function renderSheet() {
  if (sheetSessionId == null) return;
  const s = sessionById(sheetSessionId);
  if (!s) { if (state.loaded) closeSheet(); return; }
  const ms = matchesOf(s.id);
  const st = standings(ms);
  el.sheetTitle.textContent = fmtLong(s.played_on);
  el.sheetSub.textContent = `${ms.length} ${plural(ms.length, 'zápas', 'zápasy', 'zápasů')}${s.finished ? '' : ' · probíhá'}${ms.length ? ` · vítěz ${st[0].name} 🏆` : ''}`;
  const canReopen = s.finished && !openSession();
  el.sheetBody.innerHTML = `
    <div class="card"><div class="card-title"><span>Tabulka večera</span><span class="muted small">Výhry → Body</span></div>
      <table class="standings">${standingsTable(st)}</table></div>
    <div class="card"><div class="card-title"><span>Zápasy</span><span class="muted small">klepni pro úpravu</span></div>
      <div class="match-list">${ms.length ? ms.map((m) => matchRow(m, { editable: !m._pending })).join('') : '<p class="empty">Žádné zápasy.</p>'}</div></div>
    <div class="row-2">
      ${canReopen ? '<button type="button" class="btn-ghost ball" id="reopenBtn">Znovu otevřít</button>' : '<span></span>'}
      <button type="button" class="btn-ghost danger" id="deleteSessionBtn">Smazat večer</button>
    </div>`;
  const r = $('reopenBtn');
  if (r) r.onclick = async () => {
    const { error } = await db.from('sessions').update({ finished: false }).eq('id', s.id);
    if (error) { toast('Nejde otevřít (už běží jiný večer?)', true); return; }
    s.finished = false; toast('Večer znovu otevřen – pokračuj v záložce Hrát'); renderAll();
  };
  $('deleteSessionBtn').onclick = async () => {
    if (!(await confirmModal({ title: 'Smazat celý večer?', text: `${fmtLong(s.played_on)} – ${ms.length} ${plural(ms.length, 'zápas', 'zápasy', 'zápasů')} se nenávratně smaže (zůstane jen v denní záloze).`, ok: 'Smazat', danger: true }))) return;
    const { error } = await db.from('sessions').delete().eq('id', s.id);
    if (error) { toast('Smazání se nepovedlo.', true); return; }
    state.sessions = state.sessions.filter((x) => x !== s);
    state.matches = state.matches.filter((m) => m.session_id !== s.id);
    toast('Večer smazán'); closeSheet(); renderAll();
  };
}
function openSheet(id) { location.hash = `vecer-${id}`; }
function closeSheet() {
  sheetSessionId = null; el.sheet.classList.add('hidden');
  if (location.hash.startsWith('#vecer-')) history.replaceState(null, '', '#historie');
  document.body.style.overflow = '';
}

/* ============ STATISTIKY ============ */
function computeStats() {
  const all = chronoMatches().filter((m) => !m._pending);
  const sessions = [...state.sessions].filter((s) => matchesOf(s.id).length)
    .sort((a, b) => a.played_on.localeCompare(b.played_on) || a.id - b.id);
  const overall = standings(all);
  const nightsWon = Object.fromEntries(PLAYERS.map((p) => [p, 0]));
  const nightRows = sessions.map((s) => {
    const st = standings(matchesOf(s.id));
    nightsWon[st[0].name]++;
    return { s, st };
  });
  return { all, sessions, overall, nightsWon, nightRows };
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

function renderStats() {
  const { all, sessions, overall, nightsWon, nightRows } = computeStats();
  const close = all.filter((m) => Math.abs(m.score_a - m.score_b) === 1).length;
  el.kpis.innerHTML = [
    [sessions.length, plural(sessions.length, 'večer', 'večery', 'večerů'), true],
    [all.length, plural(all.length, 'zápas', 'zápasy', 'zápasů')],
    [all.length * TOTAL, 'odehraných míčků'],
    [close, 'těsných 11:10'],
  ].map(([v, l, acc]) => `<div class="kpi ${acc ? 'accent' : ''}"><div class="kpi-val">${v.toLocaleString('cs-CZ')}</div><div class="kpi-lbl">${l}</div></div>`).join('');

  if (!all.length) {
    el.overallTable.innerHTML = '<tbody><tr><td class="empty">Zatím žádná data.</td></tr></tbody>';
    [el.formList, el.records, el.pairs, el.h2hTable, el.scoreDist].forEach((x) => { x.innerHTML = '<p class="empty">Zatím žádná data.</p>'; });
    return;
  }

  // Celková tabulka
  const any = overall.some((r) => r.played);
  el.overallTable.innerHTML = `<thead><tr><th>#</th><th>Hráč</th><th>Z</th><th style="color:var(--win)">V</th><th>%</th><th>Body</th><th>Ø</th><th title="Vyhrané večery">👑</th></tr></thead><tbody>` +
    overall.map((r, i) => `<tr class="${any && i === 0 ? 'lead' : ''}">
      <td><span class="rank ${any && i < 3 ? 'r' + (i + 1) : ''}">${i + 1}</span></td>
      <td class="name">${dot(r.name)}${r.name}</td>
      <td class="dim">${r.played}</td>
      <td class="w">${r.wins}</td>
      <td class="dim">${r.played ? Math.round((r.wins / r.played) * 100) : 0}</td>
      <td class="p">${r.points}</td>
      <td class="dim">${r.played ? (r.points / r.played).toFixed(1).replace('.', ',') : '–'}</td>
      <td class="p">${nightsWon[r.name]}</td></tr>`).join('') + '</tbody>';

  // Forma
  const res = playerResults(all);
  el.formList.innerHTML = PLAYERS.map((p) => {
    const last = res[p].slice(-10);
    return `<div class="form-row"><span>${dot(p)}${p}</span><div class="form-dots">${last.map((r) => `<span class="${r.win ? 'W' : 'L'}" title="#${r.m.match_no} ${r.m.score_a}:${r.m.score_b}">${r.win ? 'V' : 'P'}</span>`).join('')}</div></div>`;
  }).join('') + '<p class="muted small" style="margin:2px 0 0">V = výhra, P = prohra · nejnovější vpravo</p>';

  // Rekordy
  const sessDate = (m) => fmtShort(sessionById(m.session_id).played_on);
  const big = [...all].sort((x, y) => Math.abs(y.score_a - y.score_b) - Math.abs(x.score_a - x.score_b))[0];
  const bigWinners = big.score_a > big.score_b ? big.team_a : big.team_b;
  let bestNightPts = null; let bestNightWins = null;
  nightRows.forEach(({ s, st }) => st.forEach((r) => {
    if (!bestNightPts || r.points > bestNightPts.v) bestNightPts = { v: r.points, p: r.name, d: s.played_on };
    if (!bestNightWins || r.wins > bestNightWins.v) bestNightWins = { v: r.wins, p: r.name, d: s.played_on };
  }));
  let longest = { v: 0, p: '' }; const current = {};
  PLAYERS.forEach((p) => {
    let run = 0;
    res[p].forEach((r) => { run = r.win ? run + 1 : 0; if (run > longest.v) longest = { v: run, p }; });
    let cur = 0; const lastWin = res[p].length ? res[p][res[p].length - 1].win : null;
    for (let i = res[p].length - 1; i >= 0 && res[p][i].win === lastWin; i--) cur++;
    current[p] = { cur, win: lastWin };
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
    ['Je ve formě 🔥', hot ? `${hot} – aktuální série` : 'nikdo nemá sérii', hot ? `${current[hot].cur}×` : '–'],
    ['Král těsných zápasů', `${clutchKing} – výhry o 1 míček`, clutch[clutchKing]],
  ];
  el.records.innerHTML = recs.map(([l, d, v]) => `<div class="rec"><div><div class="l">${l}</div><div class="d">${d}</div></div><div class="v">${v}</div></div>`).join('');

  // Dvojice
  const pairStats = ROTATIONS.flatMap((r) => [r.teamA, r.teamB]).map((pair) => {
    const key = [...pair].sort().join('|');
    let n = 0; let w = 0;
    all.forEach((m) => {
      if ([...m.team_a].sort().join('|') === key) { n++; if (m.score_a > m.score_b) w++; }
      if ([...m.team_b].sort().join('|') === key) { n++; if (m.score_b > m.score_a) w++; }
    });
    return { pair, n, w, pct: n ? w / n : 0 };
  }).sort((a, b) => (b.pct - a.pct) || (b.n - a.n));
  el.pairs.innerHTML = pairStats.map((s, i) => `<div class="bar-row"><div><div class="lbl">${s.pair[0]} & ${s.pair[1]}</div>
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
  el.h2hTable.innerHTML = `<thead><tr><th></th>${PLAYERS.map((q) => `<th>${q}</th>`).join('')}</tr></thead><tbody>` +
    PLAYERS.map((p) => `<tr><th class="rowh">${dot(p)}${p}</th>${PLAYERS.map((q) => {
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
    <div class="val">${v}× <div class="sub">${Math.round((v / all.length) * 100)} %</div></div></div>`).join('');

  renderCharts(all, nightRows);
}

/* ============ GRAFY ============ */
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const items = [];
    chart.data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden || !meta.data.length) return;
      const pt = meta.data[meta.data.length - 1];
      items.push({ y: pt.y, x: pt.x, text: ds.label, color: ds.borderColor });
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

function legendHtml() {
  return PLAYERS.map((p) => `<span><i style="background:${COLORS[p]}"></i>${p}</span>`).join('');
}

function renderCharts(all, nightRows) {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = '#a9bbd2';
  Chart.defaults.font.family = 'Inter, sans-serif';
  Chart.defaults.font.size = 11;
  const grid = { color: 'rgba(125,180,255,.08)', drawTicks: false };
  const tooltip = {
    backgroundColor: '#10243f', borderColor: 'rgba(125,180,255,.28)', borderWidth: 1, padding: 10,
    titleColor: '#eef4fb', bodyColor: '#cfdcec', usePointStyle: true, boxPadding: 4,
  };
  el.legendWins.innerHTML = legendHtml();
  el.legendNights.innerHTML = legendHtml();

  // Kumulativní výhry
  const cum = Object.fromEntries(PLAYERS.map((p) => [p, [0]]));
  all.forEach((m) => {
    const aWon = m.score_a > m.score_b;
    PLAYERS.forEach((p) => {
      const prev = cum[p][cum[p].length - 1];
      const won = (aWon && m.team_a.includes(p)) || (!aWon && m.team_b.includes(p));
      cum[p].push(prev + (won ? 1 : 0));
    });
  });
  const labels = ['Start', ...all.map((m) => `${fmtShort(sessionById(m.session_id).played_on)} #${m.match_no}`)];
  charts.wins && charts.wins.destroy();
  charts.wins = new Chart($('chartWins'), {
    type: 'line',
    data: { labels, datasets: PLAYERS.map((p) => ({ label: p, data: cum[p], borderColor: COLORS[p], backgroundColor: COLORS[p], borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderColor: '#0b1a30', pointHoverBorderWidth: 2, tension: 0.25, stepped: false })) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      layout: { padding: { right: 58 } },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { ...tooltip, itemSort: (a, b) => b.raw - a.raw } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkip: true } },
        y: { beginAtZero: true, grid, border: { display: false }, ticks: { precision: 0, padding: 6 } },
      },
    },
    plugins: [endLabels],
  });

  // Body za večer
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

/* ============ EXPORT ============ */
function exportJson() {
  const data = { exported_at: new Date().toISOString(), sessions: state.sessions, matches: state.matches.filter((m) => !m._pending) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hotpadel-zaloha-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ============ ROUTING / RENDER ============ */
function route() {
  const h = (location.hash || '#hrat').slice(1);
  let view = h;
  if (h.startsWith('vecer-')) {
    view = 'historie';
    sheetSessionId = Number(h.slice(6));
    el.sheet.classList.remove('hidden');
    el.sheet.scrollTop = 0;
    document.body.style.overflow = 'hidden';
  } else if (sheetSessionId != null) {
    sheetSessionId = null; el.sheet.classList.add('hidden'); document.body.style.overflow = '';
  }
  if (!['hrat', 'historie', 'statistiky'].includes(view)) view = 'hrat';
  currentView = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== view));
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === view));
  renderAll();
  if (!h.startsWith('vecer-')) window.scrollTo(0, 0);
}

function renderAll() {
  renderPlay();
  if (currentView === 'historie') renderHistory();
  if (currentView === 'statistiky') renderStats();
  renderSheet();
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
document.addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) { openEditMatch(edit.dataset.edit); return; }
  const s = e.target.closest('[data-session]');
  if (s) openSheet(s.dataset.session);
});
$('sheetClose').addEventListener('click', () => { if (history.length > 1 && location.hash.startsWith('#vecer-')) history.back(); else closeSheet(); });
$('exportBtn').addEventListener('click', exportJson);
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleReload(); });
window.addEventListener('online', scheduleReload);
window.addEventListener('offline', () => setSync('err'));
setInterval(() => { if (!document.hidden) loadAll(); }, 30000);

db.channel('hotpadel-live')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, scheduleReload)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, scheduleReload)
  .subscribe();

route();
loadAll();
