// 모델별 가격표 (USD / 1M tokens). 캐시 쓰기는 5분 TTL = 입력가 x1.25, 1시간 TTL = 입력가 x2.
// 캐시 읽기는 입력가 x0.1 (Fable 5.1 계열은 $0.25 고정).
// 새 모델이나 다른 가격을 쓰려면 --pricing <json> 으로 덮어쓸 수 있다 (README 참고).

export const DEFAULT_PRICING = [
  { id: 'claude-fable-5-1', match: /^claude-(fable|mythos)-5-1/, input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  { id: 'claude-fable-5', match: /^claude-(fable|mythos)-5/, input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  { id: 'claude-opus-5', match: /^claude-opus-(5|4-8|4-7|4-6|4-5)/, input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  { id: 'claude-opus-4', match: /^claude-opus-4/, input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  { id: 'claude-sonnet-5', match: /^claude-sonnet-5/, input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  { id: 'claude-sonnet-4', match: /^claude-(sonnet-4|sonnet-3|3-7-sonnet|3-5-sonnet)/, input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  { id: 'claude-haiku-4-5', match: /^claude-haiku-4/, input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  { id: 'claude-haiku-3-5', match: /^claude-(3-5-haiku|haiku-3-5)/, input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
  { id: 'claude-haiku-3', match: /^claude-(3-haiku|haiku-3)/, input: 0.25, output: 1.25, cacheWrite5m: 0.3, cacheWrite1h: 0.5, cacheRead: 0.03 },
];

/** Bedrock/Vertex 스타일 접두어를 떼고 소문자로 정규화한다. */
export function normalizeModel(model) {
  if (!model || typeof model !== 'string') return '';
  let m = model.trim().toLowerCase();
  m = m.replace(/^(us|eu|apac|global)\./, '').replace(/^anthropic\./, '');
  m = m.replace(/@\d{8}$/, ''); // Vertex 날짜 구분자
  return m;
}

/** 사용자 JSON 파일로 가격을 덮어쓴다. { "claude-foo": { input, output, cacheWrite5m, cacheWrite1h, cacheRead } } */
export function buildPricing(overrides) {
  if (!overrides) return DEFAULT_PRICING;
  const extra = Object.entries(overrides).map(([id, p]) => {
    const input = Number(p.input ?? 0);
    return {
      id,
      match: new RegExp('^' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      input,
      output: Number(p.output ?? 0),
      cacheWrite5m: Number(p.cacheWrite5m ?? input * 1.25),
      cacheWrite1h: Number(p.cacheWrite1h ?? input * 2),
      cacheRead: Number(p.cacheRead ?? input * 0.1),
    };
  });
  return [...extra, ...DEFAULT_PRICING];
}

export function findPrice(model, pricing = DEFAULT_PRICING) {
  const m = normalizeModel(model);
  if (!m) return null;
  return pricing.find((p) => p.match.test(m)) ?? null;
}

/**
 * 토큰 수 -> USD. 가격표에 없는 모델이면 null 을 돌려주고, 호출자가 "미확인" 으로 표시한다.
 * @param {{input:number, output:number, cacheRead:number, cacheWrite5m:number, cacheWrite1h:number}} u
 */
export function costOf(u, model, pricing = DEFAULT_PRICING) {
  const p = findPrice(model, pricing);
  if (!p) return null;
  const per = 1_000_000;
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite5m * p.cacheWrite5m +
      u.cacheWrite1h * p.cacheWrite1h) /
    per
  );
}
