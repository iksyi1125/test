// 트랜스크립트 디렉터리를 감시한다. fs.watch(recursive) 가 되면 즉시, 안 되면 폴링으로.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {import('./transcripts.js').TranscriptStore} store
 * @param {(reason:string)=>void} onChange  이벤트가 추가/삭제되었을 때 호출
 * @param {{pollMs?:number}} opts
 */
export function watchTranscripts(store, onChange, { pollMs = 2000 } = {}) {
  const watchers = [];
  let timer = null;
  let pending = false;

  const flush = (reason) => {
    pending = false;
    if (store.scan()) onChange(reason);
  };
  const schedule = (reason) => {
    if (pending) return;
    pending = true;
    setTimeout(() => flush(reason), 150); // 연속 쓰기를 묶는다
  };

  for (const dir of store.dirs) {
    try {
      const w = fs.watch(dir, { recursive: true }, (_type, filename) => {
        if (filename && !String(filename).endsWith('.jsonl')) return;
        schedule(`watch:${filename ? path.basename(String(filename)) : dir}`);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // 재귀 감시를 지원하지 않는 플랫폼/파일시스템 -> 폴링만 사용
    }
  }
  timer = setInterval(() => flush('poll'), pollMs);
  timer.unref?.();

  return {
    close() {
      for (const w of watchers) w.close();
      if (timer) clearInterval(timer);
    },
    usingWatch: watchers.length > 0,
  };
}
