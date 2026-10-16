/**
 * 환승 데이터 병합 → src/transfer-cars.js
 *
 *   node tools/merge-transfer.mjs
 *
 * 두 종류를 합칩니다.
 *  1) data/transfer-info.csv — 서울교통공사 '서울 도시철도 환승정보'
 *     하차 방면까지 구분하고 승차 위치·소요시간까지 줍니다. 가장 정밀해서 우선 적용.
 *  2) data/krn/*.csv — 국가철도공단 운영기관별 '환승정보'
 *     차량순서·출입문만 있고 '타고 온 방면' 구분이 없습니다. 1)이 없는 곳을 메웁니다.
 *     한 조합에 위치가 둘 있으면 보통 진행 방향별 하차 위치(서로 거울 관계)입니다.
 *
 * 역명이 전국에서 겹치므로(부산에도 교대역이 있습니다) 모든 행을 network.js 와
 * 대조해 검증합니다 — 해당 역이 그 노선에 있고, 환승이후역명이 실제로 인접해야 통과.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINES } from '../src/network.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const decode = (buf) => {
  const u = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  return u.includes('�') ? new TextDecoder('euc-kr').decode(buf) : u;
};
function parseCsv(text) {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  });
}
const clean = (s) => String(s ?? '').replace(/\(.*?\)/g, '').replace(/\s*방면\s*$/, '').trim();

/** 노선 표기 → network.js 의 group */
const GROUP = {
  1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  '1호선': '1', '2호선': '2', '3호선': '3', '4호선': '4', '5호선': '5',
  '6호선': '6', '7호선': '7', '8호선': '8', '9호선': '9',
  신분당선: 'sb', 수인분당선: 'sb-ln', 분당선: 'sb-ln', 수인선: 'sb-ln',
  경의선: 'gj', 경의중앙선: 'gj', 중앙선: 'gj',
  공항철도: 'ae', 인천국제공항철도: 'ae', 공항철도1호선: 'ae',
};
/** '경의중앙선'과 '경의중앙'처럼 '선' 유무가 파일마다 달라서 양쪽을 다 봅니다. */
const group = (s) => {
  const k = String(s ?? '').replace(/\s/g, '');
  return GROUP[k] ?? GROUP[`${k}선`] ?? GROUP[k.replace(/선$/, '')] ?? null;
};

/** 네트워크 검증 — 그 역이 노선에 있는지, 다음 역이 실제 인접인지 */
const linesByGroup = new Map();
for (const l of LINES) {
  if (!linesByGroup.has(l.group)) linesByGroup.set(l.group, []);
  linesByGroup.get(l.group).push(l);
}
/**
 * '○○ 방면' 을 진행 방향(+1/-1)으로 해석합니다.
 * 방면역은 바로 다음 역일 때도 있고(일반), 몇 정거장 건너뛴 급행 정차역이거나
 * 그냥 방향 표시용 역일 때도 있어서(예: 동대문역사문화공원 → '을지로입구'),
 * 이름을 그대로 맞추는 대신 노선 위 상대 위치로 방향만 뽑습니다.
 * 0 = 알 수 없음(방면역이 비어 있거나 노선에 없음) — 와일드카드로 씁니다.
 */
function resolveDir(groupId, station, towards) {
  if (!towards) return 0;
  for (const line of linesByGroup.get(groupId) ?? []) {
    const i = line.stations.indexOf(station);
    const j = line.stations.indexOf(towards);
    if (i < 0 || j < 0 || i === j) continue;
    if (line.loop) {
      const n = line.stations.length;
      return (j - i + n) % n <= n - ((j - i + n) % n) ? 1 : -1;
    }
    return j > i ? 1 : -1;
  }
  return 0;
}
const onLine = (groupId, station) =>
  (linesByGroup.get(groupId) ?? []).some((l) => l.stations.includes(station));

const stats = { precise: 0, candidates: 0, dropped: 0, reasons: {} };
const drop = (why) => { stats.dropped++; stats.reasons[why] = (stats.reasons[why] ?? 0) + 1; };

/* ── 1) 서울교통공사 (정밀) ── */
const precise = {};
const stcPath = resolve(root, 'data/transfer-info.csv');
if (existsSync(stcPath)) {
  const rows = parseCsv(decode(readFileSync(stcPath)));
  const h = rows.shift();
  const at = (name) => h.findIndex((x) => x.replace(/\s/g, '') === name.replace(/\s/g, ''));
  const C = {
    station: at('환승시작역'), line: at('환승시작 호선'), towards: at('하차 열차 방면'),
    exitCar: at('하차위치(호차)'), exitDoor: at('하차위치(문)'), toTowards: at('환승 열차 방면'),
    boardCar: at('환승 승차위치(호차)'), boardDoor: at('환승 승차위치(문)'), minutes: at('소요시간'),
  };
  const toMin = (s) => {
    const m = /^(\d+):(\d+)$/.exec(String(s ?? '').trim());
    return m ? Math.round((+m[1] + +m[2] / 60) * 10) / 10 : null;
  };
  for (const r of rows) {
    if (r.length < h.length) { drop('행 길이 부족'); continue; }
    const st = clean(r[C.station]), g = group(r[C.line]);
    const fw = clean(r[C.towards]), tw = clean(r[C.toTowards]);
    if (!g || !onLine(g, st)) { drop('노선/역 불일치'); continue; }
    const fromDir = resolveDir(g, st, fw);
    // 갈아탈 노선은 이 역을 지나는 다른 노선 중 방면역이 있는 쪽
    let toG = null, toDir = 0;
    for (const [gid] of linesByGroup) {
      if (gid === g || !onLine(gid, st)) continue;
      const d = resolveDir(gid, st, tw);
      if (d !== 0) { toG = gid; toDir = d; break; }
    }
    if (!toG) { drop('환승 노선 판별 실패'); continue; }
    precise[`${st}|${g}|${fromDir}|${toG}|${toDir}`] = {
      exitCar: +r[C.exitCar], exitDoor: +r[C.exitDoor],
      boardCar: +r[C.boardCar], boardDoor: +r[C.boardDoor], minutes: toMin(r[C.minutes]),
    };
    stats.precise++;
  }
}

