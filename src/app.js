/**
 * app.js — UI 렌더링
 */
import { ALL_STATIONS, lineById } from './graph.js';
import { planCommute } from './planner.js';
import { toHHMM, parseHHMM } from './schedule.js';
import { congestionLevel, SEAT_FULL } from './congestion.js';
import { TRANSFER_CARS_SOURCE } from './transfer-cars.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const pct = (v) => `${Math.round(v * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 환승 하차 위치 표기 — 후보가 둘이면 둘 다 보여 줍니다(진행 방향 구분 없는 데이터) */
const exitText = (t) => (t.ambiguous
  ? t.candidates.map((c) => `${c.car}-${c.door}`).join(' 또는 ')
  : `${t.exitCar}-${t.exitDoor}`);

const LEVEL_COLOR = {
  easy: 'var(--good)', ok: 'var(--ink-3)', busy: 'var(--warn)',
  tight: 'var(--serious)', full: 'var(--critical)',
};

const STORE = 'sitting-commute:v2';
const FIELDS = ['home', 'work', 'basis', 'time', 'day', 'mode', 'buffer', 'window', 'walk'];
const LABELS = {
  arrive: {
    time: '회사 도착 시각', walk: '집에서 역까지 도보(분)',
    window: '일찍 도착해도 괜찮은 한도(분)',
    windowHelp: '목표 시각보다 이만큼 넘게 일찍 도착하는 열차는 후보에서 뺍니다',
  },
  depart: {
    time: '회사에서 나서는 시각', walk: '회사에서 역까지 도보(분)',
    window: '역에서 기다려도 괜찮은 한도(분)',
    windowHelp: '역에서 이만큼 넘게 기다려야 하는 열차는 후보에서 뺍니다',
  },
};

/* ── 입력 ── */
$('stations').innerHTML = ALL_STATIONS.map((s) => `<option value="${esc(s)}">`).join('');
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved) for (const f of FIELDS) if (saved[f] != null) $(f).value = saved[f];
} catch { /* 저장값 없이 기본값으로 시작 */ }

/** 기준(출근/퇴근)에 따라 라벨과 기본 시각을 바꿉니다 */
function syncBasis(changed) {
  const basis = $('basis').value;
  const L = LABELS[basis];
  $('timeLabel').textContent = L.time;
  $('windowLabel').textContent = L.window;
  $('windowLabel').title = L.windowHelp;
  $('window').title = L.windowHelp;
  $('walkLabel').textContent = L.walk;
  $('bufferField').hidden = basis === 'depart';   // 퇴근은 도착 기한이 없습니다
  if (changed) {
    $('time').value = basis === 'arrive' ? '09:00' : '18:00';
    $('window').value = basis === 'arrive' ? 45 : 45;
  }
}

/* ── 즐겨찾기 ── */
const FAV_STORE = 'sitting-commute:favorites:v1';
const MAX_FAVS = 12;

const currentState = () => Object.fromEntries(FIELDS.map((f) => [f, $(f).value]));
const sameState = (a, b) => FIELDS.every((f) => String(a[f]) === String(b[f]));

function loadFavs() {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_STORE) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && x.home && x.work) : [];
  } catch { return []; }
}
function saveFavs(list) {
  try { localStorage.setItem(FAV_STORE, JSON.stringify(list.slice(0, MAX_FAVS))); } catch { /* 무시 */ }
}

/** '서울역 → 강남' 처럼 실제 진행 방향으로 보여 줍니다 */
function favLabel(f) {
  const toWork = f.basis !== 'depart';
  return {
    route: `${toWork ? f.home : f.work} → ${toWork ? f.work : f.home}`,
    when: `${toWork ? '출근' : '퇴근'} ${f.time}`,
  };
}

function renderFavs() {
  const host = $('favs');
  const favs = loadFavs();
  const now = currentState();
  const saved = favs.some((f) => sameState(f, now));
  host.innerHTML = `<span class="favs-label">저장한 구간</span>`
    + (favs.length ? '' : `<span class="hint">자주 타는 구간을 저장해 두면 눌러서 바로 불러옵니다</span>`)
    + favs.map((f, i) => {
      const { route, when } = favLabel(f);
      return `<span class="fav${sameState(f, now) ? ' active' : ''}">
        <button type="button" data-go="${i}">${esc(route)}<em>${esc(when)}</em></button>
        <button type="button" class="fav-x" data-del="${i}" aria-label="${esc(route)} 삭제">×</button>
      </span>`;
    }).join('')
    + `<button type="button" class="fav-add" id="favAdd"${saved ? ' disabled' : ''}>${
        saved ? '저장됨' : '＋ 지금 조건 저장'}</button>`;
}

$('favs').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  const del = e.target.closest('[data-del]');
  const add = e.target.closest('#favAdd');
  const favs = loadFavs();
  if (go) {
    const f = favs[Number(go.dataset.go)];
    if (!f) return;
    for (const k of FIELDS) if (f[k] != null) $(k).value = f[k];
    syncBasis(false);
    run();
  } else if (del) {
    favs.splice(Number(del.dataset.del), 1);
    saveFavs(favs);
    renderFavs();
  } else if (add) {
    const now = currentState();
    if (!now.home.trim() || !now.work.trim()) return;
    if (!favs.some((f) => sameState(f, now))) saveFavs([...favs, now]);
    renderFavs();
  }
});

