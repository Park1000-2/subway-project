/**
 * planner.js — 경로 + 시각표 + 혼잡도를 묶어 '몇 시 열차를 탈지' 추천
 */
import { findRoute, hopMinutes } from './graph.js';
import { departures, headwayAt } from './schedule.js';
import {
  congestionAt, segmentIndex, alightShareAt, seatAlightShareAt, seatChance,
  carFactors, boardingFailure, congestionLevel, moveDifficulty,
} from './congestion.js';
import { lookupTransferCar } from './transfer-cars.js';

/** 역 기준 출발 시각 목록 — 노선 시각표에 기점~해당역 주행시간을 더한 위상 */
function stationDepartures(line, stationIdx, dir, dayType) {
  const hop = hopMinutes(line.id);
  const n = line.stations.length;
  const phase = (dir === 1 ? stationIdx : n - 1 - stationIdx) * hop;
  return departures(line, dayType).map((t) => t + phase);
}

function nextAt(line, stationIdx, dir, dayType, after) {
  return stationDepartures(line, stationIdx, dir, dayType).find((t) => t >= after - 0.01) ?? null;
}

/**
 * 레그의 기본 프로파일 — 칸 보정 없이 역별 혼잡도/하차비율을 한 번만 계산합니다.
 * 칸별 평가는 이 결과에 보정계수를 곱해서 재사용합니다.
 */
function legProfile(leg, boardTime, dayType) {
  const { line, dir, stations, hops } = leg;
  const hop = hopMinutes(line.id);
  const n = line.stations.length;
  const idxOf = (k) => (line.loop
    ? (((leg.startIdx + dir * k) % n) + n) % n
    : line.stations.indexOf(stations[k]));

  const boardCongestion = congestionAt(line.id, segmentIndex(line, leg.startIdx, dir), dir, boardTime, dayType);
  const stops = [];
  let maxCongestion = boardCongestion;
  for (let k = 1; k < hops; k++) {
    const i = idxOf(k);
    const t = boardTime + k * hop;
    const c = congestionAt(line.id, segmentIndex(line, i, dir), dir, t, dayType);
    maxCongestion = Math.max(maxCongestion, c);
    stops.push({ index: k, station: stations[k], minute: t, congestion: c,
      alightShare: alightShareAt(line.id, i, dir, t, dayType),
      seatAlightFrac: seatAlightShareAt(line.id, i, dir, t, dayType) });
  }
  return { boardCongestion, maxCongestion, stops, hop, arriveMinute: boardTime + hops * hop };
}

/**
 * 한 칸에 대한 착석 평가.
 * untilIndex 를 주면 그 역에서 자리를 뜬다고 보고(= 칸 이동) 그 전까지만 계산합니다.
 */
function seatForCar(profile, boardTime, factor, untilIndex = Infinity) {
  const endMinute = untilIndex === Infinity
    ? profile.arriveMinute
    : (profile.stops.find((s) => s.index === untilIndex)?.minute ?? profile.arriveMinute);
  const stops = profile.stops
    .filter((s) => s.index < untilIndex)
    .map((s) => ({ ...s, congestion: s.congestion * factor, minutes: endMinute - s.minute }));
  return seatChance(profile.boardCongestion * factor, stops, Math.max(1, endMinute - boardTime));
}

/** 레그 전체 요약(칸 구분 없음) */
function evaluateLeg(leg, boardTime, dayType) {
  const profile = legProfile(leg, boardTime, dayType);
  const stops = profile.stops.map((s) => ({ ...s, minutes: profile.arriveMinute - s.minute }));
  const seat = seatChance(profile.boardCongestion, stops, leg.rideMinutes);
  return {
    boardCongestion: profile.boardCongestion,
    maxCongestion: profile.maxCongestion,
    seat,
    failure: boardingFailure(profile.boardCongestion),
    profile,
  };
}

/**
 * 승차 칸 계획.
 * 하차 칸(빠른 환승 위치)이 정해져 있어도 거기 그대로 탈 필요는 없습니다.
 * 한산한 칸에 타서 앉아 가다가, 내리기 전에 차내로 이동하면 됩니다.
 * 그 맞바꿈을 칸마다 계산합니다.
 */
