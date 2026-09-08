import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, TranscriptStore } from '../src/transcripts.js';
import { summarize, currentBlock } from '../src/aggregate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'sample.jsonl');

test('parseLine extracts usage and cache tiers', () => {
  const line = fs.readFileSync(fixture, 'utf8').split('\n')[1];
  const ev = parseLine(line, fixture);
  assert.equal(ev.model, 'claude-fable-5-1');
  assert.equal(ev.input, 2);
  assert.equal(ev.cacheWrite1h, 17330);
  assert.equal(ev.cacheWrite5m, 0);
  assert.equal(ev.cacheRead, 38641);
  assert.equal(ev.output, 312);
  assert.equal(ev.project, 'test');
  assert.equal(ev.key, 'msg_1:req_1');
  assert.ok(ev.cost > 0);
});

test('parseLine ignores non-assistant, synthetic and garbage lines', () => {
  assert.equal(parseLine('not json', fixture), null);
  assert.equal(parseLine('{"type":"user"}', fixture), null);
  assert.equal(parseLine('{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":1}}}', fixture), null);
});

test('TranscriptStore dedupes streamed duplicates and reads incrementally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
  const sub = path.join(dir, '-home-user-test');
  fs.mkdirSync(sub);
  const file = path.join(sub, 'session.jsonl');
  const lines = fs.readFileSync(fixture, 'utf8').split('\n');
  fs.writeFileSync(file, lines.slice(0, 4).join('\n') + '\n');

  const store = new TranscriptStore({ dirs: [dir] });
  assert.equal(store.scan(), true);
  assert.equal(store.events.length, 2, 'msg_1 duplicate collapsed, msg_2 kept');
  assert.equal(store.scan(), false, 'no change -> false');

  // 부분 줄 -> 아직 이벤트 없음, 나머지가 오면 완성
  const [head, tail] = [lines[5].slice(0, 40), lines[5].slice(40)];
  fs.appendFileSync(file, head);
  assert.equal(store.scan(), false);
  fs.appendFileSync(file, tail + '\n' + lines[4] + '\n' + lines[6] + '\n');
  assert.equal(store.scan(), true);
  assert.equal(store.events.length, 3);
  assert.equal(store.events[2].cost, null, 'unknown model has null cost');

  // 잘림 -> 다시 읽기
  fs.writeFileSync(file, lines[1] + '\n');
  assert.equal(store.scan(), true);
  assert.equal(store.events.length, 1);

  // 삭제
  fs.rmSync(file);
  assert.equal(store.scan(), true);
  assert.equal(store.events.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('summarize aggregates by model/day/session and flags unpriced', () => {
  const store = new TranscriptStore({ dirs: [path.dirname(fixture)] });
  store.scan();
  const now = Date.parse('2026-09-08T12:00:00.000Z');
  const s = summarize(store.events, { range: 'all', now });
  assert.equal(s.totals.calls, 3);
  assert.equal(s.totals.unpriced, 1);
  assert.deepEqual(s.projects, ['other', 'test']);
  assert.equal(s.byModel[0].model, 'claude-fable-5-1');
  assert.equal(s.sessions.length, 2);
  assert.equal(s.sessions[0].sessionId, 's2');
  assert.equal(s.recent[0].model, 'claude-unknown-9');
  assert.equal(s.hours.length, 24);

  const filtered = summarize(store.events, { range: 'all', project: 'other', now });
  assert.equal(filtered.totals.calls, 2);
});

test('currentBlock opens a new 5h window after a gap', () => {
  const H = 3_600_000;
  const t0 = Date.parse('2026-09-08T04:13:18.903Z');
  const ev = (ts, total) => ({ ts, model: 'm', input: total, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, total, cost: 0 });
  const events = [ev(t0, 10), ev(t0 + H, 20), ev(t0 + 7 * H, 5)];
  const b = currentBlock(events, t0 + 7 * H + 60_000);
  assert.equal(b.start, Math.floor((t0 + 7 * H) / H) * H);
  assert.equal(b.total, 5);
  assert.equal(b.active, true);
  const old = currentBlock(events.slice(0, 2), t0 + 2 * H);
  assert.equal(old.total, 30);
  assert.equal(old.start, Math.floor(t0 / H) * H);
});
