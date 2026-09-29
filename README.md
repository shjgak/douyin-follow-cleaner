# Douyin Follow Cleaner · 抖音关注清理

[English](#english) | [中文](#中文)

---

## English

A Tampermonkey userscript that audits everyone you follow on Douyin and helps you unfollow dead accounts in bulk. It adds a small panel to douyin.com that:

- **Scans your following list** — collects every account you follow
- **Audits each account** — records works count, total likes, days since the last post, average likes of the latest 5 videos, and whether you follow each other
- **Judges by your rules** — configurable thresholds; defaults are "no post in 30 days" and "latest-5 average below 10,000 likes"
- **Leaves mutual follows and livestream-only accounts alone** (configurable)
- **Exports a CSV** so you can review everything before anything happens
- **Unfollows in bulk** — only the accounts you tick, after a confirmation dialog

### Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser
2. Open the Tampermonkey dashboard → **+** (new script)
3. Paste the contents of `douyin-follow-cleaner.user.js`, then press **Cmd/Ctrl + S**
4. Open douyin.com — a dark panel appears in the top-right corner

### Usage

1. Open **我的** (your own profile) on douyin.com
2. Click **① 扫描关注列表** — the script opens the following dialog, scrolls to collect every account, then reads each profile
3. Review the table, then click **② 导出 CSV** if you want a copy
4. Tick the accounts you want gone and click **③ 批量取关勾选项** — it lists the names and asks for confirmation first

### Rules

Edit `CFG` at the top of the script:

| Key | Default | Meaning |
| --- | --- | --- |
| `inactiveDays` | 30 | no new post for N days → unfollow |
| `minAvgLikes` | 10000 | latest-5 average likes below N → unfollow |
| `keepMutual` | true | never unfollow accounts that follow you back |
| `keepLiveOnly` | true | keep accounts with 0 works (livestream-only) |
| `fetchDelayMs` | 700 | delay between profile reads, in ms |

### Notes

- The script only reads profile pages and unfollows the accounts you tick. It never likes, follows, comments or posts.
- Everything lives in the page's memory; nothing is written to disk until you click "导出 CSV".
- Douyin changes its page structure often. If the log shows `解析不到作品数据` for many accounts, the parser needs an update — open an issue with the log output.

### Repo layout

```
douyin-follow-cleaner.user.js   the userscript
README.md
LICENSE
```

### Limitations

- Page structures change; the profile parser may need maintenance
- No official Douyin API is used, so anything the web page does not expose cannot be audited
- Bulk unfollowing still runs in your browser tab — keep it in the foreground

---

## 中文

一个 Tampermonkey 脚本：体检你在抖音关注的所有账号，帮你批量取关那些已经"死掉"的关注。装上之后 douyin.com 右上角会多一个小面板：

- **扫描关注列表** —— 把你关注的账号全收下来（滚动加载，不只当前一屏）
- **逐个体检** —— 记录作品数、总获赞、距最近一次发布多少天、最近 5 条的平均点赞、以及**是否互关**
- **按你的规则判定** —— 阈值可改，默认是「30 天没发作品」或「最近 5 条平均点赞低于 1 万」
- **互关的和纯直播号不动**（可开关）
- **导出 CSV** —— 动手之前先拿到一份可核对的表
- **批量取关** —— 只取关你勾选的，且会先弹出确认框列出名字

### 安装

1. 浏览器里装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开 Tampermonkey 管理面板 → **+**（新建脚本）
3. 把 `douyin-follow-cleaner.user.js` 的内容粘进去，**Cmd/Ctrl + S** 保存
4. 打开 douyin.com，右上角出现深色小面板

### 用法

1. 先在 douyin.com 打开 **我的**（自己的主页）
2. 点 **① 扫描关注列表** —— 脚本自动打开关注弹窗、滚动收全账号，再逐个读主页
3. 看表格，需要留档就点 **② 导出 CSV**
4. 勾掉要清理的，点 **③ 批量取关勾选项** —— 会先列出名字让你确认

### 规则

改脚本开头的 `CFG`：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `inactiveDays` | 30 | 超过 N 天没发作品 → 取关 |
| `minAvgLikes` | 10000 | 最近 5 条平均点赞低于 N → 取关 |
| `keepMutual` | true | 互关的永不动 |
| `keepLiveOnly` | true | 0 作品的纯直播号保留 |
| `fetchDelayMs` | 700 | 每个账号之间的间隔（毫秒） |

### 说明

- 脚本只读主页 + 取关你勾选的账号，不点赞、不关注、不评论、不发布。
- 数据只存在页面内存里，只有你点「导出 CSV」才会写到本地。
- 抖音页面结构改得勤。如果日志里大量出现 `解析不到作品数据`，说明解析要更新——把日志贴个 issue。

### 仓库结构

```
douyin-follow-cleaner.user.js   脚本本体
README.md
LICENSE
```

### 限制

- 页面结构会变，解析逻辑需要跟着维护
- 没用官方 API，网页不暴露的数据就读不到
- 批量取关仍然跑在浏览器标签页里，跑的时候别把标签页切到后台