function planCars(leg, nextLeg, boardTime, dayType, profile) {
  const cars = leg.line.cars;
  const factors = carFactors(cars);
  const transfer = nextLeg
    ? lookupTransferCar(leg.to, leg.line.group, leg.dir, nextLeg.line.group, nextLeg.dir)
    : null;
  const targetCar = transfer?.exitCar >= 1 && transfer.exitCar <= cars ? transfer.exitCar : null;

  // 칸 이동은 최대한 늦게 — 일찍 옮기면 앉은 자리를 그만큼 일찍 버립니다.
  // 마지막 네 정거장 중, 통로가 막히지 않는 가장 늦은 시점을 고릅니다.
  const tail = profile.stops.filter((s) => s.index >= Math.max(1, leg.hops - 4));
  const passable = tail.filter((s) => moveDifficulty(s.congestion).cost < 5);
  const moveAt = passable.length
    ? passable[passable.length - 1]
    : tail.length
      ? tail.reduce((a, b) => (b.congestion < a.congestion ? b : a))
      : null;
  const crowdedAllTheWay = tail.length > 0 && passable.length === 0;

  const perCar = factors.map((f, i) => {
    const car = i + 1;
    const moveCars = targetCar ? Math.abs(car - targetCar) : 0;
    // 이동 시점의 혼잡도로 난이도를 봅니다(그때 통로를 지나가야 하므로)
    const diff = moveDifficulty((moveAt?.congestion ?? profile.maxCongestion) * f);
    const full = seatForCar(profile, boardTime, f);
    const untilMove = moveCars > 0 && moveAt ? seatForCar(profile, boardTime, f, moveAt.index) : full;
    return {
      car, factor: f,
      congestion: profile.boardCongestion * f,
      seat: full.probability,
      seatIfMoving: untilMove.probability,
      seatedRatio: moveCars > 0 && moveAt
        ? (untilMove.seatedRatio * (moveAt.minute - boardTime)) / Math.max(1, leg.rideMinutes)
        : full.seatedRatio,
      moveCars,
      moveCost: moveCars * diff.cost,
      moveLabel: diff.label,
    };
  });

  const minC = Math.min(...perCar.map((c) => c.congestion));
  const quietCars = perCar.filter((c) => c.congestion <= minC * 1.03);
  const score = (c) => c.seatIfMoving * 100 - c.moveCost * 4;
  const balanced = perCar.reduce((a, b) => (score(b) > score(a) ? b : a));
  const stay = targetCar ? perCar[targetCar - 1] : null;
  const maxSeat = perCar.reduce((a, b) => (b.seatIfMoving > a.seatIfMoving ? b : a));

  return {
    perCar, quietCars, quietest: quietCars[0], transfer, targetCar,
    transferCar: stay, stay, balanced, maxSeat, moveAt, crowdedAllTheWay,
  };
}

/** 특정 승차 시각에 대한 전체 여정 평가 */
export function evaluateJourney(route, boardTime, dayType = 'weekday') {
  const legs = [];
  let t = boardTime;
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i];
    const depart = i === 0 ? boardTime : nextAt(leg.line, leg.startIdx, leg.dir, dayType, t);
    if (depart == null) return null;
    const wait = i === 0 ? 0 : depart - t;
    const arrive = depart + leg.rideMinutes;
    const ev = evaluateLeg(leg, depart, dayType);
    const car = planCars(leg, route.legs[i + 1], depart, dayType, ev.profile);
    legs.push({ ...leg, depart, arrive, wait, ...ev, car, headway: headwayAt(leg.line, depart, dayType) });
    // 환승 도보시간은 실데이터(소요시간)가 있으면 그것을 씁니다
    const nextLeg = route.legs[i + 1];
    if (nextLeg) {
      const walk = car.transfer?.minutes ?? nextLeg.transferWalk;
      legs[i].walkToNext = walk;
      t = arrive + walk;
    }
  }
  const rideTotal = legs.reduce((s, l) => s + l.rideMinutes, 0);
  const arrival = legs[legs.length - 1].arrive;
  const seatedRatio = legs.reduce((s, l) => s + l.seat.seatedRatio * l.rideMinutes, 0) / (rideTotal || 1);
  const sitChance = 1 - legs.reduce((p, l) => p * (1 - l.seat.probability), 1);
  const failRisk = 1 - legs.reduce((p, l) => p * (1 - l.failure), 1);
  const worst = Math.max(...legs.map((l) => l.maxCongestion));
  return {
    boardTime, arrival, legs,
    totalMinutes: arrival - boardTime,
    rideTotal,
    seatedRatio, sitChance, failRisk,
    worstCongestion: worst,
    level: congestionLevel(worst),
    firstLegCongestion: legs[0].boardCongestion,
  };
}

