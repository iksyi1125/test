// 이벤트 목록 -> 대시보드/CLI 가 쓰는 요약 객체.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const BLOCK_MS = 5 * HOUR; // 구독 요금제 5시간 사용량 창

export const RANGES = ['today', '7d', '30d', 'all'];

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, total: 0, cost: 0, calls: 0, unpriced: 0 };
}

function add(acc, ev) {
  acc.input += ev.input;
  acc.output += ev.output;
  acc.cacheRead += ev.cacheRead;
  acc.cacheWrite5m += ev.cacheWrite5m;
  acc.cacheWrite1h += ev.cacheWrite1h;
  acc.total += ev.total;
  acc.calls += 1;
  if (ev.cost == null) acc.unpriced += 1;
  else acc.cost += ev.cost;
  return acc;
}

/** 로컬 자정 (ms) */
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function rangeStart(range, now) {
  switch (range) {
    case 'today':
      return startOfDay(now);
    case '7d':
      return startOfDay(now) - 6 * DAY;
    case '30d':
      return startOfDay(now) - 29 * DAY;
    default:
      return -Infinity;
  }
}

/**
 * 5시간 사용량 창 계산. 첫 호출 시각을 정시로 내림한 것이 창의 시작이며,
 * 창이 끝나거나 5시간 이상 쉬면 새 창이 열린다. 현재 시각이 창 안이면 활성.
 */
export function currentBlock(events, now) {
  if (!events.length) return null;
  let start = null;
  let last = null;
  let acc = zero();
  let models = new Map();
  for (const ev of events) {
    if (start === null || ev.ts >= start + BLOCK_MS || ev.ts - last >= BLOCK_MS) {
      start = Math.floor(ev.ts / HOUR) * HOUR;
      acc = zero();
      models = new Map();
    }
    add(acc, ev);
    models.set(ev.model, add(models.get(ev.model) ?? zero(), ev));
    last = ev.ts;
  }
  const end = start + BLOCK_MS;
  const active = now >= start && now < end && now - last < BLOCK_MS;
  return {
    start,
    end,
    active,
    lastActivity: last,
    elapsedMs: Math.min(Math.max(now - start, 0), BLOCK_MS),
    remainingMs: Math.max(end - now, 0),
    ...acc,
    byModel: [...models.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.total - a.total),
  };
}

export function summarize(allEvents, { range = 'today', project = '', now = Date.now() } = {}) {
  const from = rangeStart(RANGES.includes(range) ? range : 'today', now);
  const projects = [...new Set(allEvents.map((e) => e.project))].sort();
  const scoped = project ? allEvents.filter((e) => e.project === project) : allEvents;
  const events = scoped.filter((e) => e.ts >= from);

  const totals = zero();
  const byModel = new Map();
  const byDay = new Map();
  const bySession = new Map();
  for (const ev of events) {
    add(totals, ev);
    byModel.set(ev.model, add(byModel.get(ev.model) ?? zero(), ev));
    const dk = dayKey(ev.ts);
    byDay.set(dk, add(byDay.get(dk) ?? zero(), ev));
    let s = bySession.get(ev.sessionId);
    if (!s) {
      s = { sessionId: ev.sessionId, project: ev.project, cwd: ev.cwd, firstTs: ev.ts, lastTs: ev.ts, models: new Set(), ...zero() };
      bySession.set(ev.sessionId, s);
    }
    add(s, ev);
    s.lastTs = Math.max(s.lastTs, ev.ts);
    s.firstTs = Math.min(s.firstTs, ev.ts);
    s.models.add(ev.model);
  }

  // 일별: 범위가 있으면 빈 날도 0 으로 채운다. 전체 범위는 첫 이벤트부터 최대 365일.
  const days = [];
  const firstTs = events.length ? events[0].ts : now;
  let dayFrom = Number.isFinite(from) ? from : startOfDay(firstTs);
  dayFrom = Math.max(dayFrom, startOfDay(now) - 364 * DAY);
  for (let t = dayFrom; t <= now; t += DAY) {
    const k = dayKey(t);
    days.push({ day: k, ...(byDay.get(k) ?? zero()) });
  }

  // 최근 24시간, 시간별 (프로젝트 필터만 적용)
  const hourFrom = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  const hours = Array.from({ length: 24 }, (_, i) => ({ hour: hourFrom + i * HOUR, ...zero() }));
  for (const ev of scoped) {
    if (ev.ts < hourFrom) continue;
    const idx = Math.min(23, Math.floor((ev.ts - hourFrom) / HOUR));
    add(hours[idx], ev);
  }

  // 실시간 속도: 최근 1분 / 5분
  const rate = { last1m: zero(), last5m: zero() };
  for (let i = scoped.length - 1; i >= 0; i--) {
    const ev = scoped[i];
    if (ev.ts < now - 5 * 60_000) break;
    add(rate.last5m, ev);
    if (ev.ts >= now - 60_000) add(rate.last1m, ev);
  }

  const sessions = [...bySession.values()]
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, 50)
    .map((s) => ({ ...s, models: [...s.models] }));

  const recent = scoped.slice(-30).reverse();

  const cacheable = totals.input + totals.cacheRead + totals.cacheWrite5m + totals.cacheWrite1h;
  return {
    now,
    range,
    project,
    projects,
    from: Number.isFinite(from) ? from : null,
    totals: { ...totals, cacheHitRate: cacheable ? totals.cacheRead / cacheable : 0 },
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.total - a.total),
    days,
    hours,
    rate,
    block: currentBlock(scoped, now),
    sessions,
    recent,
    eventCount: allEvents.length,
  };
}
