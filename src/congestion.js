/**
 * congestion.js — 혼잡도 / 착석 확률 모델
 *
 * 혼잡도 정의는 서울교통공사 기준을 그대로 씁니다.
 *   혼잡도(%) = 승차 인원 / 열차 정원 × 100,  좌석이 모두 찬 상태 = 34%
 *
 * 구간 혼잡도는 중력모형으로 만듭니다. 오전에는 주거 가중치에서 승차해
 * 업무 가중치로 하차하고(저녁은 반대), 각 승객은 진행 방향 하류의 역 중
 * 업무 가중치에 비례해 목적지를 고릅니다. 그렇게 얻은 구간 누적 승차량을
 * 노선별 실측 최고 혼잡도(LINE_PEAK)에 맞춰 정규화합니다.
 */
import { LINES } from './network.js';
import { STATION_META, DEFAULT_META, TYPE_SHARE, LINE_PEAK } from './demand.js';

export const SEAT_FULL = 34;      // 좌석 만석 시 혼잡도(%) — 서울교통공사 정의
const SEAT_COMPETITION = 1.5;     // 빈 좌석 1석당 실질 경합 입석 수 α
                                  // 1.0 = 모든 입석이 동등하게 경합(중립 기준).
                                  // 그보다 큰 값은 좌석 앞에 이미 서 있던 사람이
                                  // 먼저 앉는 몫. 좌석/입석 하차율을 분리(φ)하기
                                  // 전에는 2.2로 보수적으로 잡고 있었습니다.
const MODE_MAX = { am: 1.0, pm: 0.92, day: 0.38 };

/** 시간대 가중 곡선 — 30분 단위 실측 혼잡도로 교체 가능한 앵커 테이블 */
const CURVES = {
  am: [[300,0.02],[360,0.10],[390,0.22],[420,0.52],[435,0.68],[450,0.82],[465,0.93],[480,1.00],[495,1.00],[510,0.93],[525,0.80],[540,0.60],[555,0.42],[570,0.28],[600,0.14],[660,0.06],[1440,0.03]],
  pm: [[300,0.02],[600,0.05],[900,0.12],[960,0.22],[1020,0.42],[1050,0.62],[1080,0.86],[1095,0.92],[1110,0.90],[1140,0.72],[1170,0.55],[1200,0.42],[1260,0.34],[1320,0.28],[1380,0.18],[1440,0.06]],
  day: [[300,0.02],[420,0.10],[480,0.14],[540,0.20],[600,0.26],[660,0.30],[720,0.34],[780,0.33],[840,0.32],[900,0.34],[960,0.36],[1020,0.38],[1080,0.36],[1140,0.33],[1200,0.30],[1260,0.26],[1320,0.20],[1380,0.12],[1440,0.05]],
};

const DAY_SCALE = {
  weekday: { am: 1, pm: 1, day: 1 },
  sat:     { am: 0.14, pm: 0.30, day: 1.25 },
  sun:     { am: 0.10, pm: 0.26, day: 1.05 },
};

