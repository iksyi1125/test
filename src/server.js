// 정적 대시보드 + JSON API + SSE(Server-Sent Events) 를 제공하는 HTTP 서버.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, RANGES } from './aggregate.js';
import { watchTranscripts } from './watcher.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createServer(store, { log = () => {} } = {}) {
  const clients = new Set();
  let version = 0;

  const broadcast = (reason) => {
    version += 1;
    const payload = `event: change\ndata: ${JSON.stringify({ version, reason, at: Date.now() })}\n\n`;
    for (const res of clients) res.write(payload);
  };

  store.scan();
  const watcher = watchTranscripts(store, (reason) => {
    log(`변경 감지 (${reason}) → 이벤트 ${store.events.length}건`);
    broadcast(reason);
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/summary') {
      const range = url.searchParams.get('range') || 'today';
      const project = url.searchParams.get('project') || '';
      const body = JSON.stringify({
        ...summarize(store.events, { range: RANGES.includes(range) ? range : 'today', project }),
        version,
        dirs: store.dirs,
        usingWatch: watcher.usingWatch,
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    if (p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ version, at: Date.now() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (p === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, events: store.events.length, clients: clients.size, dirs: store.dirs }));
      return;
    }

    // 정적 파일
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });

  server.on('close', () => watcher.close());
  return server;
}
