// ==UserScript==
// @name         Douyin 关注体检 + 批量取关
// @namespace    codex.local
// @version      0.3.0
// @description  用抖音自己的接口扫描关注列表（最近作品时间 / 近5条平均点赞 / 互关状态），导出 CSV，并在关注弹窗里批量取关
// @match        https://www.douyin.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ======== 规则（可改） ========
  const CFG = {
    inactiveDays   : 30,     // 超过 N 天没发作品 → 建议取关
    minAvgLikes    : 10000,  // 最近 5 条平均点赞低于这个数 → 建议取关
    keepMutual     : true,   // 互关的保留
    keepLiveOnly   : true,   // 0 作品的纯直播号保留
    apiDelayMs     : 1200,   // 每个账号之间的间隔（太快会被风控 444）
    backoffMs      : 45000,  // 被风控后的退避时间
    maxRetry       : 5,      // 单个账号最多重试次数
    postCount      : 5,      // 取最近几条作品算平均点赞
    followPageSize : 20,     // 关注列表分页大小
    unfollowDelay  : 1100    // 取关间隔
  };
  // =============================

  const SKEY = 'dfc_state_v3';
  const API = {
    following: '/aweme/v1/web/user/following/list/',
    posts    : '/aweme/v1/web/aweme/post/'
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = s => document.querySelector(s);

  // ---------- 状态（存 sessionStorage，刷新可续跑） ----------
  let state = { phase: 'idle', self: null, users: [], rows: [], idx: 0, queue: [], qidx: 0, nOk: 0, nMiss: 0, backoffs: 0, log: [] };
  try { const s = sessionStorage.getItem(SKEY); if (s) state = Object.assign(state, JSON.parse(s)); } catch (e) {}
  if (!state.log) state.log = [];
  const saveState = () => { try { sessionStorage.setItem(SKEY, JSON.stringify(state)); } catch (e) {} };
  const paintLog = () => { const el = $('#dfc-log'); if (el) { el.textContent = (state.log || []).join('\n'); el.scrollTop = 1e6; } };
  const pushLog = m => {
    state.log.push('[' + new Date().toTimeString().slice(0, 8) + '] ' + m);
    if (state.log.length > 80) state.log.shift();
    saveState();
    paintLog();
  };

  // ---------- 偷看页面自己的请求，拿到自己的 user_id / sec_user_id ----------
  const seenListUrls = [];
  (function hookNetwork() {
    try {
      const XO = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u, ...rest) {
        try { if (u && String(u).indexOf('/user/following/list') >= 0) seenListUrls.push(String(u)); } catch (e) {}
        return XO.call(this, m, u, ...rest);
      };
      const of = window.fetch;
      window.fetch = function (...args) {
        try {
          const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          if (String(u).indexOf('/user/following/list') >= 0) seenListUrls.push(String(u));
        } catch (e) {}
        return of.apply(this, args);
      };
    } catch (e) {}
  })();

  function selfFromCapture() {
    const u = seenListUrls[seenListUrls.length - 1] || '';
    const qi = u.indexOf('?');
    if (qi < 0) return null;
    const q = new URLSearchParams(u.slice(qi + 1));
    const out = { user_id: q.get('user_id'), sec_user_id: q.get('sec_user_id'), webid: q.get('webid'), uifid: q.get('uifid') };
    return (out.user_id && out.sec_user_id) ? out : null;
  }

  const COMMON = () => {
    const c = {
      device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
      pc_client_type: '1', version_code: '170400', version_name: '17.4.0',
      cookie_enabled: 'true', screen_width: String(screen.width), screen_height: String(screen.height),
      browser_language: navigator.language || 'zh-CN', browser_platform: navigator.platform || 'MacIntel',
      browser_name: 'Chrome', browser_version: '154.0.0.0', browser_online: 'true',
      engine_name: 'Blink', engine_version: '154.0.0.0',
      os_name: 'Mac OS', os_version: '10.15.7', platform: 'PC',
      downlink: '10', effective_type: '4g', round_trip_time: '0'
    };
    if (state.self && state.self.webid) c.webid = state.self.webid;
    if (state.self && state.self.uifid) c.uifid = state.self.uifid;
    return c;
  };
  const apiGet = (path, extra) =>
    fetch(path + '?' + new URLSearchParams(Object.assign({}, COMMON(), extra)).toString(), { credentials: 'include' });

  // ---------- 判定 ----------
  const isMutual = u => u.followStatus === 2 || (u.followStatus === 1 && u.followerStatus === 1);

  function decide(r) {
    if (CFG.keepMutual && r.mutual) return '互关-保留';
    if (!(r.works > 0) && CFG.keepLiveOnly) return '纯直播-保留';
    if (r.src === 'nodata') return '读不到数据-人工看';
    if (r.lastPostDays !== null && r.lastPostDays !== undefined && r.lastPostDays > CFG.inactiveDays) return '超' + CFG.inactiveDays + '天未更新-取关';
    if (r.avgLikes !== null && r.avgLikes !== undefined && r.avgLikes < CFG.minAvgLikes) return '近5条均赞<' + (CFG.minAvgLikes / 10000) + 'w-取关';
    if ((r.avgLikes === null || r.avgLikes === undefined) && (r.lastPostDays === null || r.lastPostDays === undefined)) return '读不到数据-人工看';
    return '保留';
  }

  // ---------- ① 扫描 ----------
  async function openFollowDialog() {
    const cands = [...document.querySelectorAll('div,span')]
      .filter(e => e.children.length === 0 && /^\d+$/.test((e.textContent || '').trim()));
    const t = cands.find(e => e.parentElement && /关注/.test(e.parentElement.textContent || ''));
    if (!t) return false;
    t.click();
    if (t.parentElement) t.parentElement.click();
    return true;
  }

  async function scanAll() {
    if (state.phase === 'scan') { pushLog('⚠️ 已经在扫描中了'); return; }
    const fresh = !state.users.length || confirm('上次已有 ' + state.users.length + ' 条账号记录，其中 ' + state.rows.length + ' 条已取到数据。\n\n确定＝从头重新扫描\n取消＝接着上次继续');
    if (fresh) { state.users = []; state.rows = []; state.idx = 0; state.log = []; state.backoffs = 0; }
    state.phase = 'scan'; saveState(); render();

    try {
      // 自己的身份：需要点开一次关注弹窗，让页面自己发一次列表请求
      if (!state.self) {
        pushLog('① 打开关注弹窗，读取自己的账号信息…');
        const opened = await openFollowDialog();
        if (!opened) pushLog('⚠️ 没找到「关注 N」入口，手动点开一下也可以');
        for (let i = 0; i < 20 && !state.self; i++) { state.self = selfFromCapture(); await sleep(700); }
        if (!state.self) { pushLog('❌ 拿不到自己的 user_id / sec_user_id，手动点开一次「关注」弹窗再重试'); state.phase = 'idle'; saveState(); render(); return; }
        saveState();
        pushLog('   身份 OK（user_id=' + state.self.user_id + '）');
      }

      // 收集关注列表
      if (!state.users.length) {
        pushLog('② 拉取关注列表…');
        const seen = new Map();
        let offset = 0;
        while (offset < 4000) {
          const res = await apiGet(API.following, {
            user_id: state.self.user_id, sec_user_id: state.self.sec_user_id,
            offset: String(offset), min_time: '0', max_time: '0', count: String(CFG.followPageSize),
            source_type: '4', gps_access: '0', address_book_access: '0', is_top: '1', update_version_code: '170400'
          });
          if (res.status !== 200) {
            state.backoffs++; pushLog('⚠️ 列表接口 ' + res.status + '，退避 ' + (CFG.backoffMs / 1000) + 's');
            saveState(); await sleep(CFG.backoffMs); continue;
          }
          const j = await res.json();
          const list = j.followings || [];
          for (const u of list) {
            seen.set(u.sec_uid, {
              name: u.nickname, secUid: u.sec_uid, works: u.aweme_count, totalLikes: u.total_favorited,
              followStatus: u.follow_status, followerStatus: u.follower_status, uniqueId: u.unique_id
            });
          }
          state.users = [...seen.values()]; saveState(); render();
          pushLog('   已收集 ' + seen.size + ' 个');
          if (!j.has_more || !list.length) break;
          offset += CFG.followPageSize;
          await sleep(250);
        }
        if (!state.users.length) { pushLog('❌ 一个都没收到，停止'); state.phase = 'idle'; saveState(); render(); return; }
        pushLog('   共 ' + state.users.length + ' 个，开始逐个取作品数据（每个约 ' + (CFG.apiDelayMs / 1000) + 's）');
      }

      // 逐个拉最近作品
      state.idx = state.rows.length;
      while (state.idx < state.users.length) {
        const u = state.users[state.idx];
        const mutual = isMutual(u);
        if (CFG.keepMutual && mutual) {
          state.rows.push(Object.assign({}, u, { mutual: true, lastPostDays: null, avgLikes: null, likes5: '', src: 'mutual' }));
        } else if (!(u.works > 0)) {
          state.rows.push(Object.assign({}, u, { mutual: false, lastPostDays: null, avgLikes: null, likes5: '', src: 'works0' }));
        } else {
          let ok = false;
          for (let attempt = 0; attempt < CFG.maxRetry && !ok; attempt++) {
            let res;
            try {
              res = await apiGet(API.posts, {
                sec_user_id: u.secUid, max_cursor: '0', count: String(CFG.postCount),
                publish_video_strategy_type: '2', version_code: '170400', version_name: '17.4.0'
              });
            } catch (e) { res = { status: 0 }; }
            if (res.status !== 200) {
              state.backoffs++; pushLog('⚠️ 作品接口 ' + res.status + '（风控），退避 ' + (CFG.backoffMs / 1000) + 's 后重试');
              saveState(); await sleep(CFG.backoffMs); continue;
            }
            const j = await res.json();
            const list = (j.aweme_list || []).slice().sort((a, b) => b.create_time - a.create_time);
            const top = list.slice(0, CFG.postCount);
            const now = Date.now() / 1000;
            state.rows.push(Object.assign({}, u, {
              mutual: mutual,
              lastPostDays: top[0] ? Math.floor((now - top[0].create_time) / 86400) : null,
              avgLikes: top.length ? Math.round(top.reduce((s, a) => s + ((a.statistics && a.statistics.digg_count) || 0), 0) / top.length) : null,
              likes5: top.map(a => (a.statistics && a.statistics.digg_count) || 0).join('/'),
              src: top.length ? 'api' : 'nodata'
            }));
            ok = true;
          }
          if (!ok) state.rows.push(Object.assign({}, u, { mutual: mutual, lastPostDays: null, avgLikes: null, likes5: '', src: 'failed' }));
        }
        state.idx++;
        saveState(); render();
        if (state.idx % 20 === 0) pushLog('   进度 ' + state.idx + ' / ' + state.users.length);
        await sleep(CFG.apiDelayMs);
      }

      state.phase = 'done';
      const kill = state.rows.filter(r => (decide(r) || '').indexOf('取关') >= 0).length;
      pushLog('✅ 扫描完成：' + state.rows.length + ' 条，建议取关 ' + kill + ' 个' + (state.backoffs ? '（退避 ' + state.backoffs + ' 次）' : ''));
    } catch (e) {
      pushLog('❌ 扫描出错：' + (e && e.message ? e.message : e));
    }
    saveState(); render();
  }

  // ---------- ③ 批量取关（关注弹窗里用搜索框定位，再点「已关注」） ----------
  const visibleInput = () => {
    const ins = [...document.querySelectorAll('input')].filter(i => i.placeholder === '搜索用户名字或抖音号');
    for (const i of ins) {
      const r = i.getBoundingClientRect();
      if (r.width < 40) continue;
      const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (h && (i === h || i.contains(h) || h.contains(i))) return i;
    }
    return ins.find(i => i.getBoundingClientRect().width > 40) || null;
  };
  const setInput = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const followBtnOf = secUid => {
    const a = document.querySelector('a[href*="/user/' + secUid + '"]');
    if (!a) return null;
    let el = a;
    while (el && el !== document.body) {
      const b = el.querySelector && el.querySelector('button');
      if (b && /^(已关注|关注)$/.test(b.textContent.trim())) return b;
      el = el.parentElement;
    }
    return null;
  };

  async function unfollowOne(secUid, name, uniqueId) {
    const keys = [];
    if (uniqueId && String(uniqueId).trim()) keys.push(String(uniqueId).trim());
    keys.push(name, (name || '').slice(0, 4), (name || '').slice(0, 3));
    const inp = visibleInput();
    if (!inp) return 'no-input';
    for (const k of keys) {
      if (!k) continue;
      setInput(inp, k);
      await sleep(1500);
      let b = followBtnOf(secUid);
      if (!b) { await sleep(900); b = followBtnOf(secUid); }
      if (!b) continue;
      if (b.textContent.trim() !== '已关注') { setInput(inp, ''); await sleep(400); return 'already'; }
      b.click();
      await sleep(1000);
      const b2 = followBtnOf(secUid);
      const txt = b2 ? b2.textContent.trim() : 'gone';
      setInput(inp, '');
      await sleep(500);
      return txt === '已关注' ? 'fail' : 'ok';
    }
    setInput(inp, '');
    await sleep(400);
    return 'miss';
  }

  async function unfollowAll() {
    const checked = [...document.querySelectorAll('#dfc-box input[type=checkbox][data-uid]')].filter(c => c.checked).map(c => c.dataset.uid);
    if (!checked.length) { pushLog('没有勾选任何账号'); return; }
    const names = checked.map(uid => { const r = state.rows.find(x => x.secUid === uid) || {}; return r.name || uid; });
    if (!confirm('准备取关 ' + checked.length + ' 个账号：\n\n' + names.slice(0, 20).join('、') + (names.length > 20 ? ' …等' : '') + '\n\n确定继续？')) return;
    if (!visibleInput()) {
      pushLog('③ 先把「关注」弹窗打开…');
      await openFollowDialog();
      await sleep(2500);
    }
    if (!visibleInput()) { pushLog('❌ 找不到关注弹窗的搜索框，停止'); return; }

    state.phase = 'unfollow';
    state.queue = checked;
    state.qidx = 0;
    saveState();
    pushLog('③ 开始取关，共 ' + state.queue.length + ' 个');
    while (state.qidx < state.queue.length) {
      const uid = state.queue[state.qidx];
      const r = state.rows.find(x => x.secUid === uid) || {};
      const out = await unfollowOne(uid, r.name, r.uniqueId);
      if (out === 'ok') { state.nOk++; }
      else if (out === 'fail') { state.backoffs++; pushLog('⚠️ ' + r.name + ' 取关失败，稍后重试'); await sleep(3000); continue; }
      else if (out === 'miss') { state.nMiss++; pushLog('⚠️ 搜不到 ' + r.name + '，跳过'); }
      else if (out === 'no-input') { pushLog('❌ 搜索框没了，停止'); break; }
      state.qidx++;
      saveState();
      if (state.qidx % 10 === 0) pushLog('   已取关 ' + state.nOk + ' / ' + state.queue.length);
      await sleep(CFG.unfollowDelay);
    }
    state.phase = 'done'; state.queue = []; state.qidx = 0; saveState();
    pushLog('✅ 取关结束：成功 ' + state.nOk + '，搜不到 ' + state.nMiss);
  }

  // ---------- 导出 CSV ----------
  function exportCsv() {
    const cols = ['昵称', 'secUid', '作品数', '总获赞', '最近更新天数', '近5条平均赞', '近5条点赞', '互关', '数据源', '判定'];
    const esc = v => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
    const body = (state.rows || []).map(r =>
      [r.name, r.secUid, r.works, r.totalLikes, r.lastPostDays, r.avgLikes, r.likes5, r.mutual ? '是' : '否', r.src, decide(r)].map(esc).join(','));
    const csv = '\uFEFF' + cols.join(',') + '\n' + body.join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'douyin-following-audit.csv';
    a.click();
    pushLog('已导出 CSV');
  }

  // ---------- UI ----------
  function render() {
    const box = $('#dfc-box');
    if (!box) return;
    const rows = state.rows || [];
    const kill = rows.filter(r => (decide(r) || '').indexOf('取关') >= 0);
    $('#dfc-status').textContent = state.phase === 'scan'
      ? '扫描中 ' + state.idx + ' / ' + (state.users.length || '?') + '（建议取关 ' + kill.length + '）'
      : rows.length ? '共 ' + rows.length + ' 条，建议取关 ' + kill.length + ' 个' : '还没扫描';
    $('#dfc-csv').disabled = !rows.length;
    $('#dfc-unfollow').disabled = !kill.length;
    const head = ['', '昵称', '作品', '总赞', '最近更新', '近5均赞', '数据源', '判定'];
    let h = '<table style="width:100%;border-collapse:collapse"><thead><tr>' +
      head.map(x => '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #2b2f37;position:sticky;top:0;background:#181b21">' + x + '</th>').join('') +
      '</tr></thead><tbody>';
    for (const r of rows.slice(0, 800)) {
      const v = decide(r);
      const bad = v.indexOf('取关') >= 0;
      h += '<tr style="border-bottom:1px solid #22252b">' +
        '<td style="padding:3px 6px">' + (bad ? '<input type="checkbox" data-uid="' + r.secUid + '" checked>' : '') + '</td>' +
        '<td style="padding:3px 6px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (r.name || '') + '</td>' +
        '<td style="padding:3px 6px">' + (r.works === undefined || r.works === null ? '-' : r.works) + '</td>' +
        '<td style="padding:3px 6px">' + (r.totalLikes === undefined || r.totalLikes === null ? '-' : r.totalLikes) + '</td>' +
        '<td style="padding:3px 6px">' + (r.lastPostDays === null || r.lastPostDays === undefined ? '-' : r.lastPostDays + '天前') + '</td>' +
        '<td style="padding:3px 6px">' + (r.avgLikes === null || r.avgLikes === undefined ? '-' : r.avgLikes) + '</td>' +
        '<td style="padding:3px 6px;color:#888">' + (r.src || '') + '</td>' +
        '<td style="padding:3px 6px;color:' + (bad ? '#ff8080' : '#8fb98f') + '">' + v + '</td></tr>';
    }
    $('#dfc-table').innerHTML = h + '</tbody></table>';
    paintLog();
  }

  function buildPanel() {
    if ($('#dfc-box')) return;
    const box = document.createElement('div');
    box.id = 'dfc-box';
    box.style.cssText = 'position:fixed;right:16px;top:80px;width:600px;max-height:78vh;z-index:999999;' +
      'background:#181b21;color:#e6e6e6;font:12px/1.5 -apple-system,"PingFang SC",sans-serif;border:1px solid #333;' +
      'border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden';
    box.innerHTML =
      '<div id="dfc-head" style="padding:8px 10px;background:#23262d;cursor:move;display:flex;justify-content:space-between">' +
        '<b>抖音关注体检 v0.3</b><span id="dfc-close" style="cursor:pointer">✕</span></div>' +
      '<div style="padding:8px 10px;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #2b2f37">' +
        '<button id="dfc-scan">① 扫描关注列表</button>' +
        '<button id="dfc-csv">② 导出 CSV</button>' +
        '<button id="dfc-unfollow">③ 批量取关勾选项</button>' +
        '<button id="dfc-diag">复制诊断</button>' +
        '<button id="dfc-clear">清空</button>' +
        '<span id="dfc-status" style="align-self:center;color:#8fb98f"></span></div>' +
      '<div id="dfc-table" style="overflow:auto;max-height:46vh"></div>' +
      '<pre id="dfc-log" style="margin:0;padding:8px 10px;height:130px;overflow:auto;background:#11131a;color:#9aa0aa;font-size:11px;white-space:pre-wrap"></pre>';
    document.body.appendChild(box);
    box.querySelectorAll('button').forEach(b => {
      b.style.cssText = 'background:#2b3038;color:#e6e6e6;border:1px solid #3a4150;border-radius:6px;padding:4px 8px;cursor:pointer';
    });

    $('#dfc-close').onclick = () => box.remove();
    $('#dfc-scan').onclick = () => scanAll();
    $('#dfc-csv').onclick = () => exportCsv();
    $('#dfc-unfollow').onclick = () => unfollowAll();
    $('#dfc-clear').onclick = () => {
      state = { phase: 'idle', self: null, users: [], rows: [], idx: 0, queue: [], qidx: 0, nOk: 0, nMiss: 0, backoffs: 0, log: [] };
      saveState(); render();
    };
    $('#dfc-diag').onclick = () => {
      const d = [
        'phase=' + state.phase, 'users=' + state.users.length, 'rows=' + state.rows.length, 'idx=' + state.idx,
        'backoffs=' + state.backoffs, 'ok=' + state.nOk, 'miss=' + state.nMiss,
        'self=' + (state.self ? state.self.user_id : 'null'),
        'scrollers=' + [...document.querySelectorAll('div.aQVXLJB7')].length,
        'cards=' + document.querySelectorAll('div.OlxToPIh').length
      ].join(' | ');
      const txt = d + '\n' + (state.log || []).slice(-20).join('\n');
      navigator.clipboard.writeText(txt).then(() => pushLog('诊断信息已复制'), () => pushLog(txt));
    };
    // 拖动面板
    (() => {
      let sx, sy, ox, oy, dragging = false;
      $('#dfc-head').addEventListener('mousedown', e => {
        dragging = true; sx = e.clientX; sy = e.clientY;
        const r = box.getBoundingClientRect(); ox = r.left; oy = r.top;
        e.preventDefault();
      });
      window.addEventListener('mousemove', e => {
        if (!dragging) return;
        box.style.left = (ox + e.clientX - sx) + 'px';
        box.style.top = (oy + e.clientY - sy) + 'px';
        box.style.right = 'auto';
      });
      window.addEventListener('mouseup', () => { dragging = false; });
    })();
    render();
  }

  // ---------- 启动 ----------
  function boot() {
    buildPanel();
    if (state.phase === 'scan') {
      pushLog('检测到上次扫描未完成（' + state.rows.length + '/' + (state.users.length || '?') + '），点「①」继续');
    } else if (state.rows.length) {
      pushLog('已载入上次结果（' + state.rows.length + ' 条）。要重新扫描点「①」。');
    } else {
      pushLog('脚本已加载。先停在「我的」主页，再点「① 扫描关注列表」。');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
