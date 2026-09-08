#!/usr/bin/env node
// 단일 HTML 파일(브라우저 전용 버전)을 만든다.
//   node scripts/build-standalone.mjs                       -> standalone/index.html (예시 데이터 내장)
//   node scripts/build-standalone.mjs --sample <dir> --label "내 기록"   -> 해당 디렉터리의 실제 기록을 내장
//   --artifact <out>   문서 골격(doctype/html/head/body) 없이 본문만 출력 (호스팅용)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptStore } from '../src/transcripts.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

// 샘플 데이터
let sampleDir = opt('--sample', null);
let label = opt('--label', null);
if (!sampleDir) { sampleDir = path.join(root, 'test', 'fixtures'); label ??= '예시 데이터'; }
const store = new TranscriptStore({ dirs: [path.resolve(sampleDir)] });
store.scan();
const sample = {
  label: label ?? path.basename(sampleDir),
  events: store.events.map((e) => ({
    key: e.key, ts: e.ts, sessionId: e.sessionId, project: e.project, model: e.model,
    input: e.input, output: e.output, cacheRead: e.cacheRead, cacheWrite5m: e.cacheWrite5m, cacheWrite1h: e.cacheWrite1h,
  })),
};

// 모듈을 브라우저용으로 인라인 (export 제거)
const stripExports = (src) => src.replace(/^export\s+(default\s+)?/gm, '').replace(/^import[^\n]*\n/gm, '');
const pricing = stripExports(read('src/pricing.js'));
const aggregate = stripExports(read('src/aggregate.js'));
const appSrc = read('public/app.js');
const cut = appSrc.indexOf('  // ---------- 데이터 ----------');
if (cut < 0) throw new Error('public/app.js 의 데이터 섹션 표식을 찾지 못했습니다');
let app = appSrc.slice(0, cut).replace('function renderMeta(s)', 'let renderMeta = function (s)');
const dataLayer = read('standalone/src/data.js');

const head = `<title>Claude 토큰 사용량</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%277%27 fill=%27%232a78d6%27/%3E%3Crect x=%277%27 y=%2717%27 width=%275%27 height=%278%27 rx=%271.5%27 fill=%27%23fff%27/%3E%3Crect x=%2713.5%27 y=%2711%27 width=%275%27 height=%2714%27 rx=%271.5%27 fill=%27%23fff%27/%3E%3Crect x=%2720%27 y=%276%27 width=%275%27 height=%2719%27 rx=%271.5%27 fill=%27%23fff%27/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&display=swap">
<style>
${read('public/style.css')}
${read('standalone/src/extra.css')}
</style>`;

const body = `${read('standalone/src/page.html')}
<script type="application/json" id="sample-data">${JSON.stringify(sample).replace(/</g, '\\u003c')}</script>
<script>
(() => {
'use strict';
${pricing}
${aggregate}
})();
</script>
<script>
${app.replace("(() => {\n  'use strict';", "(() => {\n  'use strict';\n  const { costOf, normalizeModel } = window.__claudeUsage;\n  const { summarize, startOfDay } = window.__claudeUsage;")}
${dataLayer}
</script>`;

// 인라인된 모듈의 심볼을 window 로 노출
const exposed = body.replace(
  '\n})();\n</script>',
  '\nwindow.__claudeUsage = { costOf, normalizeModel, summarize, startOfDay };\n})();\n</script>',
);

const artifactOut = opt('--artifact', null);
if (artifactOut) {
  fs.writeFileSync(artifactOut, `${head}\n${exposed}\n`);
  console.log('artifact 본문 작성:', artifactOut, `(호출 ${sample.events.length}건 내장)`);
} else {
  const out = path.join(root, 'standalone', 'index.html');
  fs.writeFileSync(out, `<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n${head}\n</head>\n<body>\n${exposed}\n</body>\n</html>\n`);
  console.log('작성:', out, `(호출 ${sample.events.length}건 내장)`);
}