function readForm() {
  const v = Object.fromEntries(FIELDS.map((f) => [f, $(f).value]));
  try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* 저장 실패는 무시 */ }
  const basis = v.basis === 'depart' ? 'depart' : 'arrive';
  const home = v.home.trim(), work = v.work.trim();
  return {
    home, work, basis,
    from: basis === 'arrive' ? home : work,
    to: basis === 'arrive' ? work : home,
    anchor: parseHHMM(v.time),
    dayType: v.day, mode: v.mode,
    buffer: Number(v.buffer) || 0,
    window: Number(v.window) || 45,
    walk: Number(v.walk) || 0,
  };
}

/* ── 조각 ── */
const lineChip = (line) =>
  `<span class="chip line" style="background:${line.color}">${esc(line.name)}</span>`;

const congChip = (c) => {
  const lv = congestionLevel(c);
  return `<span class="chip"><span class="dot" style="background:${LEVEL_COLOR[lv.key]}"></span>${lv.label} ${Math.round(c)}%</span>`;
};

/* ── 추천 카드 ── */
function renderSummary(plan, opts) {
  const host = $('summary');
  host.innerHTML = '';
  const { best, route, alternative } = plan;
  if (!route) {
    host.append(el('div', 'card empty', `<b>${esc(opts.from)} → ${esc(opts.to)}</b> 경로를 찾지 못했습니다.<br>수록된 역명인지 확인해 주세요. (프로토타입은 주요 노선만 수록)`));
    return;
  }
  if (!best) {
    host.append(el('div', 'card empty', '조건을 만족하는 열차가 없습니다. 도착 여유나 허용 시간을 늘려 보세요.'));
    return;
  }

  const depart = opts.basis === 'depart';
  const leave = depart
    ? Math.max(opts.anchor, best.boardTime - opts.walk - 2)
    : best.boardTime - opts.walk - 2;
  const idle = Math.round(best.boardTime - (leave + opts.walk));
  const card = el('div', 'card hero');
  const left = el('div', 'hero-left');
  left.innerHTML = `
    <div class="eyebrow">추천 열차</div>
    <div class="depart"><span class="t">${toHHMM(best.boardTime)}</span>
      <span class="at">${esc(opts.from)} 승차 · ${lineById.get(best.legs[0].lineId).name}</span></div>
    <div class="trip">
      <span><b>${toHHMM(best.arrival)}</b> ${esc(opts.to)} 도착</span>
      <span>소요 <b>${Math.round(best.totalMinutes)}분</b></span>
      <span>환승 <b>${route.transfers}회</b></span>
      <span>${depart ? `퇴근 후 <b>${Math.round(best.wait)}분</b> 뒤` : `목표까지 <b>${Math.round(best.slack)}분</b> 여유`}</span>
    </div>
    <div class="note" style="margin-top:14px">
      ${depart ? '회사' : '집'}에서 <b class="mono">${toHHMM(leave)}</b>에 나서면
      도보 ${opts.walk}분 + 대기 ${idle}분으로 이 열차를 탑니다.
      ${depart && best.wait > 6 ? `<br>${toHHMM(opts.anchor)}에 바로 나서면 역에서 <b>${Math.round(best.wait)}분</b>을 기다리게 됩니다.` : ''}
    </div>`;

  const right = el('div', 'hero-right');
  right.innerHTML = `
    <div>
      <div class="statline"><span class="k">하차 전에 앉을 확률</span>
        <span class="v">${pct(best.sitChance)}</span></div>
      <div class="meter"><i style="width:${Math.round(best.sitChance * 100)}%"></i></div>
    </div>
    <div>
      <div class="statline"><span class="k">앉아서 가는 구간 비율</span>
        <span class="v">${pct(best.seatedRatio)}<small>/ ${Math.round(best.rideTotal)}분</small></span></div>
      <div class="meter"><i style="width:${Math.round(best.seatedRatio * 100)}%;background:var(--seq-250)"></i></div>
    </div>
    <div class="chips">
      ${congChip(best.worstCongestion)}
      <span class="chip">못 탈 위험 ${pct(best.failRisk)}</span>
      ${best.legs[0].car.targetCar
        ? `<span class="chip">${best.legs[0].car.balanced.car}호차 승차 → ${exitText(best.legs[0].car.transfer)} 하차</span>`
        : `<span class="chip">한산한 칸 ${best.legs[0].car.quietCars.map((c) => c.car).join('·')}번</span>`}
    </div>`;
  card.append(left, right);
  host.append(card);

  if (alternative) {
    host.append(el('div', 'note', `
      <b class="mono">${toHHMM(alternative.boardTime)}</b> 열차를 타면 앉을 확률이
      <b>${pct(best.sitChance)} → ${pct(alternative.sitChance)}</b>로 올라갑니다 — ${opts.basis === 'depart'
        ? `대신 역에서 <b>${Math.round(alternative.wait)}분</b>을 기다려야 합니다.`
        : `추천 열차보다 <b>${Math.round(best.boardTime - alternative.boardTime)}분</b> 일찍 나서고
           목표보다 <b>${Math.round(alternative.slack)}분</b> 먼저 도착합니다.`}`));
  }
  if (best.failRisk > 0.25) {
    host.append(el('div', 'note warnbox', `
      이 시간대 <b>${esc(opts.from)}</b>은 혼잡도 ${Math.round(best.firstLegCongestion)}%로,
      한 대를 보내게 될 확률이 <b>${pct(best.failRisk)}</b>입니다. 한 대 앞 열차를 기준으로 움직이는 편이 안전합니다.`));
  }

  // 경로
  const rc = el('div', 'card pad');
  rc.append(el('div', 'eyebrow', '경로'));
  const list = el('div', 'route');
  best.legs.forEach((leg, i) => {
    const row = el('div', 'leg');
    row.innerHTML = `
      <div class="when">${toHHMM(leg.depart)}<br><span style="color:var(--ink-3)">${toHHMM(leg.arrive)}</span></div>
      <div class="what">
        <div class="top">${lineChip(leg.line)}
          <b>${esc(leg.from)} → ${esc(leg.to)}</b>
          <span style="color:var(--ink-3)">${leg.hops}정거장 · ${Math.round(leg.rideMinutes)}분</span></div>
        <div class="det">승차 혼잡도 ${Math.round(leg.boardCongestion)}% · 구간 최대 ${Math.round(leg.maxCongestion)}%
          · 이 구간 착석 확률 ${pct(leg.seat.probability)} · 배차 ${leg.headway.toFixed(1)}분</div>
      </div>`;
    list.append(row);
    const next = best.legs[i + 1];
    if (next) {
      const t = leg.car?.transfer;
      const walk = leg.walkToNext ?? next.transferWalk;
      const detail = !t ? ''
        : ` · <b>${exitText(t)}</b> 하차`
          + (t.boardCar ? ` → ${esc(next.line.name)} <b>${t.boardCar}-${t.boardDoor}</b> 승차` : '')
          + (t.ambiguous ? ' <span style="color:var(--ink-3)">(진행 방향에 따라 다름)</span>'
            : t.precise ? '' : ' <span style="color:var(--ink-3)">(국가철도공단)</span>');
      list.append(el('div', 'xfer', `${esc(leg.to)} 환승 · 도보 ${walk.toFixed(1)}분 + 대기 ${Math.round(next.wait)}분${detail}`));
    }
  });
  rc.append(list);
  host.append(rc);
}

