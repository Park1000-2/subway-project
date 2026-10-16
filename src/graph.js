/**
 * graph.js — 역/노선 그래프와 경로 탐색
 * 노드는 (호선, 역) 쌍입니다. 같은 역에서 호선을 바꾸는 비용이 환승 비용.
 */
import { LINES, EXTRA_TRANSFERS, TRANSFER_WALK, DEFAULT_TRANSFER_WALK, HOP_MINUTES } from './network.js';

export const hopMinutes = (lineId) => HOP_MINUTES[lineId] ?? HOP_MINUTES.default;
export const lineById = new Map(LINES.map((l) => [l.id, l]));

/** 역명 → [{lineId, idx}] */
export const stationIndex = (() => {
  const m = new Map();
  for (const line of LINES) {
    line.stations.forEach((name, idx) => {
      if (!m.has(name)) m.set(name, []);
      m.get(name).push({ lineId: line.id, idx });
    });
  }
  return m;
})();

export const ALL_STATIONS = [...stationIndex.keys()].sort((a, b) => a.localeCompare(b, 'ko'));

/** 역명이 다른 환승 쌍: '역A' → [{to, walk}] */
const NAMED_TRANSFERS = (() => {
  const m = new Map();
  for (const [a, b, walk] of EXTRA_TRANSFERS) {
    if (!m.has(a)) m.set(a, []);
    if (!m.has(b)) m.set(b, []);
    m.get(a).push({ to: b, walk });
    m.get(b).push({ to: a, walk });
  }
  return m;
})();

export const transferWalk = (station) => TRANSFER_WALK[station] ?? DEFAULT_TRANSFER_WALK;

/** 평균 대기시간 = 배차간격 / 2 (경로 탐색용 명목값) */
const nominalWait = (line) => (line.headway.peak + line.headway.day) / 4;

const key = (lineId, station) => `${lineId}|${station}`;

/**
 * 경로 탐색 (다익스트라).
 * @param {'fast'|'minTransfer'} mode  fast=최소 시간, minTransfer=최소 환승
 * @returns {{legs:Array, transfers:number, rideMinutes:number}|null}
 */
export function findRoute(from, to, mode = 'fast') {
  if (from === to || !stationIndex.has(from) || !stationIndex.has(to)) return null;
  const transferPenalty = mode === 'minTransfer' ? 22 : 0;

  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  const queue = [];
  const push = (k, d, p) => {
    if (dist.has(k) && dist.get(k) <= d) return;
    dist.set(k, d);
    prev.set(k, p);
    queue.push([d, k]);
  };

  for (const { lineId } of stationIndex.get(from)) {
    const line = lineById.get(lineId);
    push(key(lineId, from), nominalWait(line), null);
  }

  let endKey = null;
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, k] = queue.shift();
    if (visited.has(k)) continue;
    visited.add(k);
    const [lineId, station] = k.split('|');
    if (station === to) { endKey = k; break; }

    const line = lineById.get(lineId);
    const n = line.stations.length;
    const idx = line.stations.indexOf(station);

    // 같은 노선 인접역
    for (const step of [-1, 1]) {
      let next = idx + step;
      if (line.loop) next = (next + n) % n;
      if (next < 0 || next >= n) continue;
      push(key(lineId, line.stations[next]), d + hopMinutes(lineId), { from: k, kind: 'ride' });
    }

    // 같은 역에서 환승
    const targets = [
      ...stationIndex.get(station).map((s) => ({ lineId: s.lineId, station, walk: transferWalk(station) })),
      ...(NAMED_TRANSFERS.get(station) ?? []).flatMap(({ to: alt, walk }) =>
        (stationIndex.get(alt) ?? []).map((s) => ({ lineId: s.lineId, station: alt, walk }))),
    ];
    for (const t of targets) {
      if (t.lineId === lineId) continue;
      const toLine = lineById.get(t.lineId);
      const sameGroup = toLine.group === line.group;
      const cost = (sameGroup ? 0.5 : t.walk) + nominalWait(toLine) + (sameGroup ? 0 : transferPenalty);
      push(key(t.lineId, t.station), d + cost, { from: k, kind: 'transfer', walk: sameGroup ? 0.5 : t.walk, sameGroup });
    }
  }
  if (!endKey) return null;

  // 경로 역추적 → 레그 단위로 묶기
  const steps = [];
  for (let k = endKey; k; ) {
    const p = prev.get(k);
    if (!p) break;
    steps.push({ to: k, ...p });
    k = p.from;
  }
  steps.reverse();

  const legs = [];
  let current = null;
  const startLine = (steps[0]?.from ?? endKey).split('|')[0];
  current = { lineId: startLine, path: [(steps[0]?.from ?? endKey).split('|')[1]], transferWalk: 0, sameGroup: false };
  for (const s of steps) {
    const [lineId, station] = s.to.split('|');
    if (s.kind === 'ride') {
      current.path.push(station);
    } else {
      legs.push(current);
      current = { lineId, path: [station], transferWalk: s.walk, sameGroup: s.sameGroup };
    }
  }
  legs.push(current);

  const real = legs.filter((l) => l.path.length > 1 || legs.length === 1);
  const enriched = real.map((leg) => {
    const line = lineById.get(leg.lineId);
    const n = line.stations.length;
    const i0 = line.stations.indexOf(leg.path[0]);
    const i1 = line.stations.indexOf(leg.path[leg.path.length - 1]);
    let dir = i1 >= i0 ? 1 : -1;
    if (line.loop) {
      const fwd = (i1 - i0 + n) % n;
      dir = fwd <= n - fwd ? 1 : -1;
    }
    return {
      lineId: leg.lineId,
      line,
      from: leg.path[0],
      to: leg.path[leg.path.length - 1],
      stations: leg.path,
      hops: leg.path.length - 1,
      dir,
      startIdx: i0,
      transferWalk: leg.transferWalk,
      sameGroup: leg.sameGroup,
      rideMinutes: (leg.path.length - 1) * hopMinutes(leg.lineId),
    };
  });

  return {
    legs: enriched,
    transfers: enriched.filter((l, i) => i > 0 && !l.sameGroup).length,
    rideMinutes: enriched.reduce((s, l) => s + l.rideMinutes, 0),
  };
}
