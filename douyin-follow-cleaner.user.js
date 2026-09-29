// ==UserScript==
// @name         Douyin 关注体检 + 批量取关
// @namespace    codex.local
// @version      0.1.0
// @description  扫描我关注的账号（最近作品时间 / 最近5条平均点赞 / 互关状态 / 纯直播），导出 CSV，并按规则批量取关
// @match        https://www.douyin.com/*
// @run-at       document-idle
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
    fetchDelayMs : 700,    // 每个账号之间的间隔，别调太小
    maxScroll    : 80,     // 关注列表最多滚动次数
  };
  // =============================

  let rows = [];        // 扫描结果
  let busy = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- UI ----------
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:16px;top:80px;width:520px;max-height:78vh;z-index:999999;' +
    'background:#181b21;color:#e6e6e6;font:12px/1.5 -apple-system,"PingFang SC",sans-serif;border:1px solid #333;' +
    'border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden';
  box.innerHTML = `
    <div id="dfc-head" style="padding:8px 10px;background:#23262d;cursor:move;display:flex;justify-content:space-between">
      <b>抖音关注体检</b><span id="dfc-close" style="cursor:pointer">✕</span>
    </div>
    <div style="padding:8px 10px;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #2b2f37">
      <button id="dfc-scan">① 扫描关注列表</button>
      <button id="dfc-csv" disabled>② 导出 CSV</button>
      <button id="dfc-unfollow" disabled>③ 批量取关勾选项</button>
      <button id="dfc-clear">清空</button>
    </div>
    <div id="dfc-log" style="padding:6px 10px;height:70px;overflow:auto;background:#12141a;color:#8fb98f;white-space:pre-wrap"></div>
    <div id="dfc-table" style="overflow:auto;flex:1"></div>
  `;
  document.body.appendChild(box);
  const $ = id => box.querySelector(id);
  const log = m => { const el = $('#dfc-log'); el.textContent += m + '\n'; el.scrollTop = el.scrollHeight; };
  $('#dfc-close').onclick = () => box.remove();
  $('#dfc-clear').onclick = () => { rows = []; render(); log('已清空'); };

  // 拖动
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
    window.addEventListener('mouseup', () => dragging = false);
  })();

  // ---------- 从页面 HTML 里挖 JSON ----------
  function extractBlobs(html) {
    const out = [];
    const push = t => { try { out.push(JSON.parse(t)); } catch (e) {} };
    let m;
    const reScript = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    while ((m = reScript.exec(html))) { push(decodeURIComponent(m[1])); push(m[1]); }
    const reRouter = /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/;
    if ((m = html.match(reRouter))) push(m[1]);
    const reState = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/;
    if ((m = html.match(reState))) push(m[1]);
    return out;
  }

  function walkCollect(obj, found, seen) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) { for (const v of obj) walkCollect(v, found, seen); return; }
    const ct = obj.create_time || obj.createTime;
    const st = obj.statistics || obj.stats;
    if (ct && st && (st.digg_count !== undefined || st.diggCount !== undefined)) {
      found.awemes.push({
        ct: Number(ct),
        digg: Number(st.digg_count ?? st.diggCount ?? 0),
        desc: (obj.desc || '').slice(0, 40),
        id: obj.aweme_id || obj.awemeId || '',
      });
    }
    if (!found.user && obj.nickname && (obj.aweme_count !== undefined || obj.sec_uid || obj.uid)) {
      found.user = {
        nickname: obj.nickname,
        works: Number(obj.aweme_count ?? obj.awemeCount ?? -1),
        totalLikes: Number(obj.total_favorited ?? obj.totalFavorited ?? -1),
        followStatus: obj.follow_status ?? obj.followStatus ?? null,
        followerStatus: obj.follower_status ?? obj.followerStatus ?? null,
        secUid: obj.sec_uid || obj.secUid || '',
      };
    }
    for (const k in obj) walkCollect(obj[k], found, seen);
  }

  function parseProfile(html) {
    const found = { user: null, awemes: [] };
    const seen = new Set();
    for (const b of extractBlobs(html)) walkCollect(b, found, seen);
    const uniq = new Map();
    for (const a of found.awemes) if (a.id) uniq.set(a.id, a);
    const awemes = [...uniq.values()].sort((a, b) => b.ct - a.ct).slice(0, 5);
    const now = Date.now() / 1000;
    const last = awemes[0];
    return {
      user: found.user,
      lastPostDays: last ? Math.floor((now - last.ct) / 86400) : null,
      avgLikes: awemes.length ? Math.round(awemes.reduce((s, a) => s + a.digg, 0) / awemes.length) : null,
      likes5: awemes.map(a => a.digg).join('/'),
      sample: last ? last.desc : '',
    };
  }

  // ---------- 打开关注列表并收集账号 ----------
  async function openFollowModal() {
    if (!/\/user\/self/.test(location.pathname)) {
      location.href = 'https://www.douyin.com/user/self';
      return false;
    }
    const clickable = [...document.querySelectorAll('div,span')]
      .find(e => e.children.length === 0 && /^\d+$/.test((e.textContent || '').trim()) &&
                 e.previousElementSibling && /关注/.test(e.previousElementSibling.textContent || ''));
    if (!clickable) { log('❌ 没找到「关注 N」入口（先停在我的主页）'); return false; }
    clickable.click();
    await sleep(2500);
    return true;
  }

  function collectAnchors() {
    return [...document.querySelectorAll('a[href*="/user/MS4w"]')]
      .map(a => ({ name: (a.textContent || '').trim().replace(/\s+/g, ' '), secUid: a.getAttribute('href').split('/user/')[1].split('?')[0] }))
      .filter(x => x.name && x.secUid);
  }

  async function collectFollowList() {
    const map = new Map();
    const first = document.querySelector('a[href*="/user/MS4w"]');
    if (!first) { log('❌ 列表里没有账号链接'); return []; }
    let scroller = first.parentElement;
    while (scroller && scroller !== document.body) {
      const st = getComputedStyle(scroller);
      if (scroller.scrollHeight > scroller.clientHeight + 50 && /auto|scroll/.test(st.overflowY)) break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === document.body) { log('⚠️ 没找到滚动容器，只读当前可见的一屏'); }
    for (let i = 0; i < CFG.maxScroll; i++) {
      collectAnchors().forEach(x => map.set(x.secUid, x));
      log(`   已收集 ${map.size} 个`);
      if (!scroller) break;
      scroller.scrollTop = scroller.scrollHeight;
      const before = map.size;
      await sleep(900);
      if (map.size === before && i > 3) break;
    }
    return [...map.values()];
  }

  // ---------- 判定 ----------
  function decide(r) {
    if (CFG.keepMutual && r.mutual) return '互关-保留';
    if (r.works === 0 && CFG.keepLiveOnly) return '纯直播-保留';
    if (r.lastPostDays !== null && r.lastPostDays > CFG.inactiveDays) return '超30天未更新-取关';
    if (r.avgLikes !== null && r.avgLikes < CFG.minAvgLikes) return '平均点赞<1w-取关';
    if (r.avgLikes === null && r.lastPostDays === null) return '读不到数据-人工看';
    return '保留';
  }

  // ---------- 主流程 ----------
  $('#dfc-scan').onclick = async () => {
    if (busy) return; busy = true;
    try {
      log('① 打开关注列表…');
      if (!(await openFollowModal())) return;
      log('② 滚动收集账号…');
      const list = await collectFollowList();
      log(`   共 ${list.length} 个账号，开始逐个读主页（每个约 1 秒）`);
      rows = [];
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const rec = { ...it, works: null, totalLikes: null, mutual: false, lastPostDays: null, avgLikes: null, likes5: '', sample: '', verdict: '' };
        try {
          const res = await fetch('/user/' + it.secUid, { credentials: 'include' });
          const html = await res.text();
          const p = parseProfile(html);
          if (p.user) {
            rec.works = p.user.works; rec.totalLikes = p.user.totalLikes;
            rec.mutual = p.user.followStatus === 1 && p.user.followerStatus === 1;
          }
          rec.lastPostDays = p.lastPostDays; rec.avgLikes = p.avgLikes; rec.likes5 = p.likes5; rec.sample = p.sample;
          if (p.avgLikes === null && p.lastPostDays === null) log(`   ⚠️ ${it.name} 解析不到作品数据`);
        } catch (e) { log(`   ❌ ${it.name} 抓取失败: ${e.message}`); }
        rec.verdict = decide(rec);
        rows.push(rec);
        if (i % 10 === 0) render();
        await sleep(CFG.fetchDelayMs);
      }
      render();
      log(`✅ 完成，共 ${rows.length} 条。建议取关 ${rows.filter(r => r.verdict.includes('取关')).length} 个`);
      $('#dfc-csv').disabled = false;
      $('#dfc-unfollow').disabled = false;
    } finally { busy = false; }
  };

  function render() {
    const t = $('#dfc-table');
    const head = ['', '昵称', '作品', '总赞', '最近更新', '近5条均赞', '判定'];
    let h = '<table style="width:100%;border-collapse:collapse"><thead><tr>' +
      head.map(x => `<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #2b2f37;position:sticky;top:0;background:#181b21">${x}</th>`).join('') +
      '</tr></thead><tbody>';
    for (const r of rows.slice(0, 400)) {
      const kill = r.verdict.includes('取关');
      h += `<tr style="border-bottom:1px solid #22252b">
        <td style="padding:3px 6px">${kill ? `<input type="checkbox" data-uid="${r.secUid}" checked>` : ''}</td>
        <td style="padding:3px 6px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.name}</td>
        <td style="padding:3px 6px">${r.works ?? '-'}</td>
        <td style="padding:3px 6px">${r.totalLikes ?? '-'}</td>
        <td style="padding:3px 6px">${r.lastPostDays === null ? '-' : r.lastPostDays + '天前'}</td>
        <td style="padding:3px 6px">${r.avgLikes ?? '-'}</td>
        <td style="padding:3px 6px;color:${kill ? '#ff8080' : '#8fb98f'}">${r.verdict}</td>
      </tr>`;
    }
    t.innerHTML = h + '</tbody></table>';
  }

  $('#dfc-csv').onclick = () => {
    const cols = ['昵称', 'secUid', '作品数', '总获赞', '最近更新天数', '近5条平均赞', '近5条点赞', '互关', '判定', '最新作品'];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = rows.map(r => [r.name, r.secUid, r.works, r.totalLikes, r.lastPostDays, r.avgLikes, r.likes5, r.mutual ? '是' : '否', r.verdict, r.sample].map(esc).join(','));
    const csv = '\uFEFF' + cols.join(',') + '\n' + body.join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'douyin-following-audit.csv';
    a.click();
    log('已导出 CSV 到下载目录');
  };

  $('#dfc-unfollow').onclick = async () => {
    if (busy) return;
    const uids = [...box.querySelectorAll('input[type=checkbox][data-uid]')].filter(c => c.checked).map(c => c.dataset.uid);
    if (!uids.length) { log('没有勾选任何账号'); return; }
    const names = rows.filter(r => uids.includes(r.secUid)).map(r => r.name);
    if (!confirm(`准备取关 ${uids.length} 个账号：\n\n${names.slice(0, 20).join('、')}${names.length > 20 ? ' …' : ''}\n\n确定继续？`)) return;
    busy = true;
    try {
      log('打开关注列表准备取关…');
      if (!(await openFollowModal())) return;
      await sleep(2000);
      let ok = 0;
      for (const r of rows.filter(r => uids.includes(r.secUid))) {
        try {
          const input = [...document.querySelectorAll('input')].find(i => /搜索用户名字|搜索/.test(i.placeholder || ''));
          if (!input) { log('❌ 找不到搜索框，停止'); break; }
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, r.name);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(1500);
          const btn = [...document.querySelectorAll('button,div,span')]
            .find(e => e.children.length === 0 && /^已关注$/.test((e.textContent || '').trim()));
          if (!btn) { log(`   ⚠️ ${r.name} 没找到「已关注」按钮，跳过`); continue; }
          btn.click();
          await sleep(300);
          const cfm = [...document.querySelectorAll('button,div,span')]
            .find(e => e.children.length === 0 && /^(确定|确认|取消关注)$/.test((e.textContent || '').trim()));
          if (cfm) { cfm.click(); await sleep(400); }
          ok++; log(`   ✅ 已取关 ${r.name}（${ok}/${uids.length}）`);
          await sleep(1800);
        } catch (e) { log(`   ❌ ${r.name}: ${e.message}`); }
      }
      log(`完成：成功取关 ${ok} 个`);
    } finally { busy = false; }
  };

  log('脚本已加载。先停在「我的」主页，再点「① 扫描关注列表」。');
})();
