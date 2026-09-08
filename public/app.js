(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { range: 'today', project: '', summary: null, seenKeys: new Set(), firstLoad: true, es: null };

  // ---------- 포맷 ----------
  const fmtTok = (n) => {
    n = Math.round(n || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K';
    return String(n);
  };
  const fmtFull = (n) => Math.round(n || 0).toLocaleString('ko-KR');
  const fmtUsd = (n) => {
    n = n || 0;
    if (n === 0) return '$0';
    if (n < 0.01) return '$' + n.toFixed(4);
    if (n < 1) return '$' + n.toFixed(3);
    return '$' + n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtHM = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const fmtDateTime = (ts) => new Date(ts).toLocaleString('ko-KR', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDur = (ms) => {
    const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
    return h ? `${h}시간 ${m}분` : `${m}분`;
  };
  const relTime = (ts, now) => {
    const d = Math.max(0, now - ts);
    if (d < 60e3) return '방금';
    if (d < 3.6e6) return `${Math.floor(d / 6e4)}분 전`;
    if (d < 86.4e6) return `${Math.floor(d / 3.6e6)}시간 전`;
    return `${Math.floor(d / 86.4e6)}일 전`;
  };
  const shortModel = (m) => m.replace(/^claude-/, '');
  const cacheWrite = (o) => (o.cacheWrite5m || 0) + (o.cacheWrite1h || 0);

  // ---------- 툴팁 ----------
  const tip = $('tooltip');
  function showTip(x, y, title, rows) {
    tip.textContent = '';
    const t = document.createElement('div'); t.className = 'tt-title'; t.textContent = title; tip.appendChild(t);
    for (const [label, value, cls] of rows) {
      const r = document.createElement('div'); r.className = 'tt-row' + (cls ? ' ' + cls : '');
      const l = document.createElement('span'); l.textContent = label;
      const v = document.createElement('strong'); v.textContent = value;
      r.append(l, v); tip.appendChild(r);
    }
    tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + pad, top = y + pad;
    if (left + w > window.innerWidth - 8) left = x - w - pad;
    if (top + h > window.innerHeight - 8) top = y - h - pad;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- 컬럼 차트 (단일 계열, SVG) ----------
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return n * p;
  }
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  function renderColumns(container, items, { xLabel, tipTitle, tipRows, labelEvery = 1 }) {
    container.textContent = '';
    const W = container.clientWidth || 600, H = container.clientHeight || 220;
    const m = { top: 18, right: 8, bottom: 26, left: 44 };
    const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    const max = niceMax(Math.max(0, ...items.map((d) => d.total)));
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': tipTitle });
    const y = (v) => m.top + ih - (v / max) * ih;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (max / ticks) * i, yy = y(v);
      svg.appendChild(svgEl('line', { x1: m.left, x2: W - m.right, y1: yy, y2: yy, class: i === 0 ? 'baseline' : 'gridline' }));
      const t = svgEl('text', { x: m.left - 6, y: yy + 4, 'text-anchor': 'end', class: 'tick' }); t.textContent = fmtTok(v); svg.appendChild(t);
    }
    const n = items.length, band = iw / Math.max(n, 1);
    const bw = Math.min(24, Math.max(2, band * 0.62));
    const maxIdx = items.reduce((bi, d, i) => (d.total > (items[bi]?.total ?? -1) ? i : bi), 0);
    const allZero = items.every((d) => d.total === 0);
    items.forEach((d, i) => {
      const cx = m.left + band * i + band / 2, x0 = cx - bw / 2, yTop = y(d.total), h = Math.max(0, m.top + ih - yTop);
      const g = svgEl('g', { class: 'band', tabindex: '0', role: 'listitem' });
      const r = Math.min(4, h, bw / 2);
      const path = h > 0
        ? `M${x0},${m.top + ih} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + bw - r} Q${x0 + bw},${yTop} ${x0 + bw},${yTop + r} V${m.top + ih} Z`
        : `M${x0},${m.top + ih} H${x0 + bw}`;
      g.appendChild(svgEl('path', { d: path, class: 'bar' }));
      g.appendChild(svgEl('rect', { x: m.left + band * i, y: m.top, width: band, height: ih, class: 'hit' }));
      if (i === maxIdx && d.total > 0) {
        const t = svgEl('text', { x: cx, y: yTop - 5, 'text-anchor': 'middle', class: 'dlabel' }); t.textContent = fmtTok(d.total); svg.appendChild(t);
      }
      if (i % labelEvery === 0 || i === n - 1) {
        const t = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'tick' }); t.textContent = xLabel(d, i); svg.appendChild(t);
      }
      const show = (ev) => showTip(ev.clientX ?? cx, ev.clientY ?? yTop, tipTitle + ' · ' + xLabel(d, i, true), tipRows(d));
      g.addEventListener('pointermove', show);
      g.addEventListener('pointerleave', hideTip);
      g.addEventListener('focus', () => {
        const rect = g.getBoundingClientRect();
        showTip(rect.left + rect.width / 2, rect.top, tipTitle + ' · ' + xLabel(d, i, true), tipRows(d));
      });
      g.addEventListener('blur', hideTip);
      svg.appendChild(g);
    });
    container.appendChild(svg);
    if (allZero) {
      const e = document.createElement('div'); e.className = 'empty'; e.textContent = '이 기간에는 기록이 없습니다'; container.appendChild(e);
    }
  }
  const usageRows = (d) => [
    ['입력', fmtFull(d.input)], ['캐시 읽기', fmtFull(d.cacheRead)], ['캐시 쓰기', fmtFull(cacheWrite(d))], ['출력', fmtFull(d.output)],
    ['합계', fmtFull(d.total), 'total'], ['예상 비용', fmtUsd(d.cost)], ['호출', `${d.calls}회`],
  ];

  // ---------- 렌더 ----------
  function renderBlock(s) {
    const b = s.block, now = s.now;
    if (!b) {
      $('block-state').textContent = '기록 없음'; $('block-state').classList.remove('active');
      $('block-tokens').textContent = '0'; $('block-window').textContent = '아직 기록된 호출이 없습니다';
      $('block-fill').style.width = '0%'; $('block-elapsed').textContent = '경과 —'; $('block-remaining').textContent = '남은 시간 —';
      $('block-cost').textContent = '$0'; $('block-calls').textContent = '0'; $('block-output').textContent = '0';
      return;
    }
    const total = b.end - b.start, elapsed = Math.min(Math.max(now - b.start, 0), total), pct = Math.round((elapsed / total) * 100);
    $('block-state').textContent = b.active ? '활성' : '종료됨';
    $('block-state').classList.toggle('active', b.active);
    $('block-tokens').textContent = fmtTok(b.total);
    $('block-tokens').title = fmtFull(b.total) + ' 토큰';
    $('block-window').textContent = `${fmtDateTime(b.start)} → ${fmtHM(b.end)} · 마지막 호출 ${relTime(b.lastActivity, now)}`;
    $('block-fill').style.width = pct + '%';
    $('block-meter').setAttribute('aria-valuenow', pct);
    $('block-elapsed').textContent = `경과 ${fmtDur(elapsed)} (${pct}%)`;
    $('block-remaining').textContent = b.active ? `남은 시간 ${fmtDur(Math.max(b.end - now, 0))}` : '다음 호출에서 새 창이 열립니다';
    $('block-cost').textContent = fmtUsd(b.cost);
    $('block-calls').textContent = `${b.calls}회`;
    $('block-output').textContent = fmtTok(b.output);
  }

  function renderRate(s) {
    const r5 = s.rate.last5m, r1 = s.rate.last1m;
    $('rate-5m').textContent = '';
    $('rate-5m').append(fmtTok(Math.round(r5.total / 5)) + ' ', Object.assign(document.createElement('span'), { className: 'unit', textContent: 'tok/min' }));
    $('rate-5m-detail').textContent = `최근 5분 합계 ${fmtFull(r5.total)} · ${r5.calls}회 · ${fmtUsd(r5.cost)}`;
    $('rate-1m').textContent = fmtTok(r1.total);
    $('rate-1m-detail').textContent = `호출 ${r1.calls}회 · 출력 ${fmtFull(r1.output)}`;
  }

  function renderHours(s) {
    const total = s.hours.reduce((a, h) => a + h.total, 0);
    $('hours-total').textContent = `합계 ${fmtTok(total)} · ${fmtUsd(s.hours.reduce((a, h) => a + h.cost, 0))}`;
    renderColumns($('hours-chart'), s.hours, {
      xLabel: (d, i, long) => (long ? fmtDateTime(d.hour) + '시' : new Date(d.hour).getHours() + '시'),
      tipTitle: '시간별', tipRows: usageRows, labelEvery: 3,
    });
  }

  function renderKpis(s) {
    const t = s.totals;
    $('kpi-total').textContent = fmtTok(t.total); $('kpi-total').title = fmtFull(t.total);
    $('kpi-total-sub').textContent = `${t.calls}회 호출 · 입력 ${fmtTok(t.input)} · 캐시 ${fmtTok(t.cacheRead + cacheWrite(t))}`;
    $('kpi-cost').textContent = fmtUsd(t.cost);
    $('kpi-cost-sub').textContent = t.unpriced ? `가격 미확인 ${t.unpriced}건 제외` : t.calls ? `호출당 평균 ${fmtUsd(t.cost / t.calls)}` : '';
    $('kpi-output').textContent = fmtTok(t.output);
    $('kpi-output-sub').textContent = t.calls ? `호출당 평균 ${fmtFull(t.output / t.calls)}` : '';
    $('kpi-cache').textContent = (t.cacheHitRate * 100).toFixed(1) + '%';
    $('kpi-cache-sub').textContent = `읽기 ${fmtTok(t.cacheRead)} / 쓰기 ${fmtTok(cacheWrite(t))}`;
  }

  function renderComposition(s) {
    const t = s.totals, c = $('composition'); c.textContent = '';
    const parts = [['입력', t.input], ['캐시 읽기', t.cacheRead], ['캐시 쓰기', cacheWrite(t)], ['출력', t.output]];
    const max = Math.max(1, ...parts.map((p) => p[1]));
    for (const [name, v] of parts) {
      const row = document.createElement('div'); row.className = 'brow';
      const n = document.createElement('span'); n.className = 'name'; n.textContent = name;
      const track = document.createElement('div'); track.className = 'track';
      const fill = document.createElement('div'); fill.className = 'fill'; fill.style.width = (v / max) * 100 + '%'; track.appendChild(fill);
      const val = document.createElement('span'); val.className = 'v'; val.textContent = fmtTok(v);
      const pct = document.createElement('small'); pct.textContent = t.total ? Math.round((v / t.total) * 100) + '%' : '0%'; val.appendChild(pct);
      row.append(n, track, val); c.appendChild(row);
    }
  }

  function renderDays(s) {
    const days = s.days;
    $('days-title').textContent = days.length <= 1 ? '오늘 토큰' : `일별 토큰 (${days.length}일)`;
    const every = days.length > 40 ? 7 : days.length > 14 ? 3 : 1;
    renderColumns($('days-chart'), days, {
      xLabel: (d, i, long) => (long ? d.day : d.day.slice(5).replace('-', '/')),
      tipTitle: '일별', tipRows: usageRows, labelEvery: every,
    });
  }

  const td = (text, cls) => { const e = document.createElement('td'); if (cls) e.className = cls; e.textContent = text; return e; };
  const emptyRow = (cols, text) => { const tr = document.createElement('tr'); tr.className = 'empty-row'; const c = td(text); c.colSpan = cols; tr.appendChild(c); return tr; };

  function renderModels(s) {
    const tb = $('models-table').tBodies[0]; tb.textContent = '';
    if (!s.byModel.length) return tb.appendChild(emptyRow(6, '기록 없음'));
    const max = Math.max(1, ...s.byModel.map((m) => m.total));
    for (const m of s.byModel) {
      const tr = document.createElement('tr');
      tr.append(td(shortModel(m.model)), td(fmtTok(m.total), 'num'), td(fmtTok(m.output), 'num'), td(m.unpriced ? '?' : fmtUsd(m.cost), 'num' + (m.unpriced ? ' unpriced' : '')), td(String(m.calls), 'num'));
      const bar = document.createElement('td'); const tr2 = document.createElement('div'); tr2.className = 'inline-track';
      const f = document.createElement('div'); f.className = 'inline-fill'; f.style.width = (m.total / max) * 100 + '%'; tr2.appendChild(f); bar.appendChild(tr2);
      tr.appendChild(bar); tr.title = `${m.model} · ${fmtFull(m.total)} 토큰`;
      tb.appendChild(tr);
    }
  }

  function renderSessions(s) {
    const tb = $('sessions-table').tBodies[0]; tb.textContent = '';
    if (!s.sessions.length) return tb.appendChild(emptyRow(5, '기록 없음'));
    for (const x of s.sessions.slice(0, 12)) {
      const tr = document.createElement('tr');
      tr.title = `${x.sessionId}\n${x.cwd || ''}\n시작 ${fmtDateTime(x.firstTs)}`;
      tr.append(td(relTime(x.lastTs, s.now)), td(x.project), td(x.models.map(shortModel).join(', ')), td(fmtTok(x.total), 'num'), td(x.unpriced ? '?' : fmtUsd(x.cost), 'num'));
      tb.appendChild(tr);
    }
  }

  function renderRecent(s) {
    const tb = $('recent-table').tBodies[0]; tb.textContent = '';
    if (!s.recent.length) return tb.appendChild(emptyRow(8, '기록 없음'));
    for (const e of s.recent.slice(0, 20)) {
      const tr = document.createElement('tr');
      if (!state.firstLoad && !state.seenKeys.has(e.key)) tr.className = 'new';
      state.seenKeys.add(e.key);
      tr.append(td(fmtTime(e.ts), 'mono'), td(shortModel(e.model) + (e.sidechain ? ' (서브)' : '')), td(e.project), td(fmtFull(e.input), 'num'), td(fmtFull(e.cacheRead), 'num'), td(fmtFull(cacheWrite(e)), 'num'), td(fmtFull(e.output), 'num'), td(e.cost == null ? '?' : fmtUsd(e.cost), 'num' + (e.cost == null ? ' unpriced' : '')));
      tr.title = `세션 ${e.sessionId}`;
      tb.appendChild(tr);
    }
    if (state.seenKeys.size > 2000) state.seenKeys = new Set(s.recent.map((e) => e.key));
  }

  function renderProjects(s) {
    const sel = $('project-select');
    const cur = state.project;
    const have = new Set([...sel.options].map((o) => o.value));
    for (const p of s.projects) {
      if (!have.has(p)) { const o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o); }
    }
    sel.value = s.projects.includes(cur) ? cur : '';
  }

  function renderMeta(s) {
    $('watch-dirs').textContent = `감시: ${s.dirs.join(', ')} · ${s.usingWatch ? 'fs.watch' : '폴링'} · 이벤트 ${s.eventCount.toLocaleString('ko-KR')}건`;
    $('updated-at').textContent = `갱신 ${fmtTime(s.now)}`;
    const from = s.from ? fmtDateTime(s.from) + ' 이후' : '전체 기간';
    $('range-desc').textContent = from;
  }

  function render(s) {
    state.summary = s;
    renderMeta(s); renderBlock(s); renderRate(s); renderHours(s);
    renderProjects(s); renderKpis(s); renderComposition(s); renderDays(s); renderModels(s); renderSessions(s); renderRecent(s);
    state.firstLoad = false;
  }

  // ---------- 데이터 ----------
  let fetching = null;
  async function load() {
    if (fetching) return fetching;
    const q = new URLSearchParams({ range: state.range, project: state.project });
    fetching = fetch('/api/summary?' + q, { cache: 'no-store' })
      .then((r) => r.json())
      .then(render)
      .catch(() => setLive(false, '요약을 불러오지 못했습니다'))
      .finally(() => { fetching = null; });
    return fetching;
  }
  function setLive(on, text) {
    $('live-dot').className = 'dot ' + (on ? 'on' : 'off');
    $('live-text').textContent = text;
  }
  function connect() {
    if (state.es) state.es.close();
    const es = new EventSource('/api/events');
    state.es = es;
    es.addEventListener('hello', () => { setLive(true, '실시간 연결됨'); load(); });
    es.addEventListener('change', () => load());
    es.onerror = () => setLive(false, '재연결 중…');
  }

  // 필터
  $('range-buttons').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]'); if (!b) return;
    state.range = b.dataset.range;
    for (const x of $('range-buttons').querySelectorAll('button')) x.classList.toggle('active', x === b);
    load();
  });
  $('project-select').addEventListener('change', (e) => { state.project = e.target.value; load(); });

  // 시계/남은 시간은 서버 없이 로컬로 진행시킨다
  setInterval(() => {
    if (!state.summary) return;
    const s = state.summary, drift = Date.now() - s.now;
    if (drift > 60e3) { load(); return; }
    renderBlock({ ...s, now: Date.now() });
  }, 10e3);
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => state.summary && (renderHours(state.summary), renderDays(state.summary)), 120); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  load();
  connect();
})();
