// Claude Code 트랜스크립트(~/.claude/projects/**/*.jsonl)를 증분으로 읽어 usage 이벤트로 바꾼다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { costOf, normalizeModel } from './pricing.js';

/** 기본 트랜스크립트 디렉터리 후보. 존재하는 것만 돌려준다. */
export function defaultTranscriptDirs(env = process.env, home = os.homedir()) {
  const candidates = [];
  if (env.CLAUDE_CONFIG_DIR) candidates.push(path.join(env.CLAUDE_CONFIG_DIR, 'projects'));
  candidates.push(path.join(home, '.claude', 'projects'));
  candidates.push(path.join(home, '.config', 'claude', 'projects'));
  const seen = new Set();
  return candidates.filter((d) => {
    if (seen.has(d)) return false;
    seen.add(d);
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

/** 디렉터리를 재귀적으로 훑어 .jsonl 파일 목록을 돌려준다. */
export function listJsonlFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

/** 트랜스크립트 파일 경로에서 프로젝트 이름을 추정한다 (cwd 가 없을 때의 대비책). */
export function projectFromFile(file) {
  const dir = path.basename(path.dirname(file));
  // 예: "-home-user-test" -> "test"
  const parts = dir.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dir;
}

/**
 * JSONL 한 줄을 usage 이벤트로 바꾼다. assistant 메시지가 아니거나 usage 가 없으면 null.
 * 스트리밍 중 같은 message.id 가 content 블록마다 반복 기록되므로 key 로 중복 제거한다.
 */
export function parseLine(line, file, pricing) {
  if (!line || line.charCodeAt(0) !== 123 /* '{' */) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (o.type !== 'assistant' || !o.message || typeof o.message !== 'object') return null;
  const msg = o.message;
  const u = msg.usage;
  if (!u || typeof u !== 'object') return null;
  const model = normalizeModel(msg.model);
  if (!model || model === '<synthetic>') return null;

  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWriteTotal = num(u.cache_creation_input_tokens);
  let cacheWrite5m = num(u.cache_creation?.ephemeral_5m_input_tokens);
  let cacheWrite1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
  if (cacheWrite5m + cacheWrite1h === 0 && cacheWriteTotal > 0) cacheWrite5m = cacheWriteTotal; // TTL 정보가 없으면 5분으로 간주
  if (input + output + cacheRead + cacheWrite5m + cacheWrite1h === 0) return null;

  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return null;

  const id = msg.id || o.uuid || `${file}:${ts}`;
  const key = `${id}:${o.requestId || ''}`;
  const tokens = { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
  const cost = typeof o.costUSD === 'number' ? o.costUSD : costOf(tokens, model, pricing);

  return {
    key,
    ts,
    file,
    sessionId: o.sessionId || path.basename(file, '.jsonl'),
    project: o.cwd ? path.basename(o.cwd) : projectFromFile(file),
    cwd: o.cwd || null,
    model,
    ...tokens,
    total: input + output + cacheRead + cacheWrite5m + cacheWrite1h,
    cost,
    sidechain: Boolean(o.isSidechain),
    version: o.version || null,
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 파일별 오프셋을 기억하면서 새로 추가된 바이트만 읽는 저장소.
 * scan() 을 호출할 때마다 변경된 파일만 읽고, 이벤트가 추가되었으면 true 를 돌려준다.
 */
export class TranscriptStore {
  constructor({ dirs, pricing } = {}) {
    this.dirs = dirs ?? defaultTranscriptDirs();
    this.pricing = pricing;
    /** @type {Map<string, {offset:number, remainder:Buffer, events:object[]}>} */
    this.files = new Map();
    this.keys = new Set();
    this._events = null; // 정렬된 캐시
  }

  /** 시간순으로 정렬된 전체 이벤트 (캐시됨). */
  get events() {
    if (!this._events) {
      const all = [];
      for (const f of this.files.values()) all.push(...f.events);
      all.sort((a, b) => a.ts - b.ts);
      this._events = all;
    }
    return this._events;
  }

  scan() {
    let changed = false;
    const present = new Set();
    for (const dir of this.dirs) {
      for (const file of listJsonlFiles(dir)) {
        present.add(file);
        if (this._readFile(file)) changed = true;
      }
    }
    // 삭제된 파일의 이벤트는 제거
    for (const file of [...this.files.keys()]) {
      if (!present.has(file)) {
        this._drop(file);
        changed = true;
      }
    }
    if (changed) this._events = null;
    return changed;
  }

  /** 특정 파일 하나만 다시 읽는다 (fs.watch 콜백용). */
  scanFile(file) {
    if (!file.endsWith('.jsonl')) return false;
    let exists = true;
    try {
      fs.statSync(file);
    } catch {
      exists = false;
    }
    const changed = exists ? this._readFile(file) : this.files.has(file) && (this._drop(file), true);
    if (changed) this._events = null;
    return changed;
  }

  _drop(file) {
    const st = this.files.get(file);
    if (!st) return;
    for (const ev of st.events) this.keys.delete(ev.key);
    this.files.delete(file);
  }

  _readFile(file) {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return false;
    }
    let st = this.files.get(file);
    if (!st) {
      st = { offset: 0, remainder: Buffer.alloc(0), events: [] };
      this.files.set(file, st);
    }
    if (size < st.offset) {
      // 파일이 잘렸음 -> 처음부터 다시
      for (const ev of st.events) this.keys.delete(ev.key);
      st.offset = 0;
      st.remainder = Buffer.alloc(0);
      st.events = [];
    }
    if (size === st.offset) return false;

    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const len = size - st.offset;
      const buf = Buffer.allocUnsafe(len);
      let done = 0;
      while (done < len) {
        const n = fs.readSync(fd, buf, done, len - done, st.offset + done);
        if (n === 0) break;
        done += n;
      }
      st.offset += done;
      let data = st.remainder.length ? Buffer.concat([st.remainder, buf.subarray(0, done)]) : buf.subarray(0, done);
      const lastNl = data.lastIndexOf(10);
      if (lastNl === -1) {
        st.remainder = Buffer.from(data);
        return false;
      }
      st.remainder = Buffer.from(data.subarray(lastNl + 1));
      const text = data.subarray(0, lastNl).toString('utf8');
      let added = false;
      for (const line of text.split('\n')) {
        const ev = parseLine(line.trim(), file, this.pricing);
        if (!ev || this.keys.has(ev.key)) continue;
        this.keys.add(ev.key);
        st.events.push(ev);
        added = true;
      }
      return added;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
