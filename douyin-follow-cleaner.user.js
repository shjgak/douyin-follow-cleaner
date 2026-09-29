// ==UserScript==
// @name         Douyin 关注体检 + 批量取关
// @namespace    codex.local
// @version      0.2.0
// @description  扫描我关注的账号（最近作品时间 / 最近5条平均点赞 / 互关状态 / 纯直播），导出 CSV，并按规则批量取关
// @match        https://www.douyin.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ======== 规则（可改） ========
  const CFG = {
    inactiveDays : 30,     // 超过 N 天没发作品 → 建议取关
    minAvgLikes  : 10000,  // 最近 5 条平均点赞低于这个数 → 建议取关
    keepMutual   : true,   // 互关的保留
    keepLiveOnly : true,   // 纯直播（0 作品）保留
    stepDelayMs  : 1500,   // 打开下一个账号之间的间隔
    captureWaitMs: 9000,   // 等页面自己把作品数据请求回来
    maxScroll    : 200,    // 关注列表最多滚动次数
  };
  // =============================

  const SKEY = 'dfc_state_v2';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- 状态（跨页面导航保留） ----------
  let state = { phase: 'idle', list: [], idx: 0, rows: [], log: [] };
  try { const s = sessionStorage.getItem(SKEY); if (s) state = JSON.parse(s); } catch (e) {}
  const saveState = () => { try { sessionStorage.setItem(SKEY, JSON.stringify(state)); } catch (e) {} };
  if (!state.log) state.log = [];
  const pushLog = m => { state.log.push(m); if (state.log.length > 60) state.log.shift(); saveState(); };

  // ---------- 抓页面自己发出的接口响应（带签名的真实数据） ----------
  const captured = { users: [], awemes: [] };
  const seenObj = new Set();
  function absorb(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 12 || seenObj.has(obj)) return;
    seenObj.add(obj);
    if (Array.isArray(obj)) { for (const v of obj) absorb(v, depth + 1); return; }
    const ct = obj.create_time || obj.createTime;
    const st = obj.statistics || obj.stats;
    if (ct && st && (st.digg_count !== undefined || st.diggCount !== undefined)) {
      captured.awemes.push({
        id: obj.aweme_id || obj.awemeId || String(Math.random()),
        ct: Number(ct),
        digg: Number(st.digg_count ?? st.diggCount ?? 0),
      });
    }
    if (obj.nickname && (obj.aweme_count !== undefined || obj.sec_uid || obj.unique_id)) {
      captured.users.push({
        works: Number(obj.aweme_count ?? obj.awemeCount ?? -1),
        totalLikes: Number(obj.total_favorited ?? obj.totalFavorited ?? -1),
        followStatus: obj.follow_status ?? obj.followStatus ?? null,
        followerStatus: obj.follower_status ?? obj.followerStatus ?? null,
      });
    }
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') absorb(v, depth + 1);
      else if (typeof v === 'string' && v.length > 20 && (v[0] === '{' || v[0] === '[')) {
        try { absorb(JSON.parse(v), depth + 1); } catch (e) {}
      }
    }
  }
  const isWanted = u => /aweme\/post|aweme\/v1\/web\/user|user\/profile|user\/detail|aweme\/v1\/web\/aweme\/detail/.test(u || '');

  (function hookNetwork() {
    try {
      const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__dfcUrl = u; return XO.call(this, m, u, ...rest); };
      XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
          try { if (isWanted(this.__dfcUrl)) absorb(JSON.parse(this.responseText), 0); } catch (e) {}
        });
        return XS.apply(this, args);
      };
      const of = window.fetch;
      window.fetch = async function (...args) {
        const res = await of.apply(this, args);
        try {
          const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
          if (isWanted(u)) res.clone().json().then(j => absorb(j, 0)).catch(() => {});
        } catch (e) {}
        return res;
      };
    } catch (e) {}
  })();

  // ---------- DOM 兜底 ----------
  function readFromDom() {
    const txt = (document.body && document.body.innerText) || '';
    const works = (txt.match(/作品\s*(\d+)/) || [])[1];
    const likes = (txt.match(/获赞\s*([\d.]+万?)/) || [])[1];
    const items = document.querySelectorAll('[data-e2e="user-post-item"]');
    const likes5 = [];
    [...items].slice(0, 5).forEach(el => {
      const t = (el.innerText || '').replace(/\s+/g, ' ');
      const m = t.match(/([\d.]+万?)\s*$/);
      if (m) likes5.push(m[1]);
    });
    return { works: works ? Number(works) : null, totalLikes: likes || null, likes5 };
  }
  const toNum = s => {
    if (s === null || s === undefined) return null;
    if (typeof s === 'number') return s;
    const t = String(s).trim();
    if (!t) return null;
    if (t.endsWith('万')) return Math.round(parseFloat(t) * 10000);
    if (t.endsWith('亿')) return Math.round(parseFloat(t) * 100000000);
    const n = parseFloat(t.replace(/,/g, ''));
    return isNaN(n) ? null : Math.round(n);
  };

  // ---------- 判定 ----------
  function decide(r) {
    if (CFG.keepMutual && r.mutual) return '互关-保留';
    if (r.works === 0 && CFG.keepLiveOnly) return '纯直播-保留';
    if (r.lastPostDays !== null && r.lastPostDays > CFG.inactiveDays) return '超' + CFG.inactiveDays + '天未更新-取关';
    if (r.avgLikes !== null && r.avgLikes < CFG.minAvgLikes) return '平均点赞<' + (CFG.minAvgLikes / 10000) + 'w-取关';
    if (r.avgLikes === null && r.lastPostDays === null) return '读不到数据-人工看';
    return '保留';
  }

  // ---------- 扫描：逐个打开主页 ----------
  async function scanCurrentProfile() {
    const t0 = Date.now();
    while (Date.now() - t0 < CFG.captureWaitMs) {
      if (captured.awemes.length || captured.users.length) break;
      await sleep(400);
    }
    const cur = state.list[state.idx] || {};
    const user = captured.users.sort((a, b) => (b.works || -1) - (a.works || -1))[0] || null;
    const uniq = new Map();
    captured.awemes.forEach(a => uniq.set(a.id, a));
    const awemes = [...uniq.values()].sort((a, b) => b.ct - a.ct).slice(0, 5);
    const dom = readFromDom();
    const now = Date.now() / 1000;
    const last = awemes[0];
    const rec = {
      name: cur.name, secUid: cur.secUid,
      works: user && user.works >= 0 ? user.works : dom.works,
      totalLikes: user && user.totalLikes >= 0 ? user.totalLikes : toNum(dom.totalLikes),
      mutual: !!(user && user.followStatus === 1 && user.followerStatus === 1),
      lastPostDays: last ? Math.floor((now - last.ct) / 86400) : null,
      avgLikes: awemes.length ? Math.round(awemes.reduce((s, a) => s + a.digg, 0) / awemes.length) : null,
      likes5: awemes.map(a => a.digg).join('/'),
      source: (user || awemes.length) ? 'api' : 'dom',
      domSample: dom.likes5.join('/'),
    };
    rec.verdict = decide(rec);
    state.rows.push(rec);
    saveState();
  }

  // ---------- 关注列表收集（在 /user/self 上） ----------
  function findScroller() {
    const a = document.querySelector('a[href*="/user/MS4w"]');
    if (!a) return null;
    let el = a.parentElement;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 80) return el;
      el = el.parentElement;
    }
    return document.scrollingElement;
  }
  async function collectFollowList() {
    const map = new Map();
    const sc = findScroller();
    if (!sc) { pushLog('❌ 找不到关注列表容器（先点开「关注 366」弹窗）'); return []; }
    let stall = 0, lastCount = 0;
    for (let i = 0; i < CFG.maxScroll; i++) {
      document.querySelectorAll('a[href*="/user/MS4w"]').forEach(a => {
        const name = (a.textContent || '').trim().replace(/\s+/g, ' ');
        const secUid = a.getAttribute('href').split('/user/')[1].split('?')[0];
        if (name && secUid) map.set(secUid, { name, secUid });
      });
      if (map.size === lastCount) stall++; else stall = 0;
      lastCount = map.size;
      pushLog('   已收集 ' + map.size + ' 个');
      if (stall >= 4) break;
      sc.scrollTop = sc.scrollTop + Math.max(400, sc.clientHeight * 0.8);
      await sleep(700);
    }
    return [...map.values()];
  }

  // ---------- UI ----------
  function buildPanel() {
    if (document.getElementById('dfc-box')) return;
    const box = document.createElement('div');
    box.id = 'dfc-box';
    box.style.cssText = 'position:fixed;right:16px;top:80px;width:560px;max-height:78vh;z-index:999999;' +
      'background:#181b21;color:#e6e6e6;font:12px/1.5 -apple-system,"PingFang SC",sans-serif;border:1px solid #333;' +
      'border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden';
    box.innerHTML = `
      <div id="dfc-head" style="padding:8px 10px;background:#23262d;cursor:move;display:flex;justify-content:space-between">
        <b>抖音关注体检 v0.2</b><span id="dfc-close" style="cursor:pointer">✕</span>
      </div>
      <div style="padding:8px 10px;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #2b2f37">
        <button id="dfc-scan">① 打开关注列表并扫描</button>
        <button id="dfc-csv">② 导出 CSV</button>
        <button id="dfc-unfollow">③ 批量取关勾选项</button>
        <button id="dfc-diag">复制诊断</button>
        <button id="dfc-clear">清空</button>
      </div>
      <div id="dfc-log" style="padding:6px 10px;height:96px;overflow:auto;background:#12141a;color:#8fb98f;white-space:pre-wrap"></div>
      <div id="dfc-table" style="overflow:auto;flex:1"></div>`;
    document.body.appendChild(box);
    const $ = id => box.querySelector(id);
    const paintLog = () => { const el = $('#dfc-log'); el.textContent = (state.log || []).join('\n'); el.scrollTop = 1e6; };
    paintLog();
    $('#dfc-close').onclick = () => box.remove();
    $('#dfc-clear').onclick = () => { state = { phase: 'idle', list: [], idx: 0, rows: [], log: [] }; saveState(); paintLog(); render(); };
    $('#dfc-diag').onclick = () => {
      const t = 'phase=' + state.phase + ' list=' + state.list.length + ' idx=' + state.idx + ' rows=' + state.rows.length + '\n' +
        'captured.users=' + captured.users.length + ' captured.awemes=' + captured.awemes.length + '\n' + (state.log || []).slice(-20).join('\n');
      navigator.clipboard.writeText(t).then(() => alert('诊断信息已复制，粘贴给我'), () => alert(t));
    };
    (() => { let sx, sy, ox, oy, d = false;
      $('#dfc-head').addEventListener('mousedown', e => { d = true; sx = e.clientX; sy = e.clientY;
        const r = box.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault(); });
      window.addEventListener('mousemove', e => { if (!d) return;
        box.style.left = (ox + e.clientX - sx) + 'px'; box.style.top = (oy + e.clientY - sy) + 'px'; box.style.right = 'auto'; });
      window.addEventListener('mouseup', () => d = false);
    })();

    $('#dfc-scan').onclick = async () => {
      state.phase = 'collect'; state.list = []; state.idx = 0; state.rows = []; state.log = [];
      pushLog('① 打开关注列表…');
      const clickable = [...document.querySelectorAll('div,span')]
        .find(e => e.children.length === 0 && /^\d+$/.test((e.textContent || '').trim()) &&
                   e.previousElementSibling && /关注/.test(e.previousElementSibling.textContent || ''));
      if (clickable) clickable.click(); else pushLog('⚠️ 没找到「关注 N」入口，直接尝试读列表');
      await sleep(2500);
      pushLog('② 滚动收集账号…');
      const list = await collectFollowList();
      if (!list.length) { pushLog('❌ 一个都没收到，停止'); state.phase = 'idle'; saveState(); return; }
      state.list = list; state.idx = 0; state.phase = 'scan';
      pushLog('   共 ' + list.length + ' 个，开始逐个打开主页（每个约 3-10 秒）');
      saveState();
      location.href = 'https://www.douyin.com/user/' + list[0].secUid;
    };

    function render() {
      const head = ['', '昵称', '作品', '总赞', '最近更新', '近5条均赞', '数据源', '判定'];
      let h = '<table style="width:100%;border-collapse:collapse"><thead><tr>' +
        head.map(x => '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #2b2f37;position:sticky;top:0;background:#181b21">' + x + '</th>').join('') +
        '</tr></thead><tbody>';
      for (const r of (state.rows || []).slice(0, 500)) {
        const kill = (r.verdict || '').includes('取关');
        h += '<tr style="border-bottom:1px solid #22252b">' +
          '<td style="padding:3px 6px">' + (kill ? '<input type="checkbox" data-uid="' + r.secUid + '" checked>' : '') + '</td>' +
          '<td style="padding:3px 6px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (r.name || '') + '</td>' +
          '<td style="padding:3px 6px">' + (r.works ?? '-') + '</td>' +
          '<td style="padding:3px 6px">' + (r.totalLikes ?? '-') + '</td>' +
          '<td style="padding:3px 6px">' + (r.lastPostDays === null ? '-' : r.lastPostDays + '天前') + '</td>' +
          '<td style="padding:3px 6px">' + (r.avgLikes ?? '-') + '</td>' +
          '<td style="padding:3px 6px;color:#888">' + (r.source || '') + '</td>' +
          '<td style="padding:3px 6px;color:' + (kill ? '#ff8080' : '#8fb98f') + '">' + (r.verdict || '') + '</td></tr>';
      }
      $('#dfc-table').innerHTML = h + '</tbody></table>';
    }

    $('#dfc-csv').onclick = () => {
      const cols = ['昵称', 'secUid', '作品数', '总获赞', '最近更新天数', '近5条平均赞', '近5条点赞', '互关', '数据源', '判定'];
      const esc = v => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
      const body = (state.rows || []).map(r => [r.name, r.secUid, r.works, r.totalLikes, r.lastPostDays, r.avgLikes, r.likes5, r.mutual ? '是' : '否', r.source, r.verdict].map(esc).join(','));
      const csv = '\uFEFF' + cols.join(',') + '\n' + body.join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'douyin-following-audit.csv';
      a.click();
      pushLog('已导出 CSV');
    };

    $('#dfc-unfollow').onclick = () => {
      const uids = [...box.querySelectorAll('input[type=checkbox][data-uid]')].filter(c => c.checked).map(c => c.dataset.uid);
      if (!uids.length) { pushLog('没有勾选任何账号'); return; }
      const names = (state.rows || []).filter(r => uids.includes(r.secUid)).map(r => r.name);
      if (!confirm('准备取关 ' + uids.length + ' 个账号：\n\n' + names.slice(0, 20).join('、') + (names.length > 20 ? ' …' : '') + '\n\n确定继续？')) return;
      state.phase = 'unfollow'; state.queue = uids; state.uidx = 0; saveState();
      pushLog('开始取关，逐个打开主页点按钮…');
      location.href = 'https://www.douyin.com/user/' + uids[0];
    };

    render();
    window.__dfcRender = render;
  }

  // ---------- 取关流程（在目标主页上） ----------
  async function runUnfollowOnProfile() {
    const uid = state.queue[state.uidx];
    const rec = (state.rows || []).find(r => r.secUid === uid) || {};
    await sleep(2500);
    const btn = [...document.querySelectorAll('button,div,span')]
      .find(e => e.children.length === 0 && /^(已关注|互相关注)$/.test((e.textContent || '').trim()));
    if (btn) {
      btn.click();
      await sleep(600);
      const cfm = [...document.querySelectorAll('button,div,span')]
        .find(e => e.children.length === 0 && /^(确定|确认|取消关注)$/.test((e.textContent || '').trim()));
      if (cfm) { cfm.click(); await sleep(500); }
      pushLog('✅ 已取关 ' + (rec.name || uid) + '（' + (state.uidx + 1) + '/' + state.queue.length + '）');
    } else {
      pushLog('⚠️ ' + (rec.name || uid) + ' 没找到「已关注」按钮，跳过');
    }
    state.uidx++;
    saveState();
    if (state.uidx < state.queue.length) {
      await sleep(1200);
      location.href = 'https://www.douyin.com/user/' + state.queue[state.uidx];
    } else {
      pushLog('🎉 取关流程结束，共处理 ' + state.queue.length + ' 个');
      state.phase = 'done';
      saveState();
      location.href = 'https://www.douyin.com/user/self';
    }
  }

  // ---------- 启动 ----------
  function boot() {
    buildPanel();
    const paintLog = () => { const el = document.querySelector('#dfc-log'); if (el) { el.textContent = (state.log || []).join('\n'); el.scrollTop = 1e6; } };
    const isProfile = location.pathname.startsWith('/user/') && !location.pathname.includes('/user/self');
    if (state.phase === 'scan' && isProfile) {
      pushLog('📄 读取 ' + (state.list[state.idx] ? state.list[state.idx].name : '?') + '（' + (state.idx + 1) + '/' + state.list.length + '）');
      paintLog();
      scanCurrentProfile().then(async () => {
        paintLog();
        state.idx++;
        saveState();
        if (state.idx < state.list.length) {
          await sleep(CFG.stepDelayMs);
          location.href = 'https://www.douyin.com/user/' + state.list[state.idx].secUid;
        } else {
          state.phase = 'done';
          state.log.push('✅ 扫描完成，共 ' + state.rows.length + ' 条，建议取关 ' + state.rows.filter(r => (r.verdict || '').includes('取关')).length + ' 个');
          saveState();
          location.href = 'https://www.douyin.com/user/self';
        }
      });
    } else if (state.phase === 'unfollow' && isProfile) {
      paintLog();
      runUnfollowOnProfile();
    } else if (state.phase === 'done' || (state.rows || []).length) {
      pushLog('已载入上次结果（' + state.rows.length + ' 条）。要重新扫描点「①」。');
      paintLog();
      if (window.__dfcRender) window.__dfcRender();
    } else {
      pushLog('脚本已加载。先打开「我的」主页，再点「① 打开关注列表并扫描」。');
      paintLog();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