/* ── 2) 국가철도공단 (보완) ── */
const candidates = {};
const krnDir = resolve(root, 'data/krn');
if (existsSync(krnDir)) {
  for (const file of readdirSync(krnDir).filter((f) => f.endsWith('.csv'))) {
    const rows = parseCsv(decode(readFileSync(resolve(krnDir, file))));
    const h = rows.shift();
    const idx = (name) => h.findIndex((x) => x.replace(/\s/g, '') === name);
    const C = {
      line: idx('노선명'), station: idx('역명'), toLine: idx('환승선명'),
      next: idx('환승이후역명'), car: idx('차량순서'), door: idx('차량출입문번호'),
    };
    if (C.station < 0 || C.car < 0) continue;
    for (const r of rows) {
      if (r.length < h.length) { drop('행 길이 부족'); continue; }
      const st = clean(r[C.station]), from = group(r[C.line]), to = group(r[C.toLine]);
      const next = clean(r[C.next]);
      if (!from || !to) { drop('수도권 외 노선'); continue; }
      if (!onLine(from, st) || !onLine(to, st)) { drop('노선/역 불일치(동명이역 포함)'); continue; }
      const toDir = resolveDir(to, st, next);
      const key = `${st}|${from}|${to}|${toDir}`;
      const car = +r[C.car], door = +r[C.door];
      if (!Number.isFinite(car) || !Number.isFinite(door)) { drop('호차/문 결측'); continue; }
      candidates[key] ??= [];
      if (!candidates[key].some((p) => p.car === car && p.door === door)) candidates[key].push({ car, door });
    }
  }
  stats.candidates = Object.keys(candidates).length;
  for (const k of Object.keys(candidates)) candidates[k].sort((a, b) => a.car - b.car || a.door - b.door);
}

const today = new Date().toISOString().slice(0, 10);
writeFileSync(resolve(root, 'src/transfer-cars.js'), `/**
 * transfer-cars.js — 빠른 환승 승하차 위치 (자동 생성: tools/merge-transfer.mjs, ${today})
 *
 * 방면역 이름 대신 **진행 방향(+1/-1, 0=불문)** 으로 키를 잡습니다. 데이터마다
 * 방면 표기가 인접역/급행 정차역/방향 표시역으로 제각각이라, 이름으로 맞추면
 * 멀쩡한 기록이 버려집니다.
 *
 * PRECISE: 서울교통공사 '서울 도시철도 환승정보'
 *   키 \`\${환승역}|\${출발 호선}|\${타고 온 방향}|\${환승 호선}|\${갈아탈 방향}\`
 *   하차 위치 + 승차 위치 + 환승 소요시간(분)
 *
 * CANDIDATES: 국가철도공단 운영기관별 '환승정보'
 *   키 \`\${환승역}|\${출발 호선}|\${환승 호선}|\${갈아탈 방향}\`
 *   차량순서-출입문만 있고 '타고 온 방면' 구분이 없습니다. 값이 둘이면 보통
 *   진행 방향별 하차 위치(서로 거울 관계)라 어느 쪽인지 단정할 수 없습니다.
 */
export const TRANSFER_CARS = ${JSON.stringify(precise)};
export const TRANSFER_CANDIDATES = ${JSON.stringify(candidates)};
export const TRANSFER_CARS_SOURCE = '서울교통공사 환승정보 ${stats.precise}건 + 국가철도공단 ${stats.candidates}건';

/**
 * @returns {null | {exitCar,exitDoor,boardCar,boardDoor,minutes,precise:true}
 *                 | {candidates:[{car,door}], precise:false, ambiguous:boolean}}
 */
export function lookupTransferCar(station, fromGroup, fromDir, toGroup, toDir) {
  const exact = TRANSFER_CARS[\`\${station}|\${fromGroup}|\${fromDir}|\${toGroup}|\${toDir}\`];
  if (exact) return { ...exact, precise: true };
  // 타고 온 방향 기록이 없는 경우(0)까지 넓혀서 재시도
  const loose = TRANSFER_CARS[\`\${station}|\${fromGroup}|0|\${toGroup}|\${toDir}\`];
  if (loose) return { ...loose, precise: true, approximate: true };
  const cand = TRANSFER_CANDIDATES[\`\${station}|\${fromGroup}|\${toGroup}|\${toDir}\`]
    ?? TRANSFER_CANDIDATES[\`\${station}|\${fromGroup}|\${toGroup}|0\`];
  if (cand?.length) {
    return cand.length === 1
      ? { exitCar: cand[0].car, exitDoor: cand[0].door, boardCar: null, boardDoor: null,
          minutes: null, precise: false, ambiguous: false }
      : { candidates: cand, precise: false, ambiguous: true };
  }
  return null;
}
`);
console.log(`정밀 ${stats.precise}건 · 보완 ${stats.candidates}건 · 제외 ${stats.dropped}건`);
console.log('제외 사유:', stats.reasons);
