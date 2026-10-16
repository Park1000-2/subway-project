/**
 * schedule.js — 열차 시각표 (배차간격 기반 추정)
 * 실데이터로 교체: 서울교통공사 '열차시간표' OpenAPI (상하행·주말 구분 제공)
 */
export const PEAK_WINDOWS = {
  weekday: [[420, 540], [1050, 1170]], // 07:00-09:00, 17:30-19:30
  sat: [],
  sun: [],
};

export function headwayAt(line, minute, dayType = 'weekday') {
  const h = line.headway;
  const peaks = PEAK_WINDOWS[dayType] ?? [];
  const inPeak = peaks.some(([a, b]) => minute >= a && minute < b);
  const base = inPeak ? h.peak : minute >= 1350 || minute < 390 ? h.late : h.day;
  return dayType === 'weekday' ? base : base * 1.18;
}

/** 해당 노선의 출발 시각 목록(분) — firstTrain부터 배차간격을 누적 */
export function departures(line, dayType = 'weekday', until = 1500) {
  const out = [];
  let t = line.firstTrain + (dayType === 'weekday' ? 0 : 8);
  while (t <= until) {
    out.push(Math.round(t * 10) / 10);
    t += headwayAt(line, t, dayType);
  }
  return out;
}

/** t분 이후 첫 열차 */
export function nextDeparture(line, t, dayType = 'weekday') {
  const list = departures(line, dayType);
  return list.find((d) => d >= t - 0.01) ?? null;
}

export const toHHMM = (m) => {
  const mm = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
};

export const parseHHMM = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
};