/* ── 시간대 곡선 ── */
let tipTarget = null;
function renderCharts(plan, opts) {
  const host = $('charts');
  host.innerHTML = '';
  const { options, best } = plan;
  if (!options.length) return;

  const W = 720, PT = 30, PL = 44, PR = 16, PH = 112, GAP = 42, AX = 26;
  const H = PT + PH + GAP + PH + AX;
  const xs = options.map((o) => o.boardTime);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const X = (t) => PL + ((t - x0) / Math.max(1, x1 - x0)) * (W - PL - PR);
  const cMax = Math.max(160, Math.ceil(Math.max(...options.map((o) => o.worstCongestion)) / 20) * 20);
  const Y1 = (v) => PT + PH - (Math.min(v, cMax) / cMax) * PH;
  const Y2 = (v) => PT + PH + GAP + PH - v * PH;

  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const cPts = options.map((o) => [X(o.boardTime), Y1(o.worstCongestion)]);
  const sPts = options.map((o) => [X(o.boardTime), Y2(Math.min(1, o.sitChance))]);

  // 허용 구간(목표 시각을 지키는 승차 시각 범위)
  const okay = options.filter((o) => o.onTime && !o.outOfWindow);
  const band = okay.length
    ? `<rect x="${X(okay[0].boardTime)}" y="${PT}" width="${Math.max(2, X(okay[okay.length - 1].boardTime) - X(okay[0].boardTime))}"
        height="${PH * 2 + GAP}" fill="var(--accent-soft)"></rect>` : '';

  const ticks = [];
  for (let t = Math.ceil(x0 / 30) * 30; t <= x1; t += 30) ticks.push(t);
  const refs = [[SEAT_FULL, '34% 좌석 만석'], [80, '80%'], [120, '120% 혼잡'], [150, '150%']]
    .filter(([v]) => v <= cMax);

  const svg = `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="승차 시각별 혼잡도와 착석 확률 곡선. 수치는 아래 표에 있습니다.">
    ${band}
    ${refs.map(([v, label]) => `
      <line x1="${PL}" x2="${W - PR}" y1="${Y1(v).toFixed(1)}" y2="${Y1(v).toFixed(1)}" stroke="var(--rule)" stroke-width="1"></line>
      <text x="${PL - 6}" y="${(Y1(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--ink-3)"
        font-family="IBM Plex Mono, monospace">${v}</text>`).join('')}
    <path d="${path(cPts)} L${X(x1).toFixed(1)},${PT + PH} L${X(x0).toFixed(1)},${PT + PH} Z" fill="var(--seq-450)" fill-opacity=".1"></path>
    <path d="${path(cPts)}" fill="none" stroke="var(--seq-450)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
    <text x="${PL - 6}" y="${PT + 4}" text-anchor="end" font-size="9.5" fill="var(--ink-3)" font-family="IBM Plex Mono, monospace">${cMax}</text>

    ${[0.25, 0.5, 0.75, 1].map((v) => `
      <line x1="${PL}" x2="${W - PR}" y1="${Y2(v).toFixed(1)}" y2="${Y2(v).toFixed(1)}" stroke="var(--rule)" stroke-width="1"></line>
      <text x="${PL - 6}" y="${(Y2(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--ink-3)"
        font-family="IBM Plex Mono, monospace">${v * 100}</text>`).join('')}
    <path d="${path(sPts)} L${X(x1).toFixed(1)},${Y2(0)} L${X(x0).toFixed(1)},${Y2(0)} Z" fill="var(--accent)" fill-opacity=".1"></path>
    <path d="${path(sPts)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>

    ${ticks.map((t) => `<text x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10"
        fill="var(--ink-3)" font-family="IBM Plex Mono, monospace">${toHHMM(t)}</text>`).join('')}
    <text x="${PL - 38}" y="${PT - 11}" font-size="11.5" font-weight="700" fill="var(--ink)">구간 최대 혼잡도 (%)</text>
    <text x="${W - PR}" y="${PT - 11}" text-anchor="end" font-size="10" fill="var(--ink-3)">정원 대비 · 34% = 좌석 만석</text>
    <text x="${PL - 38}" y="${PT + PH + GAP - 11}" font-size="11.5" font-weight="700" fill="var(--ink)">하차 전에 앉을 확률 (%)</text>
    <text x="${W - PR}" y="${PT + PH + GAP - 11}" text-anchor="end" font-size="10" fill="var(--ink-3)">경로 전체 기준</text>
    ${best ? `
      <line x1="${X(best.boardTime).toFixed(1)}" x2="${X(best.boardTime).toFixed(1)}" y1="${PT}" y2="${PT + PH * 2 + GAP}"
        stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 3"></line>
      <circle cx="${X(best.boardTime).toFixed(1)}" cy="${Y1(best.worstCongestion).toFixed(1)}" r="4.5"
        fill="var(--seq-450)" stroke="var(--surface)" stroke-width="2"></circle>
      <circle cx="${X(best.boardTime).toFixed(1)}" cy="${Y2(Math.min(1, best.sitChance)).toFixed(1)}" r="4.5"
        fill="var(--accent)" stroke="var(--surface)" stroke-width="2"></circle>
      ` : ''}
    <line id="cross" x1="0" x2="0" y1="${PT}" y2="${PT + PH * 2 + GAP}" stroke="var(--ink-3)" stroke-width="1" opacity="0"></line>
    <rect id="hit" x="${PL}" y="${PT}" width="${W - PL - PR}" height="${PH * 2 + GAP}" fill="transparent"></rect>
  </svg>`;

  const card = el('div', 'card pad');
  card.append(el('h2', null, `승차 시각에 따른 변화 <span class="sub">${opts.basis === 'depart'
    ? '파란 구간이 기다릴 만한 범위 안의 열차' : '파란 구간이 목표 시각을 지키는 열차'}</span>`));
  const box = el('div', null, svg);
  card.append(box);
  host.append(card);

  // 호버
  const svgNode = box.querySelector('svg');
  const cross = box.querySelector('#cross');
  const hit = box.querySelector('#hit');
  const tip = $('tip');
  const nearest = (clientX) => {
    const r = svgNode.getBoundingClientRect();
    const vx = ((clientX - r.left) / r.width) * W;
    let bi = 0, bd = Infinity;
    options.forEach((o, i) => { const d = Math.abs(X(o.boardTime) - vx); if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  const move = (e) => {
    const i = nearest(e.clientX);
    const o = options[i];
    cross.setAttribute('x1', X(o.boardTime)); cross.setAttribute('x2', X(o.boardTime));
    cross.setAttribute('opacity', '.5');
    tip.className = 'tip on';
    tip.innerHTML = `<div class="tt">${toHHMM(o.boardTime)} 승차 → ${toHHMM(o.arrival)} 도착</div>
      <em>최대 혼잡도</em> ${Math.round(o.worstCongestion)}% (${o.level.label})<br>
      <em>앉을 확률</em> ${pct(o.sitChance)} · <em>앉아가는 구간</em> ${pct(o.seatedRatio)}<br>
      <em>못 탈 위험</em> ${pct(o.failRisk)} · <em>여유</em> ${Math.round(o.slack)}분`;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - r.width - 10, Math.max(8, e.clientX + 14))}px`;
    tip.style.top = `${Math.max(8, e.clientY - r.height - 12)}px`;
    tipTarget = o;
  };
  hit.addEventListener('mousemove', move);
  hit.addEventListener('mouseleave', () => { tip.className = 'tip'; cross.setAttribute('opacity', '0'); });
}

/* ── 경로 프로파일: 어디서 내리고, 어디서 앉게 되나 ── */
function journeySeries(best) {
  const out = [];
  best.legs.forEach((leg, li) => {
    out.push({
      station: leg.from, legIndex: li, congestion: leg.boardCongestion,
      alightShare: 0, cumulative: leg.seat.immediate, kind: li === 0 ? 'board' : 'transfer',
    });
    for (const s of leg.seat.perStop) {
      out.push({
        station: s.station, legIndex: li, congestion: s.congestion,
        alightShare: s.alightShare, cumulative: s.cumulative, kind: 'stop',
        seatAlightFrac: s.seatAlightFrac,
      });
    }
  });
  const last = best.legs[best.legs.length - 1];
  out.push({
    station: last.to, legIndex: best.legs.length - 1,
    congestion: last.seat.perStop[last.seat.perStop.length - 1]?.congestion ?? last.boardCongestion,
    alightShare: 0, cumulative: last.seat.probability, kind: 'end',
  });
  return out;
}

function renderProfile(plan) {
  const host = $('profile');
  host.innerHTML = '';
  const best = plan.best;
  if (!best) return;
  const pts = journeySeries(best);
  if (pts.length < 3) return;

  const W = 720, PL = 40, PR = 18, PT = 26, PH = 96, GAP = 36, PH2 = 64, AX = 88;
  const H = PT + PH + GAP + PH2 + AX;
  const step = (W - PL - PR) / Math.max(1, pts.length - 1);
  const X = (i) => PL + step * i;
  const cMax = Math.max(60, Math.ceil(Math.max(...pts.map((p) => p.congestion)) / 20) * 20);
  const Y1 = (v) => PT + PH - (Math.min(v, cMax) / cMax) * PH;
  const aMax = Math.max(0.2, Math.max(...pts.map((p) => p.alightShare)) * 1.15);
  const Y2 = (v) => PT + PH + GAP + PH2 - (v / aMax) * PH2;

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y1(p.congestion).toFixed(1)}`).join(' ');
  const bw = Math.min(16, step - 5);

  // 하차가 많은 역 상위 3곳
  const top = [...pts].filter((p) => p.kind === 'stop').sort((a, b) => b.alightShare - a.alightShare).slice(0, 3);
  const topSet = new Set(top.map((p) => p.station));
  // 앉을 가능성이 50%를 넘는 지점
  const cross = pts.find((p) => p.cumulative >= 0.5);

  const bars = pts.map((p, i) => {
    if (p.alightShare <= 0) return '';
    const h = Math.max(1.5, (p.alightShare / aMax) * PH2);
    const y = PT + PH + GAP + PH2 - h;
    const hot = topSet.has(p.station);
    return `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${y.toFixed(1)}"
      width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"
      fill="${hot ? 'var(--bar-hi)' : 'var(--bar)'}" opacity="${hot ? '1' : '.5'}"></rect>
      ${hot ? `<text x="${X(i).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="9.5"
        font-weight="700" fill="var(--ink-2)" font-family="IBM Plex Mono, monospace">${Math.round(p.alightShare * 100)}%</text>` : ''}`;
  }).join('');

  // 모든 역 이름을 표기합니다. 가로로는 겹치므로 45도 기울입니다.
  const baseY = PT + PH + GAP + PH2;
  const labels = pts.map((p, i) => {
    const x = X(i);
    const strong = p.kind !== 'stop';
    const hot = topSet.has(p.station);
    const fill = strong ? 'var(--ink)' : hot ? 'var(--bar-hi)' : 'var(--ink-3)';
    const name = esc(p.station) + (p.kind === 'transfer' ? ' (환승)' : '');
    return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${baseY}" y2="${baseY + 4}"
        stroke="var(--rule)" stroke-width="1"></line>
      <text x="${x.toFixed(1)}" y="${baseY + 13}" text-anchor="end" font-size="9.5"
        font-weight="${strong || hot ? 700 : 400}" fill="${fill}"
        transform="rotate(-45 ${x.toFixed(1)} ${baseY + 13})">${name}</text>`;
  }).join('');

  // 혼잡도 극값 직접 라벨 — 최고점과 가장 크게 떨어진 지점
  const peakI = pts.reduce((a, p, i) => (p.congestion > pts[a].congestion ? i : a), 0);
  let dropI = -1, dropV = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i - 1].congestion - pts[i].congestion;
    if (d > dropV) { dropV = d; dropI = i; }
  }
  const mark = (i, text, dy) => (i < 0 ? '' : `
    <circle cx="${X(i).toFixed(1)}" cy="${Y1(pts[i].congestion).toFixed(1)}" r="3.5" fill="var(--seq-450)"
      stroke="var(--surface)" stroke-width="2"></circle>
    <text x="${X(i).toFixed(1)}" y="${(Y1(pts[i].congestion) + dy).toFixed(1)}" text-anchor="middle"
      font-size="10" font-weight="700" fill="var(--ink-2)" font-family="IBM Plex Mono, monospace">${text}</text>`);
  const extremes = mark(peakI, `${Math.round(pts[peakI].congestion)}%`, -9)
    + (dropI >= 0 && dropV > 4 ? mark(dropI, `${Math.round(pts[dropI].congestion)}%`, 15) : '');

  const transfers = pts.map((p, i) => (p.kind === 'transfer'
    ? `<line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${PT}" y2="${PT + PH + GAP + PH2}"
        stroke="var(--rule)" stroke-width="1" stroke-dasharray="3 3"></line>` : '')).join('');

  const crossMark = cross ? (() => {
    const i = pts.indexOf(cross);
    return `<circle cx="${X(i).toFixed(1)}" cy="${Y1(cross.congestion).toFixed(1)}" r="4.5" fill="var(--bar-hi)"
      stroke="var(--surface)" stroke-width="2"></circle>`;
  })() : '';

  const card = el('div', 'card pad');
  card.append(el('h2', null, `경로에서 벌어지는 일 <span class="sub">역을 지나며 혼잡도가 어떻게 변하는지</span>`));
  card.append(el('div', null, `<svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="경로상 역별 혼잡도와 하차 비율. 수치는 아래 설명에 있습니다.">
    ${transfers}
    <line x1="${PL}" x2="${W - PR}" y1="${Y1(SEAT_FULL).toFixed(1)}" y2="${Y1(SEAT_FULL).toFixed(1)}"
      stroke="var(--rule)" stroke-width="1"></line>
    <text x="${PL - 6}" y="${(Y1(SEAT_FULL) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5"
      fill="var(--ink-3)" font-family="IBM Plex Mono, monospace">34</text>
    <text x="${PL - 6}" y="${PT + 4}" text-anchor="end" font-size="9.5" fill="var(--ink-3)"
      font-family="IBM Plex Mono, monospace">${cMax}</text>
    <path d="${line} L${X(pts.length - 1).toFixed(1)},${PT + PH} L${PL},${PT + PH} Z"
      fill="var(--seq-450)" fill-opacity=".1"></path>
    <path d="${line}" fill="none" stroke="var(--seq-450)" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"></path>
    ${extremes}${crossMark}
    <text x="${PL - 38}" y="${PT - 10}" font-size="11.5" font-weight="700" fill="var(--ink)">혼잡도 (%)</text>
    <text x="${PL - 38}" y="${PT + PH + GAP - 10}" font-size="11.5" font-weight="700" fill="var(--ink)">역별 하차 비율 (%)</text>
    <text x="${W - PR}" y="${PT + PH + GAP - 10}" text-anchor="end" font-size="10" fill="var(--ink-3)">탄 사람 중 몇 %가 내리는지</text>
    <line x1="${PL}" x2="${W - PR}" y1="${PT + PH + GAP + PH2}" y2="${PT + PH + GAP + PH2}"
      stroke="var(--rule)" stroke-width="1"></line>
    ${bars}${labels}
  </svg>`));

  const note = el('div', 'note');
  const topText = top.map((p) => `<b>${esc(p.station)}</b>(${Math.round(p.alightShare * 100)}%)`).join(', ');
  // 좌석 회전이 집계 하차율보다 얼마나 빠른지
  const turn = pts.filter((p) => p.kind === 'stop' && p.seatAlightFrac > 0 && p.congestion > SEAT_FULL);
  const ratio = turn.length
    ? turn.reduce((a, p) => a + p.seatAlightFrac / Math.min(1, SEAT_FULL / p.congestion), 0) / turn.length
    : 0;
  note.innerHTML = `이 열차에 탄 사람 중 가장 많이 내리는 역은 ${topText}입니다.
    ${cross
      ? `앉을 가능성이 50%를 넘는 건 <b>${esc(cross.station)}</b> 부근입니다.`
      : `그래도 앉을 가능성이 50%를 넘는 지점은 없습니다 — 이 시간대엔 서서 가게 됩니다.`}
    ${best.legs.length > 1 ? `환승하면 좌석은 처음부터 다시 구해야 해서, 그래프의 누적도 환승 지점에서 끊깁니다.` : ''}
    ${ratio > 1.05 ? `<br>내리는 사람은 <b>앉아 있던 쪽에 ${ratio.toFixed(1)}배 몰려 있습니다</b> —
      멀리서 탄 사람이 좌석을 차지하고 있다가 도심에서 내리기 때문입니다. 그만큼 좌석 회전이 빠릅니다.` : ''}`;
  card.append(note);
  host.append(card);
}

/* ── 칸별 혼잡도 + 승차/하차 칸 계획 ── */
function renderCars(plan) {
  const host = $('cars');
  host.innerHTML = '';
  const best = plan.best;
  if (!best) return;
  const leg = best.legs[0];
  const c = leg.car;
  const cars = c.perCar;
  const target = c.targetCar;
  const board = c.balanced;
  const moving = board.moveCars > 0;

  const W = 720, H = 210, PL = 38, PR = 14, PT = 56, PB = 44;
  const maxC = Math.max(...cars.map((x) => x.congestion)) * 1.14;
  const band = (W - PL - PR) / cars.length;
  const bw = Math.min(24, band - 8);
  const cx = (car) => PL + band * (car - 1) + band / 2;

  const bars = cars.map((x) => {
    const isBoard = x.car === board.car, isTarget = x.car === target;
    // 한 칸이 승차·하차를 겸할 수 있으므로 라벨은 하나만 고릅니다
    const role = isBoard && isTarget ? '타고 내림' : isBoard ? '승차' : isTarget ? '하차' : '';
    const h = Math.max(3, ((H - PT - PB) * x.congestion) / maxC);
    const y = H - PB - h;
    const fill = isBoard ? 'var(--bar-hi)' : isTarget ? 'var(--seq-450)' : 'var(--bar)';
    const op = isBoard || isTarget ? '1' : '.55';
    return `<g><rect x="${(cx(x.car) - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}"
        height="${h.toFixed(1)}" rx="4" fill="${fill}" opacity="${op}"></rect>
      ${isBoard || isTarget ? `<text x="${cx(x.car).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle"
        font-size="10.5" font-weight="700" fill="var(--ink-2)" font-family="IBM Plex Mono, monospace">${Math.round(x.congestion)}%</text>` : ''}
      <text x="${cx(x.car).toFixed(1)}" y="${H - PB + 15}" text-anchor="middle" font-size="10.5"
        fill="${isBoard || isTarget ? 'var(--ink)' : 'var(--ink-3)'}" font-family="IBM Plex Mono, monospace">${x.car}</text>
      ${role ? `<text x="${cx(x.car).toFixed(1)}" y="${H - PB + 30}" text-anchor="middle" font-size="10"
        font-weight="700" fill="${isBoard ? 'var(--bar-hi)' : 'var(--seq-450)'}">${role}</text>` : ''}</g>`;
  }).join('');

  // 차내 이동 화살표
  const arrow = moving && target ? (() => {
    const x1 = cx(board.car), x2 = cx(target), y = 30;
    const dir = x2 > x1 ? 1 : -1;
    return `<g>
      <path d="M${x1},${y + 10} L${x1},${y} L${x2 - dir * 7},${y}" fill="none" stroke="var(--bar-hi)"
        stroke-width="1.5" stroke-dasharray="4 3"></path>
      <path d="M${x2 - dir * 7},${y - 4} L${x2},${y} L${x2 - dir * 7},${y + 4}" fill="var(--bar-hi)"></path>
      <text x="${Math.min(W - PR - 62, Math.max(PL + 62, (x1 + x2) / 2)).toFixed(1)}" y="${y - 8}"
        text-anchor="middle" font-size="10.5" font-weight="700"
        fill="var(--bar-hi)">${esc(c.moveAt?.station ?? '')}에서 ${board.moveCars}칸 이동 · ${board.moveLabel}</text></g>`;
  })() : '';

  const card = el('div', 'card pad');
  card.append(el('h2', null, `탈 칸 · 내릴 칸 <span class="sub">${leg.line.name} · ${toHHMM(leg.depart)} ${esc(leg.from)} 승차 · ${leg.line.cars}칸</span>`));
  card.append(el('div', null, `<svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="칸별 혼잡도와 추천 승차 칸, 하차 칸">
    <line x1="${PL}" x2="${W - PR}" y1="${H - PB}" y2="${H - PB}" stroke="var(--rule)" stroke-width="1"></line>
    ${arrow}${bars}
  </svg>`));

  // 행동 지침 + 비교
  const g = el('div', 'note');
  if (c.transfer?.ambiguous) {
    g.innerHTML = `하차 위치는 <b>${exitText(c.transfer)}</b>입니다 — 이 조합은 타고 온 방향 구분이 없는
      데이터라 둘 중 어느 쪽인지는 단정할 수 없습니다(보통 서로 거울 위치입니다).
      앉는 것만 보면 <b>${quietLabel}번 칸</b>이 가장 한산합니다.`;
  } else if (!c.transfer) {
    g.innerHTML = `<b>${quietLabel}번 칸</b>이 가장 한산합니다.
      이 역·방향 조합은 환승정보 데이터에 없어 하차 칸을 지정하지 못했습니다.`;
  } else if (!moving) {
    g.innerHTML = `이 시간대는 통로가 <b>${board.moveLabel}</b>이라 차내 이동이 손해입니다 —
      하차 위치인 <b>${c.transfer.exitCar}호차 ${c.transfer.exitDoor}번 문</b>에 그대로 타세요.
      (앉을 확률 ${pct(board.seatIfMoving)})`;
  } else {
    const gain = board.seatIfMoving - (c.stay?.seatIfMoving ?? 0);
    g.innerHTML = `<b>${board.car}호차</b>에 타서 앉아 가다가,
      <b>${esc(c.moveAt?.station ?? '')}</b>에서 <b>${c.transfer.exitCar}호차 ${c.transfer.exitDoor}번 문</b>으로
      ${board.moveCars}칸 옮기면 됩니다 — 앉을 확률 ${pct(c.stay?.seatIfMoving ?? 0)} →
      <b>${pct(board.seatIfMoving)}</b>${gain > 0 ? ` (+${Math.round(gain * 100)}%p)` : ''}.
      통로 이동은 <b>${board.moveLabel}</b>.`;
  }
  card.append(g);

  if (c.targetCar) {
    const rows = [
      ['하차 칸에 그대로', `${c.transfer.exitCar}호차`, c.stay?.seatIfMoving ?? 0, '없음'],
      ['추천', `${board.car}호차`, board.seatIfMoving, moving ? `${esc(c.moveAt?.station ?? '')}에서 ${board.moveCars}칸 (${board.moveLabel})` : '없음'],
      ['앉을 확률 최대', `${c.maxSeat.car}호차`, c.maxSeat.seatIfMoving,
        c.maxSeat.moveCars ? `${esc(c.moveAt?.station ?? '')}에서 ${c.maxSeat.moveCars}칸 (${c.maxSeat.moveLabel})` : '없음'],
    ];
    const box = el('div', 'scroll');
    box.innerHTML = `<table style="min-width:420px"><thead><tr>
      <th>방법</th><th>승차 칸</th><th>앉을 확률</th><th>차내 이동</th></tr></thead><tbody>
      ${rows.map(([k, car, p, mv], i) => `<tr class="${i === 1 ? 'best' : ''}">
        <td>${k}</td><td class="num">${car}</td><td class="num">${pct(p)}</td><td>${mv}</td></tr>`).join('')}
      </tbody></table>`;
    card.append(box);
    card.append(el('div', 'hint', `하차 위치 출처: ${esc(TRANSFER_CARS_SOURCE ?? '')} — 실데이터입니다. 칸별 혼잡도와 이동 난이도는 모델 추정값입니다.`));
  }
  host.append(card);
}

/* ── 열차 목록(표) ── */
function renderTrains(plan, opts) {
  const host = $('trains');
  host.innerHTML = '';
  if (!plan.options.length) return;
  const card = el('div', 'card pad');
  card.append(el('h2', null, `열차별 비교 <span class="sub">${esc(opts.from)} 출발 · ${plan.options.length}대</span>`));
  const rows = plan.options.map((o) => {
    const cls = [o === plan.best ? 'best' : '', !o.onTime || o.outOfWindow ? 'out' : ''].join(' ').trim();
    const depart = opts.basis === 'depart';
    const tag = o === plan.best ? '<span class="tag">추천</span>'
      : o === plan.alternative ? '<span class="tag ghost">대안</span>'
      : !o.onTime ? `<span class="tag ghost">${depart ? '퇴근 전' : '지각'}</span>`
      : o.outOfWindow ? `<span class="tag ghost">${depart ? '너무 늦게' : '너무 일찍'}</span>` : '';
    return `<tr class="${cls}">
      <td class="num">${toHHMM(o.boardTime)}${tag}</td>
      <td class="num">${toHHMM(o.arrival)}</td>
      <td class="num">${Math.round(o.totalMinutes)}</td>
      <td class="num">${Math.round(o.firstLegCongestion)}%</td>
      <td class="num">${Math.round(o.worstCongestion)}%</td>
      <td class="num">${pct(o.sitChance)}</td>
      <td class="num">${pct(o.seatedRatio)}</td>
      <td class="num">${pct(o.failRisk)}</td>
      <td class="num">${Math.round(opts.basis === 'depart' ? o.wait : o.slack)}</td></tr>`;
  }).join('');
  const box = el('div', 'scroll');
  box.style.maxHeight = '420px';
  box.style.overflowY = 'auto';
  box.innerHTML = `<table><thead><tr>
    <th>승차</th><th>도착</th><th>소요</th><th>승차 혼잡도</th><th>최대 혼잡도</th>
    <th>앉을 확률</th><th>앉아가는 구간</th><th>못 탈 위험</th><th>${opts.basis === 'depart' ? '대기(분)' : '여유(분)'}</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  card.append(box);
  host.append(card);
}

function renderSources() {
  $('sources').innerHTML = `
    <h3>이 화면의 숫자는 어디서 왔나</h3>
    <p style="margin:0 0 10px">
      <b>환승 위치·환승 소요시간은 실데이터</b>(서울교통공사 환승정보)입니다.
      혼잡도는 정의만 서울교통공사 기준(<b>정원 대비 승차 인원 %, 좌석 만석 = 34%</b>)을 따를 뿐,
      값 자체는 <b>역별 수요 가중치 × 시간대 곡선</b>으로 만든 <b>추정 모델</b>입니다. 실측이 아닙니다.
      노선별 최고 혼잡도만 공개 통계 수준에 맞춰 보정했습니다.
    </p>
    <h3>실데이터로 바꿀 때 연결할 소스</h3>
    <ul>
      <li>혼잡도(30분 단위·요일·상하선) — <a href="https://data.seoul.go.kr/bsp/wgs/dataView/data300View/645.do" target="_blank" rel="noopener">서울교통공사 지하철혼잡도 정보</a> (분기 갱신, CSV/JSON)</li>
      <li>역별 시간대별 승하차 인원 — <a href="https://data.seoul.go.kr/dataList/OA-12252/S/1/datasetView.do" target="_blank" rel="noopener">서울 열린데이터광장</a> (월 갱신) → 수요 가중치 대체</li>
      <li><b>적용됨</b> — 빠른 환승 위치(호차-문)·환승 소요시간: <a href="https://www.data.go.kr/data/15098252/fileData.do" target="_blank" rel="noopener">서울교통공사 서울 도시철도 환승정보</a> + 국가철도공단 운영기관별 환승정보 26종(<a href="https://www.data.go.kr/data/15041072/fileData.do" target="_blank" rel="noopener">신분당선</a>, <a href="https://www.data.go.kr/data/15041085/fileData.do" target="_blank" rel="noopener">코레일</a> 등). 수도권 환승 조합의 94%를 덮습니다.</li>
      <li>열차 시간표 — <a href="https://www.data.go.kr/data/15143847/openapi.do" target="_blank" rel="noopener">서울교통공사 열차시간표 API</a> / 역간 거리·소요시간 — <a href="https://data.seoul.go.kr/dataList/OA-12034/S/1/datasetView.do" target="_blank" rel="noopener">역간거리</a></li>
      <li>실시간 칸별 혼잡도·칸별 하차 비율 — <a href="https://openapi.sk.com/products/detail?svcSeq=54&menuSeq=249" target="_blank" rel="noopener">SK Open API 지하철 혼잡도</a> (유료 가능)</li>
      <li>실시간 도착 정보 — <a href="https://www.data.go.kr/data/15125683/openapi.do" target="_blank" rel="noopener">서울시 지하철 실시간 도착정보(일괄)</a></li>
    </ul>`;
}

/* ── 실행 ── */
function run(e) {
  e?.preventDefault();
  const opts = readForm();
  if (!opts.home || !opts.work) return;
  const t0 = performance.now();
  const plan = planCommute(opts);
  $('hint').textContent = plan.route
    ? `${plan.options.length}대 평가 · ${Math.round(performance.now() - t0)}ms`
    : '';
  renderSummary(plan, opts);
  renderCharts(plan, opts);
  renderProfile(plan);
  renderCars(plan);
  renderTrains(plan, opts);
  renderSources();
  renderFavs();
}
/* ── 서비스워커 (오프라인) ── */
// 아티팩트처럼 iframe 안에서 열릴 때는 등록하지 않습니다.
let topLevel = true;
try { topLevel = window.top === window.self; } catch { topLevel = false; }
if ('serviceWorker' in navigator && topLevel
    && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .catch(() => { /* 등록 실패해도 앱은 그대로 동작합니다 */ });
  });
}

$('form').addEventListener('submit', run);
for (const f of ['day', 'mode']) $(f).addEventListener('change', run);
$('basis').addEventListener('change', () => { syncBasis(true); run(); });
syncBasis(false);
run();