function interp(anchors, x) {
  if (x <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return anchors[anchors.length - 1][1];
}

export function timeWeights(minute, dayType = 'weekday') {
  const s = DAY_SCALE[dayType] ?? DAY_SCALE.weekday;
  return {
    am: interp(CURVES.am, minute) * s.am,
    pm: interp(CURVES.pm, minute) * s.pm,
    day: interp(CURVES.day, minute) * s.day,
  };
}

const meta = (name) => STATION_META[name] ?? DEFAULT_META;
const weights = (name) => {
  const [w, type] = meta(name);
  const share = TYPE_SHARE[type] ?? TYPE_SHARE.m;
  return { res: w * share.res, job: w * share.job };
};

/** 칸별 혼잡도 보정계수 (양 끝 칸이 한산한 U자형, 평균 1.0으로 정규화) */
export function carFactors(cars) {
  const raw = [];
  for (let i = 0; i < cars; i++) {
    const x = cars === 1 ? 0 : (i / (cars - 1)) * 2 - 1; // -1..1
    raw.push(1 - 0.16 * (x * x * 3 - 1) * 0.5); // 중앙 ↑, 양 끝 ↓ (대칭)
  }
  const mean = raw.reduce((a, b) => a + b, 0) / cars;
  return raw.map((v) => v / mean);
}

/**
 * 노선별 구간 프로파일을 미리 계산.
 * profile[lineId] = { seg: {am:[[dir1],[dir-1]], ...}, alight: {...}, K }
 */
function buildProfiles() {
  const out = {};
  for (const line of LINES) {
    const n = line.stations.length;
    const w = line.stations.map(weights);
    const segCount = line.loop ? n : n - 1;
    const maxSpan = line.loop ? Math.floor(n / 2) : n - 1;
    const stride = maxSpan + 1;

    const seg = {}, alight = {}, seatAlight = {};
    const kept = {};   // 좌석 배분 계산에 다시 쓸 흐름/승차량
    for (const mode of ['am', 'pm', 'day']) {
      seg[mode] = [null, null];
      alight[mode] = [null, null];
      seatAlight[mode] = [null, null];
      kept[mode] = [null, null];
      for (const di of [0, 1]) {
        const dir = di === 0 ? 1 : -1;
        // order index p → line station index
        const L = (p) => {
          const q = ((p % n) + n) % n;
          if (dir === 1) return q;
          return line.loop ? (n - q) % n : n - 1 - q;
        };
        const B = [], D = [];
        for (let p = 0; p < n; p++) {
          const sw = w[L(p)];
          if (mode === 'am') { B.push(sw.res); D.push(sw.job); }
          else if (mode === 'pm') { B.push(sw.job); D.push(sw.res); }
          else { B.push((sw.res + sw.job) / 2); D.push((sw.res + sw.job) / 2); }
        }
        // flows[p*stride + d] = p 에서 타서 d 정거장 뒤에 내리는 양
        const flows = new Float64Array(n * stride);
        const diff = new Float64Array(n + maxSpan + 2);
        const alightCount = new Float64Array(n);
        for (let p = 0; p < n; p++) {
          const last = line.loop ? p + maxSpan : n - 1;
          let S = 0;
          for (let q = p + 1; q <= last; q++) S += D[q % n];
          if (S <= 0 || B[p] <= 0) continue;
          for (let q = p + 1; q <= last; q++) {
            const f = (B[p] * D[q % n]) / S;
            if (f <= 0) continue;
            flows[p * stride + (q - p)] = f;
            diff[p] += f;
            diff[q] -= f;
            alightCount[q % n] += f;
          }
        }
        // 누적 → order 구간 적재량, 그리고 line 구간 인덱스로 환산
        const orderSeg = new Float64Array(n + maxSpan + 1);
        let run = 0;
        for (let p = 0; p < orderSeg.length; p++) { run += diff[p]; orderSeg[p] = run; }
        const segArr = new Float64Array(segCount);
        const arriving = new Float64Array(n);
        const orderLoad = new Float64Array(n);
        for (let p = 0; p < (line.loop ? n : n - 1); p++) {
          const a = L(p), b = L(p + 1);
          const ls = line.loop
            ? (dir === 1 ? a : (a - 1 + n) % n)
            : (dir === 1 ? a : b);
          let load = orderSeg[p];
          if (line.loop) for (let k = p + n; k < orderSeg.length; k += n) load += orderSeg[k];
          segArr[ls] = Math.max(segArr[ls], load);
          arriving[L(p + 1)] = load;
          orderLoad[p] = load;
        }
        const alightArr = new Float64Array(n);
        for (let p = 1; p < n; p++) {
          const i = L(p);
          alightArr[i] = arriving[i] > 0 ? Math.min(0.95, alightCount[i] / arriving[i]) : 0.9;
        }
        seg[mode][di] = segArr;
        alight[mode][di] = alightArr;
        kept[mode][di] = { flows, L, orderLoad };
      }
    }
    let K = 0;
    for (const mode of ['am', 'pm', 'day'])
      for (const di of [0, 1])
        for (const v of seg[mode][di]) K = Math.max(K, v * MODE_MAX[mode]);
    K = K || 1;
    const peak = LINE_PEAK[line.id] ?? 110;

    // ── 좌석에서 내리는 비율 φ ──
    // 좌석은 먼저 탄 사람이 차지하고 있다고 봅니다(종점 쪽에서 타면 앉고,
    // 늦게 타면 서서 갑니다). 그래서 역 k 에서 내리는 사람 중 '앉아 있던'
    // 비율은 전체 하차율과 다릅니다 — 멀리서 탄 사람이 도심에서 한꺼번에
    // 내리므로, 좌석 회전은 집계 하차율보다 빠릅니다.
    for (const mode of ['am', 'pm', 'day']) {
      seatAlight[mode] = [null, null];
      for (const di of [0, 1]) {
        const { flows, L } = kept[mode][di];
        // 이 모드의 최고 가중일 때 혼잡도 34%(좌석 만석)에 해당하는 적재량
        const seats = (SEAT_FULL * K) / (peak * MODE_MAX[mode]);
        const onboard = new Float64Array(n);
        const phi = new Float64Array(n);
        const last = line.loop ? n : n - 1;
        for (let s = 0; s < last; s++) {
          onboard[s] = 0;
          for (let d = 1; d <= maxSpan; d++) onboard[s] += flows[s * stride + d];
          const first = line.loop ? Math.max(0, s - maxSpan + 1) : 0;
          let left = seats, aTotal = 0, aSeat = 0;
          for (let p = first; p <= s; p++) {
            const ob = onboard[p];
            if (ob <= 0) continue;
            const seatedFrac = Math.max(0, Math.min(ob, left)) / ob;  // 먼저 탄 순서로 착석
            left -= ob;
            const d = s + 1 - p;
            const f = d <= maxSpan ? flows[p * stride + d] : 0;
            aTotal += f;
            aSeat += f * seatedFrac;
          }
          phi[L(s + 1)] = aTotal > 0 ? aSeat / aTotal : 0;
          for (let p = first; p <= s; p++) {
            const d = s + 1 - p;
            if (d <= maxSpan) onboard[p] -= flows[p * stride + d];
          }
        }
        seatAlight[mode][di] = phi;
      }
    }

    out[line.id] = { seg, alight, seatAlight, K, peak, segCount, n };
  }
  return out;
}

export const PROFILES = buildProfiles();

/** 노선 구간 혼잡도(%) — segIdx는 line.stations 기준 구간 번호 */
export function congestionAt(lineId, segIdx, dir, minute, dayType = 'weekday') {
  const p = PROFILES[lineId];
  if (!p || segIdx < 0 || segIdx >= p.segCount) return 0;
  const di = dir === 1 ? 0 : 1;
  const wt = timeWeights(minute, dayType);
  let load = 0;
  for (const mode of ['am', 'pm', 'day']) load += wt[mode] * p.seg[mode][di][segIdx];
  return (p.peak * load) / p.K;
}

/** 특정 역에서 다음 역으로 넘어가는 구간 번호 */
export function segmentIndex(line, stationIdx, dir) {
  const n = line.stations.length;
  if (line.loop) return dir === 1 ? stationIdx : (stationIdx - 1 + n) % n;
  return dir === 1 ? stationIdx : stationIdx - 1;
}

/** 해당 시각 가중으로 혼합한 역별 하차 비율 */
export function alightShareAt(lineId, stationIdx, dir, minute, dayType = 'weekday') {
  const p = PROFILES[lineId];
  if (!p) return 0.1;
  const di = dir === 1 ? 0 : 1;
  const wt = timeWeights(minute, dayType);
  const total = wt.am + wt.pm + wt.day || 1;
  let v = 0;
  for (const mode of ['am', 'pm', 'day']) v += (wt[mode] / total) * p.alight[mode][di][stationIdx];
  return Math.min(0.95, Math.max(0.01, v));
}

/**
 * 역 k 에서 내리는 사람 중 '앉아 있던' 비율 φ.
 * 좌석/입석 구분 없이 같은 하차율을 쓰면 φ = 좌석 비율(34/혼잡도)이 됩니다.
 * 실제로는 멀리서 탄 사람이 앉아 있다가 도심에서 내리므로 그보다 큽니다.
 */
export function seatAlightShareAt(lineId, stationIdx, dir, minute, dayType = 'weekday') {
  const p = PROFILES[lineId];
  if (!p?.seatAlight) return null;
  const di = dir === 1 ? 0 : 1;
  const wt = timeWeights(minute, dayType);
  const total = wt.am + wt.pm + wt.day || 1;
  let v = 0;
  for (const mode of ['am', 'pm', 'day']) v += (wt[mode] / total) * p.seatAlight[mode][di][stationIdx];
  return Math.min(1, Math.max(0, v));
}

export const congestionLevel = (c) =>
  c < 40 ? { key: 'easy', label: '여유', note: '좌석 여유' }
  : c < 80 ? { key: 'ok', label: '보통', note: '입석 여유' }
  : c < 120 ? { key: 'busy', label: '주의', note: '서서 밀착' }
  : c < 150 ? { key: 'tight', label: '혼잡', note: '이동 곤란' }
  : { key: 'full', label: '매우혼잡', note: '승차 실패 가능' };

/**
 * 차내 칸 이동 난이도 — 관통문으로 한 칸 지나갈 때의 체감.
 * 혼잡도가 높으면 통로에 사람이 서 있어 이동 자체가 어렵습니다.
 */
export const moveDifficulty = (c) =>
  c < 70 ? { cost: 0.3, label: '쉬움' }
  : c < 110 ? { cost: 1.0, label: '보통' }
  : c < 150 ? { cost: 2.4, label: '어려움' }
  : { cost: 5.5, label: '거의 불가' };

/** 승차 실패(못 타고 보냄) 확률 */
export const boardingFailure = (c) => Math.min(0.8, Math.max(0, (c - 115) / 80));

/**
 * 착석 확률.
 * 승차 시점에 좌석이 남아 있으면 바로 앉고, 아니면 이후 역마다 생기는
 * 빈 좌석을 주변 입석 승객과 경합해서 얻는다고 봅니다.
 * @param {Array<{congestion:number, alightShare:number, minutes:number}>} stops
 *        승차 이후 통과하는 역(하차역 제외)의 혼잡도/하차비율/잔여 주행시간
 * @param {number} boardCongestion 승차 시점 혼잡도(%)
 */
export function seatChance(boardCongestion, stops, totalMinutes) {
  const immediate = boardCongestion < SEAT_FULL
    ? Math.min(0.93, ((SEAT_FULL - boardCongestion) / SEAT_FULL) * 1.6)
    : 0;
  let notYet = 1 - immediate;
  let seatedMinutes = immediate * totalMinutes;
  const perStop = [];
  for (const s of stops) {
    const seated = Math.min(s.congestion, SEAT_FULL);
    const standees = Math.max(0, s.congestion - SEAT_FULL);
    // 내리는 사람 중 앉아 있던 비율(φ)만큼이 빈 좌석이 됩니다.
    // φ 가 없으면 좌석/입석을 구분하지 않던 예전 가정(= 좌석 비율)으로 돌아갑니다.
    const uniformPhi = s.congestion > 0 ? Math.min(1, SEAT_FULL / s.congestion) : 1;
    const phi = s.seatAlightFrac ?? uniformPhi;
    const freed = Math.min(seated, phi * s.alightShare * s.congestion);
    const p = standees <= 0.5
      ? 0.9
      : Math.min(0.85, freed / (freed + standees * SEAT_COMPETITION));
    const gain = notYet * p;
    seatedMinutes += gain * s.minutes;
    notYet -= gain;
    perStop.push({ ...s, p, cumulative: 1 - notYet });
  }
  return {
    immediate,
    probability: Math.min(0.96, 1 - notYet),
    seatedRatio: totalMinutes > 0 ? seatedMinutes / totalMinutes : 0,
    perStop,
  };
}
