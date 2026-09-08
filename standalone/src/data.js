  // ---------- 데이터 (브라우저 전용: 내장 샘플 / 폴더 열기 / 파일 선택) ----------
  const isWin = navigator.platform.startsWith('Win');
  $('hint-path').textContent = isWin ? '%USERPROFILE%\\.claude\\projects' : '~/.claude/projects';

  const data = { events: [], keys: new Set(), source: 'sample', label: '', live: null };

  function projectFromPath(name) {
    // "-home-user-test" 또는 "C--Users-me-app" -> 마지막 토막
    const parts = String(name).split('-').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(name);
  }
  function basename(p) {
    const s = String(p).replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

  function parseLine(line, fileLabel, dirName) {
    if (!line || line.charCodeAt(0) !== 123) return null;
    let o;
    try { o = JSON.parse(line); } catch { return null; }
    if (o.type !== 'assistant' || !o.message || typeof o.message !== 'object') return null;
    const msg = o.message, u = msg.usage;
    if (!u || typeof u !== 'object') return null;
    const model = normalizeModel(msg.model);
    if (!model || model === '<synthetic>') return null;
    const input = num(u.input_tokens), output = num(u.output_tokens), cacheRead = num(u.cache_read_input_tokens);
    const cacheWriteTotal = num(u.cache_creation_input_tokens);
    let cacheWrite5m = num(u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens);
    let cacheWrite1h = num(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens);
    if (cacheWrite5m + cacheWrite1h === 0 && cacheWriteTotal > 0) cacheWrite5m = cacheWriteTotal;
    if (input + output + cacheRead + cacheWrite5m + cacheWrite1h === 0) return null;
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) return null;
    const id = msg.id || o.uuid || `${fileLabel}:${ts}`;
    const tokens = { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
    return {
      key: `${id}:${o.requestId || ''}`, ts, file: fileLabel,
      sessionId: o.sessionId || fileLabel.replace(/\.jsonl$/, ''),
      project: o.cwd ? basename(o.cwd) : projectFromPath(dirName),
      cwd: o.cwd || null, model, ...tokens,
      total: input + output + cacheRead + cacheWrite5m + cacheWrite1h,
      cost: typeof o.costUSD === 'number' ? o.costUSD : costOf(tokens, model),
      sidechain: Boolean(o.isSidechain), version: o.version || null,
    };
  }

  function addText(text, fileLabel, dirName) {
    let added = 0;
    for (const raw of text.split('\n')) {
      const ev = parseLine(raw.trim(), fileLabel, dirName);
      if (!ev || data.keys.has(ev.key)) continue;
      data.keys.add(ev.key); data.events.push(ev); added++;
    }
    if (added) data.events.sort((a, b) => a.ts - b.ts);
    return added;
  }
  function resetData(source, label) {
    data.events = []; data.keys = new Set(); data.source = source; data.label = label;
    state.seenKeys = new Set(); state.firstLoad = true;
  }

  // 요약 렌더 (서버 대신 로컬 계산)
  function load() {
    const now = Date.now();
    if (state.range === 'today' && !state.autoRanged) {
      state.autoRanged = true;
      const hasToday = data.events.some((e) => e.ts >= startOfDay(now));
      if (!hasToday && data.events.length) {
        state.range = 'all';
        for (const x of $('range-buttons').querySelectorAll('button')) x.classList.toggle('active', x.dataset.range === 'all');
      }
    }
    const s = summarize(data.events, { range: state.range, project: state.project, now });
    s.eventCount = data.events.length;
    render(s);
  }
  function setLive(mode, text) {
    $('live-dot').className = 'dot ' + mode;
    $('live-text').textContent = text;
  }
  function note(text) { $('source-note').textContent = text || ''; $('source-note').hidden = !text; }

  // 1) 내장 샘플
  function loadSample() {
    stopLive();
    const el = document.getElementById('sample-data');
    const sample = el ? JSON.parse(el.textContent) : { label: '샘플 없음', events: [] };
    resetData('sample', sample.label);
    for (const e of sample.events) {
      const ev = { ...e, cost: costOf(e, e.model), total: e.input + e.output + e.cacheRead + e.cacheWrite5m + e.cacheWrite1h, sidechain: false, cwd: null, file: '' };
      if (!data.keys.has(ev.key)) { data.keys.add(ev.key); data.events.push(ev); }
    }
    data.events.sort((a, b) => a.ts - b.ts);
    state.autoRanged = false;
    setLive('sample', '샘플 데이터');
    note('');
    load();
  }

  // 2) 폴더 열기 (File System Access API) -> 2초마다 새 바이트만 읽어 실시간 갱신
  function stopLive() {
    if (data.live) { clearInterval(data.live.timer); clearInterval(data.live.rescan); data.live = null; }
  }
  async function* walk(dirHandle, prefix = '') {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'directory') yield* walk(handle, prefix + name + '/');
      else if (name.endsWith('.jsonl')) yield { path: prefix + name, handle, dirName: prefix.split('/').filter(Boolean).pop() || '' };
    }
  }
  const embedded = (() => { try { return window.self !== window.top; } catch { return true; } })();
  function openInNewTab() {
    const url = location.href;
    let w = null;
    try { w = window.open(url, '_blank', 'noopener'); } catch { w = null; }
    if (!w) {
      note('새 탭을 열지 못했습니다. 아래 주소를 복사해 새 탭에 붙여 넣으세요: ' + url);
      $('tab-url').value = url; $('tab-url').hidden = false; $('tab-url').select();
    }
  }
  async function openDirectory() {
    if (embedded) {
      note('이 화면은 다른 페이지 안에 끼워져 있어 브라우저가 폴더 선택을 막습니다. "새 탭에서 열기" 를 누른 뒤 그 탭에서 "폴더 열기 · 실시간" 을 사용하세요.');
      openInNewTab();
      return;
    }
    if (!window.showDirectoryPicker) {
      note('이 브라우저는 폴더 실시간 읽기를 지원하지 않습니다. Chrome·Edge 에서 열거나 "파일 선택 · 1회" 를 사용하세요.');
      return;
    }
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ id: 'claude-projects', mode: 'read' });
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      note('폴더를 열 수 없습니다 (' + (e && e.message ? e.message : e) + '). 이 화면이 다른 페이지 안에 끼워져 있으면 새 탭에서 열어 보세요. 또는 "파일 선택 · 1회" 를 사용하세요.');
      return;
    }
    stopLive();
    resetData('dir', dirHandle.name);
    state.autoRanged = false;
    setLive('on', '실시간 · 폴더 감시 중');
    const files = new Map(); // path -> { handle, offset, remainder, dirName }
    const readNew = async (entry) => {
      let f;
      try { f = await entry.handle.getFile(); } catch { return 0; }
      if (f.size < entry.offset) { entry.offset = 0; entry.remainder = ''; }
      if (f.size === entry.offset) return 0;
      const chunk = await f.slice(entry.offset).text();
      entry.offset = f.size;
      const text = entry.remainder + chunk;
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) { entry.remainder = text; return 0; }
      entry.remainder = text.slice(lastNl + 1);
      return addText(text.slice(0, lastNl), entry.path, entry.dirName);
    };
    const rescan = async () => {
      let found = 0;
      try {
        for await (const { path, handle, dirName } of walk(dirHandle)) {
          found++;
          if (!files.has(path)) files.set(path, { handle, offset: 0, remainder: '', dirName, path });
        }
      } catch (e) { note('폴더를 다시 읽지 못했습니다: ' + (e && e.message ? e.message : e)); }
      return found;
    };
    const found = await rescan();
    let added = 0;
    for (const entry of files.values()) added += await readNew(entry);
    note(`${dirHandle.name} 에서 .jsonl ${found}개, 호출 ${data.events.length.toLocaleString('ko-KR')}건을 읽었습니다. 새 호출은 2초 안에 반영됩니다.`);
    load();
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        let n = 0;
        for (const entry of files.values()) n += await readNew(entry);
        if (n) load(); else $('updated-at').textContent = `확인 ${fmtTime(Date.now())}`;
      } finally { busy = false; }
    }, 2000);
    const rescanTimer = setInterval(rescan, 15000);
    data.live = { timer, rescan: rescanTimer };
  }

  // 3) 파일 선택 (1회 읽기, 모든 브라우저)
  async function loadFiles(list) {
    const files = [...list].filter((f) => f.name.endsWith('.jsonl'));
    if (!files.length) { note('.jsonl 파일이 없습니다. ~/.claude/projects 폴더를 선택했는지 확인하세요.'); return; }
    stopLive();
    resetData('files', files.length + '개 파일');
    state.autoRanged = false;
    setLive('off', '1회 읽기 (실시간 아님)');
    for (const f of files) {
      const rel = f.webkitRelativePath || f.name;
      const parts = rel.split('/');
      const dirName = parts.length >= 2 ? parts[parts.length - 2] : '';
      addText(await f.text(), rel, dirName);
    }
    note(`파일 ${files.length}개에서 호출 ${data.events.length.toLocaleString('ko-KR')}건을 읽었습니다. 실시간 갱신은 "폴더 열기 · 실시간" 을 사용하세요.`);
    load();
  }

  // 메타 (서버 버전의 renderMeta 를 덮어쓴다)
  renderMeta = function (s) {
    const src = data.source === 'sample' ? `샘플: ${data.label}` : data.source === 'dir' ? `폴더: ${data.label}` : `파일: ${data.label}`;
    $('source-text').textContent = `${src} · 호출 ${s.eventCount.toLocaleString('ko-KR')}건 · 비용은 API 요금 환산 참고값`;
    $('updated-at').textContent = `갱신 ${fmtTime(s.now)}`;
    $('range-desc').textContent = s.from ? fmtDateTime(s.from) + ' 이후' : '전체 기간';
  };

  // 컨트롤
  $('range-buttons').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]'); if (!b) return;
    state.range = b.dataset.range; state.autoRanged = true;
    for (const x of $('range-buttons').querySelectorAll('button')) x.classList.toggle('active', x === b);
    load();
  });
  $('project-select').addEventListener('change', (e) => { state.project = e.target.value; load(); });
  $('open-dir').addEventListener('click', openDirectory);
  $('file-input').addEventListener('change', (e) => loadFiles(e.target.files));
  $('use-sample').addEventListener('click', loadSample);
  if (!window.showDirectoryPicker) $('open-dir').title = 'Chrome 또는 Edge 에서 지원';
  $('open-tab').addEventListener('click', openInNewTab);
  if (embedded) {
    $('open-tab').hidden = false;
    $('open-dir').classList.remove('primary'); $('open-tab').classList.add('primary');
    note('폴더 실시간 읽기는 이 화면이 끼워진 상태에서는 막혀 있습니다. "새 탭에서 열기" 로 연 다음 "폴더 열기 · 실시간" 을 누르세요. 파일 선택창에서 숨김 폴더가 안 보이면 macOS 는 ⌘⇧. , Windows 는 주소창에 경로를 직접 입력하세요.');
  }

  setInterval(() => { if (state.summary) renderBlock({ ...state.summary, now: Date.now() }); }, 10e3);
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => state.summary && (renderHours(state.summary), renderDays(state.summary)), 120); });

  loadSample();
})();
