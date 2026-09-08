// 터미널 실시간 뷰 (--cli)
import { summarize } from './aggregate.js';
import { watchTranscripts } from './watcher.js';

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
const usd = (n) => '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2));
const time = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dur = (ms) => `${Math.floor(ms / 3.6e6)}h ${Math.floor((ms % 3.6e6) / 6e4)}m`;
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

export function runCli(store, { range = 'today', project = '' } = {}) {
  store.scan();
  const render = () => {
    const s = summarize(store.events, { range, project });
    const t = s.totals;
    const lines = [];
    lines.push(`Claude 토큰 사용량  ·  ${new Date(s.now).toLocaleString('ko-KR', { hour12: false })}  ·  범위: ${range}${project ? '  ·  프로젝트: ' + project : ''}`);
    lines.push('─'.repeat(78));
    lines.push(`총 토큰 ${rpad(fmt(t.total), 9)}   입력 ${rpad(fmt(t.input), 8)}   출력 ${rpad(fmt(t.output), 8)}   캐시읽기 ${rpad(fmt(t.cacheRead), 8)}   캐시쓰기 ${rpad(fmt(t.cacheWrite5m + t.cacheWrite1h), 8)}`);
    lines.push(`예상 비용 ${usd(t.cost)}${t.unpriced ? ` (가격 미확인 ${t.unpriced}건 제외)` : ''}   호출 ${t.calls}회   캐시 적중률 ${(t.cacheHitRate * 100).toFixed(1)}%`);
    lines.push('');
    if (s.block) {
      const b = s.block;
      const pct = Math.round((b.elapsedMs / (b.end - b.start)) * 100);
      const bar = '█'.repeat(Math.round(pct / 4)).padEnd(25, '░');
      lines.push(`5시간 창  ${b.active ? '활성' : '비활성'}  ${time(b.start)} → ${time(b.end)}  [${bar}] ${pct}%  남은 시간 ${dur(b.remainingMs)}`);
      lines.push(`          토큰 ${fmt(b.total)}   비용 ${usd(b.cost)}   호출 ${b.calls}회`);
    }
    lines.push(`속도      최근 1분 ${fmt(s.rate.last1m.total)} tok   최근 5분 ${fmt(s.rate.last5m.total)} tok (${fmt(Math.round(s.rate.last5m.total / 5))} tok/min)`);
    lines.push('');
    lines.push(pad('모델', 26) + rpad('토큰', 10) + rpad('출력', 9) + rpad('비용', 11) + rpad('호출', 6));
    for (const m of s.byModel.slice(0, 6)) lines.push(pad(m.model, 26) + rpad(fmt(m.total), 10) + rpad(fmt(m.output), 9) + rpad(usd(m.cost), 11) + rpad(m.calls, 6));
    lines.push('');
    lines.push(pad('최근 호출', 10) + pad('모델', 22) + pad('프로젝트', 16) + rpad('입력', 8) + rpad('캐시R', 8) + rpad('캐시W', 8) + rpad('출력', 7) + rpad('비용', 9));
    for (const e of s.recent.slice(0, 10)) {
      lines.push(
        pad(time(e.ts), 10) + pad(e.model.slice(0, 21), 22) + pad(e.project.slice(0, 15), 16) + rpad(fmt(e.input), 8) + rpad(fmt(e.cacheRead), 8) + rpad(fmt(e.cacheWrite5m + e.cacheWrite1h), 8) + rpad(fmt(e.output), 7) + rpad(e.cost == null ? '?' : usd(e.cost), 9),
      );
    }
    lines.push('');
    lines.push(`감시 중: ${store.dirs.join(', ')}   (Ctrl+C 로 종료)`);
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
  };
  render();
  const w = watchTranscripts(store, render);
  const tick = setInterval(render, 5000); // 남은 시간/속도 갱신
  process.on('SIGINT', () => {
    clearInterval(tick);
    w.close();
    process.stdout.write('\n');
    process.exit(0);
  });
}
