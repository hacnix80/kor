// ==UserScript==
// @name         난지캠핑장 빈자리 알림 (일반캠핑존 B·C·D)
// @namespace    nanji-watch
// @version      1.0.0
// @description  서울시 공공서비스예약 사이트의 난지캠핑장 달력을 주기적으로 다시 읽어, 지정한 날짜에 빈자리가 생기면 텔레그램으로 알립니다. 예약은 하지 않습니다.
// @match        https://yeyak.seoul.go.kr/web/main.do*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.telegram.org
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 순수 함수 (Node 테스트에서도 사용)
  // ---------------------------------------------------------------------------

  // 캠핑장 목록 페이지 HTML에서 "N월 일반캠핑존 X형 ... YY년 한강공원 난지캠핑장" 서비스 ID를 찾는다.
  // 반환: { "2026-12-B": "S2610...", ... }
  function parseServiceList(html) {
    const out = {};
    const re = /fnDetailPage\('(S\d+)'[^"]*"\s*title="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      const title = m[2];
      if (!/난지캠핑장/.test(title)) continue;
      const z = title.match(/(\d{1,2})월\s*일반캠핑존\s*([A-D])형/);
      const y = title.match(/(\d{2})년/);
      if (!z || !y) continue;
      const key = `20${y[1]}-${String(z[1]).padStart(2, '0')}-${z[2]}`;
      out[key] = id;
    }
    return out;
  }

  // 목록 HTML의 마지막 페이지 번호
  function parseLastPage(html) {
    const nums = [...html.matchAll(/fnGoPage\('(\d+)'\)/g)].map((x) => Number(x[1]));
    return nums.length ? Math.max(...nums) : 1;
  }

  // "2026-12-19" / "20261219" / "2026.12.19" -> "20261219"
  function normDate(s) {
    const d = String(s).replace(/[^0-9]/g, '');
    return /^\d{8}$/.test(d) ? d : null;
  }

  // 달력 셀 정보 -> 상태
  // able: 사이트가 '예약 가능'으로 표시한 칸인지, num: "예약수/정원" 텍스트
  function cellStatus(able, num) {
    const m = String(num || '').match(/(\d+)\s*\/\s*(\d+)/);
    const reg = m ? Number(m[1]) : null;
    const cap = m ? Number(m[2]) : null;
    const remain = m ? Math.max(cap - reg, 0) : null;
    return { available: !!able && (remain === null || remain > 0), reg, cap, remain };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseServiceList, parseLastPage, normDate, cellStatus };
  }
  if (typeof document === 'undefined') return;

  // ---------------------------------------------------------------------------
  // 설정
  // ---------------------------------------------------------------------------
  const BASE = 'https://yeyak.seoul.go.kr';
  const LIST_URL = (p) => `${BASE}/web/search/selectPageListDetailSearchImg.do?code=T500&dCode=T502&currentPage=${p}`;
  const DETAIL_URL = (id) => `${BASE}/web/reservation/selectReservView.do?rsv_svc_id=${id}`;
  const MIN_INTERVAL_MIN = 1;          // 사이트 부담을 줄이기 위한 최소 간격(분)
  const LIST_CACHE_MS = 30 * 60 * 1000; // 서비스 목록은 30분마다만 새로 읽음
  const FRAME_TIMEOUT_MS = 30000;

  const defaults = {
    dates: '',            // 예: 2026-12-19, 2026-12-20
    zones: 'B,C,D',
    intervalMin: 5,
    botToken: '',
    chatId: '',
    running: false,
  };
  const cfg = Object.assign({}, defaults, GM_getValue('cfg', {}));
  const saveCfg = () => GM_setValue('cfg', cfg);
  let notified = GM_getValue('notified', {}); // "YYYYMMDD-B" -> true (이미 알림 보냄)
  let listCache = { at: 0, map: {} };
  let timer = null;
  let busy = false;

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.id = 'nanji-watch';
  panel.innerHTML = `
    <style>
      #nanji-watch{position:fixed;right:12px;bottom:12px;z-index:2147483647;width:340px;background:#fff;color:#222;
        border:2px solid #2a7;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.25);font:13px/1.4 sans-serif;padding:10px}
      #nanji-watch h3{margin:0 0 8px;font-size:14px}
      #nanji-watch label{display:block;margin:4px 0 2px;font-weight:bold}
      #nanji-watch input{width:100%;box-sizing:border-box;padding:4px;border:1px solid #aaa;border-radius:4px}
      #nanji-watch .row{display:flex;gap:6px;margin-top:8px}
      #nanji-watch button{flex:1;padding:6px;border:0;border-radius:5px;background:#2a7;color:#fff;cursor:pointer}
      #nanji-watch button.sec{background:#888}
      #nanji-watch #nw-log{margin-top:8px;max-height:170px;overflow:auto;background:#f5f5f5;padding:6px;border-radius:4px;
        white-space:pre-wrap;font:12px/1.35 monospace}
      #nanji-watch #nw-status{margin-top:6px;font-weight:bold}
    </style>
    <h3>⛺ 난지캠핑장 빈자리 알림</h3>
    <label>날짜 (쉼표로 구분, 예: 2026-12-19, 2026-12-20)</label>
    <input id="nw-dates">
    <label>구역 (B,C,D 중 선택)</label>
    <input id="nw-zones">
    <label>검색 간격 (분, 최소 ${MIN_INTERVAL_MIN})</label>
    <input id="nw-interval" type="number" min="${MIN_INTERVAL_MIN}">
    <label>텔레그램 봇 토큰</label>
    <input id="nw-token" type="password">
    <label>텔레그램 chat_id</label>
    <input id="nw-chat">
    <div class="row">
      <button id="nw-start">저장 후 시작</button>
      <button id="nw-stop" class="sec">중지</button>
      <button id="nw-test" class="sec">알림 테스트</button>
    </div>
    <div id="nw-status"></div>
    <div id="nw-log"></div>`;
  document.body.appendChild(panel);
  const $ = (id) => panel.querySelector('#' + id);
  $('nw-dates').value = cfg.dates;
  $('nw-zones').value = cfg.zones;
  $('nw-interval').value = cfg.intervalMin;
  $('nw-token').value = cfg.botToken;
  $('nw-chat').value = cfg.chatId;

  function log(msg) {
    const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const el = $('nw-log');
    el.textContent = `[${t}] ${msg}\n` + el.textContent.slice(0, 6000);
  }
  function status(msg) { $('nw-status').textContent = msg; }

  function readForm() {
    cfg.dates = $('nw-dates').value.trim();
    cfg.zones = $('nw-zones').value.trim().toUpperCase();
    cfg.intervalMin = Math.max(MIN_INTERVAL_MIN, Number($('nw-interval').value) || defaults.intervalMin);
    $('nw-interval').value = cfg.intervalMin;
    cfg.botToken = $('nw-token').value.trim();
    cfg.chatId = $('nw-chat').value.trim();
  }

  $('nw-start').onclick = () => {
    readForm();
    if (!targets().length) { alert('날짜와 구역을 확인하세요.'); return; }
    cfg.running = true; saveCfg();
    notified = {}; GM_setValue('notified', notified);
    log(`시작: ${cfg.dates} / ${cfg.zones} / ${cfg.intervalMin}분 간격`);
    schedule(0);
  };
  $('nw-stop').onclick = () => {
    cfg.running = false; saveCfg();
    clearTimeout(timer);
    status('중지됨');
    log('중지');
  };
  $('nw-test').onclick = async () => {
    readForm(); saveCfg();
    try { await sendTelegram('✅ 난지캠핑장 빈자리 알림 테스트 메시지입니다.'); log('테스트 알림 전송 성공'); }
    catch (e) { log('테스트 알림 실패: ' + e.message); }
  };

  // ---------------------------------------------------------------------------
  // 동작
  // ---------------------------------------------------------------------------
  function targets() {
    const dates = cfg.dates.split(/[,\s]+/).map(normDate).filter(Boolean);
    const zones = [...new Set(cfg.zones.split(/[,\s]+/).filter((z) => /^[A-D]$/.test(z)))];
    const out = [];
    for (const d of [...new Set(dates)]) for (const z of zones) out.push({ ymd: d, zone: z });
    return out;
  }

  function sendTelegram(text) {
    return new Promise((resolve, reject) => {
      if (!cfg.botToken || !cfg.chatId) return reject(new Error('봇 토큰/chat_id 없음'));
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
        onload: (r) => (r.status === 200 ? resolve() : reject(new Error('HTTP ' + r.status + ' ' + r.responseText))),
        onerror: () => reject(new Error('네트워크 오류')),
      });
    });
  }

  async function loadServiceMap() {
    if (Date.now() - listCache.at < LIST_CACHE_MS) return listCache.map;
    const map = {};
    const first = await (await fetch(LIST_URL(1), { credentials: 'include' })).text();
    Object.assign(map, parseServiceList(first));
    const last = Math.min(parseLastPage(first), 10);
    for (let p = 2; p <= last; p++) {
      const html = await (await fetch(LIST_URL(p), { credentials: 'include' })).text();
      Object.assign(map, parseServiceList(html));
    }
    listCache = { at: Date.now(), map };
    return map;
  }

  // 상세 페이지를 숨은 프레임으로 열고, 사이트가 그린 달력에서 날짜별 상태를 읽는다.
  function readCalendar(serviceId, ymds) {
    return new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:absolute;width:1200px;height:900px;left:-10000px;top:0;visibility:hidden';
      f.src = DETAIL_URL(serviceId);
      const started = Date.now();
      const done = (err, val) => { clearInterval(iv); f.remove(); err ? reject(err) : resolve(val); };
      const iv = setInterval(() => {
        let doc;
        try { doc = f.contentDocument; } catch (e) { return done(new Error('프레임 접근 불가')); }
        if (doc && /ipRedirect/.test(doc.location.href)) return done(new Error('사이트가 접근을 차단함(ipRedirect)'));
        const cal = doc && doc.querySelector('#calendar');
        const ready = cal && cal.getAttribute('aria-busy') === 'false' && doc.querySelector('[id^="div_cal_"]');
        if (ready) {
          const res = {};
          for (const ymd of ymds) {
            const td = doc.querySelector('#calendar_' + ymd);
            if (!td) { res[ymd] = null; continue; }
            const able = td.classList.contains('able') && td.classList.contains('has-rounds');
            const num = (doc.querySelector('#div_cal_' + ymd + ' .num') || {}).textContent;
            res[ymd] = cellStatus(able, num);
          }
          return done(null, res);
        }
        if (Date.now() - started > FRAME_TIMEOUT_MS) done(new Error('달력 로딩 시간 초과'));
      }, 500);
      document.body.appendChild(f);
    });
  }

  async function checkOnce() {
    const ts = targets();
    const map = await loadServiceMap();
    // 서비스(월·구역)별로 묶어서 한 번씩만 연다
    const groups = {};
    for (const t of ts) {
      const key = `${t.ymd.slice(0, 4)}-${t.ymd.slice(4, 6)}-${t.zone}`;
      (groups[key] = groups[key] || []).push(t.ymd);
    }
    const lines = [];
    const newly = [];
    for (const [key, ymds] of Object.entries(groups)) {
      const zone = key.slice(-1);
      const id = map[key];
      if (!id) { lines.push(`${key}: 예약 서비스가 아직 없음(오픈 전)`); continue; }
      const res = await readCalendar(id, ymds);
      for (const ymd of ymds) {
        const s = res[ymd];
        const nk = `${ymd}-${zone}`;
        const label = `${ymd.slice(4, 6)}/${ymd.slice(6)} ${zone}형`;
        if (!s) { lines.push(`${label}: 달력에 없음`); continue; }
        const cnt = s.cap != null ? ` (${s.reg}/${s.cap})` : '';
        if (s.available) {
          lines.push(`${label}: ✅ 빈자리 ${s.remain ?? '?'}${cnt}`);
          if (!notified[nk]) newly.push({ label, s, id, nk });
          notified[nk] = true;
        } else {
          lines.push(`${label}: 마감${cnt}`);
          notified[nk] = false; // 다시 자리가 나면 또 알림
        }
      }
    }
    GM_setValue('notified', notified);
    log(lines.join('\n'));
    for (const n of newly) {
      const msg = `⛺ 난지캠핑장 빈자리!\n${n.label} 남은 자리 ${n.s.remain ?? '?'}` +
        (n.s.cap != null ? ` (예약 ${n.s.reg}/${n.s.cap})` : '') + `\n${DETAIL_URL(n.id)}`;
      try { await sendTelegram(msg); log('알림 전송: ' + n.label); }
      catch (e) { log('알림 실패: ' + e.message); notified[n.nk] = false; GM_setValue('notified', notified); }
    }
  }

  function schedule(delayMs) {
    clearTimeout(timer);
    if (!cfg.running) return;
    const at = new Date(Date.now() + delayMs);
    status(`실행 중 · 다음 검색 ${at.toLocaleTimeString('ko-KR', { hour12: false })}`);
    timer = setTimeout(async () => {
      if (busy || !cfg.running) return;
      busy = true;
      status('검색 중...');
      try { await checkOnce(); }
      catch (e) {
        log('오류: ' + e.message);
        if (/차단/.test(e.message)) {
          cfg.running = false; saveCfg();
          status('사이트가 접근을 막아 중지했습니다');
          sendTelegram('⚠️ 난지캠핑장 알림: 사이트가 접근을 막아 검색을 중지했습니다. 간격을 늘려 다시 시작하세요.').catch(() => {});
          busy = false;
          return;
        }
      }
      busy = false;
      schedule(cfg.intervalMin * 60 * 1000);
    }, delayMs);
  }

  if (cfg.running) { log('이전 설정으로 자동 재개'); schedule(3000); }
  else status('대기 중 · 설정 후 [저장 후 시작]');
})();