/**
 * 출퇴근 열차 추천.
 *
 * 두 기준의 제약이 서로 반대입니다.
 *   출근(arrive) — 목표 시각까지 **도착**해야 하고, 그렇다고 너무 일찍 나서긴 싫다.
 *   퇴근(depart) — 회사에서 나서는 시각 **이후**에만 탈 수 있고, 그렇다고 역에서 오래 기다리긴 싫다.
 * 둘 다 '제약을 지키는 열차 중, 불필요한 비용(이른 출발 / 긴 대기)이 작고 앉을 가능성이 큰 열차'
 * 를 고르는 문제라 점수식은 공유합니다.
 *
 * @param {object} o
 * @param {'arrive'|'depart'} o.basis 기준
 * @param {number} o.anchor  arrive=목표 도착 시각, depart=회사에서 나서는 시각 (분)
 * @param {number} o.walk    역까지 도보(분) — depart 기준에서 승차 가능 시각을 늦춥니다
 * @param {number} o.buffer  arrive 전용: 목표 시각보다 최소 몇 분 먼저 도착할지
 * @param {number} o.window  arrive=최대 일찍 도착(분), depart=최대 대기(분)
 */
export function planCommute({
  from, to, anchor, basis = 'arrive', dayType = 'weekday', mode = 'fast',
  buffer = 10, window: windowMin = 45, walk = 0, lookback = 150,
}) {
  const route = findRoute(from, to, mode);
  if (!route) return { route: null, options: [] };

  const leg0 = route.legs[0];
  const earliestBoard = anchor + walk;           // depart 기준: 역에 닿는 가장 이른 시각
  const all = stationDepartures(leg0.line, leg0.startIdx, leg0.dir, dayType).filter((t) =>
    basis === 'arrive'
      ? t >= anchor - lookback && t <= anchor + 30
      : t >= earliestBoard - 1 && t <= earliestBoard + windowMin + 60);

  const options = [];
  for (const t of all) {
    const j = evaluateJourney(route, t, dayType);
    if (!j) continue;
    if (basis === 'arrive') {
      j.slack = anchor - j.arrival;              // 목표 시각까지 남는 여유(분)
      j.wait = 0;
      j.onTime = j.slack >= buffer;
      j.outOfWindow = j.slack > windowMin;
      j.cost = Math.max(0, j.slack - buffer);
    } else {
      j.wait = j.boardTime - earliestBoard;      // 역에서 기다리는 시간(분)
      j.slack = 0;
      j.onTime = j.wait >= -0.01;                // 나서기 전 열차는 탈 수 없음
      j.outOfWindow = j.wait > windowMin;
      j.cost = Math.max(0, j.wait);
    }
    options.push(j);
  }

  for (const o of options) {
    o.score = o.seatedRatio * 100 - o.failRisk * 65 - o.cost * 0.22
      - (o.onTime ? 0 : 1000) - (o.outOfWindow ? 1000 : 0);
  }
  const ranked = [...options].sort((a, b) => b.score - a.score);
  options.sort((a, b) => a.boardTime - b.boardTime);
  const best = ranked.find((o) => o.onTime && !o.outOfWindow) ?? ranked[0] ?? null;

  // 창 밖이지만 눈에 띄게 더 앉을 수 있는 열차 — 희생이 가장 적은 것 하나
  const alternative = best
    ? [...options]
        .filter((o) => {
          if (!o.onTime || !o.outOfWindow) return false;
          const gain = o.sitChance - best.sitChance;
          const extra = Math.abs(o.cost - best.cost);
          return gain > 0.15 && extra > 0 && (gain * 100) / (extra / 10) >= 3;
        })
        .sort((a, b) => a.cost - b.cost)[0] ?? null
    : null;

  return { route, options, ranked, best, alternative, basis, earliestBoard };
}
