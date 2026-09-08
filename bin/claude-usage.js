#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { TranscriptStore, defaultTranscriptDirs } from '../src/transcripts.js';
import { buildPricing } from '../src/pricing.js';
import { createServer } from '../src/server.js';
import { runCli } from '../src/cli.js';

const HELP = `claude-usage — Claude Code 토큰 사용량 실시간 모니터

사용법:
  claude-usage [옵션]            웹 대시보드 실행 (기본 http://127.0.0.1:3141)
  claude-usage --cli             터미널 실시간 뷰

옵션:
  --port <n>        포트 (기본 3141, 환경변수 PORT)
  --host <h>        바인드 주소 (기본 127.0.0.1)
  --dir <path>      트랜스크립트 디렉터리 (여러 번 지정 가능, 기본 ~/.claude/projects)
  --pricing <json>  모델 가격 덮어쓰기 파일
  --range <r>       CLI 모드 범위: today | 7d | 30d | all (기본 today)
  --project <name>  CLI 모드 프로젝트 필터
  -h, --help        도움말
`;

function parseArgs(argv) {
  const o = { dirs: [], port: Number(process.env.PORT) || 3141, host: '127.0.0.1', cli: false, range: 'today', project: '', pricing: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') o.port = Number(next());
    else if (a === '--host') o.host = next();
    else if (a === '--dir') o.dirs.push(path.resolve(next()));
    else if (a === '--pricing') o.pricing = path.resolve(next());
    else if (a === '--range') o.range = next();
    else if (a === '--project') o.project = next();
    else if (a === '--cli') o.cli = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      process.stderr.write(`알 수 없는 옵션: ${a}\n\n${HELP}`);
      process.exit(1);
    }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const dirs = opts.dirs.length ? opts.dirs : defaultTranscriptDirs();
if (!dirs.length) {
  process.stderr.write('트랜스크립트 디렉터리를 찾지 못했습니다. Claude Code 를 한 번 실행했거나 --dir 로 경로를 지정하세요.\n');
  process.exit(1);
}
let pricing;
if (opts.pricing) {
  pricing = buildPricing(JSON.parse(fs.readFileSync(opts.pricing, 'utf8')));
}
const store = new TranscriptStore({ dirs, pricing });

if (opts.cli) {
  runCli(store, { range: opts.range, project: opts.project });
} else {
  const server = createServer(store, { log: (m) => console.log(`[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${m}`) });
  server.listen(opts.port, opts.host, () => {
    console.log(`Claude 토큰 사용량 대시보드: http://${opts.host}:${opts.port}`);
    console.log(`감시 디렉터리: ${dirs.join(', ')}  (이벤트 ${store.events.length}건 로드)`);
  });
}
