"use strict";
// e2e：electron scripts/e2e-check.cjs
// 用临时 userData 跑真实主进程 + 渲染进程，驱动 UI 验证：
//  1) 分组创建（侧边栏 UI 流程 + 详情弹窗内联流程）
//  2) 账号 ID 显示（登录名而非 session 用户 UUID，避免 usage 链接 404）
//  3) 添加账号弹窗（三个平台分支）、打开账号窗口、表格视图、卡片对齐
//  4) ccam:// URL Scheme 解析（主进程侧，渲染层入口见 5c 注释）
// 可选线上验证（不传则跳过）：
//  CC_COOKIE_FILE=<含 Cookie 的文件路径>   -> 验证会话捕获/离线登录名解码/存量 UUID 修复
//  CC_APIKEY_FILE=<含 API Key 的文件路径>  -> 验证 API Key 额度通道
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Windows 常见场景：系统代理关闭但终端设置了 HTTPS_PROXY。
// Electron 不总是继承终端代理，登录窗口用独立分区，必须在测试进程显式传入。
const e2eProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (e2eProxy) {
  const proxyUrl = new URL(e2eProxy);
  const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, "");
  const proxyPort = proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80);
  app.commandLine.appendSwitch("proxy-server", `${proxyHost}:${proxyPort}`);
}

// 终端提前关闭（如管道被断开/被 head 截断）时，console.log 会抛 EPIPE，
// Electron 会弹出"主进程未捕获异常"对话框。这里静默吞掉 EPIPE，脚本继续跑完，
// 最后一次 app.exit 仍会返回真实结果码。
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e && e.code === "EPIPE") return; // 吞掉，不中断测试
    throw e; // 其他写错误照常暴露
  });
}

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-"));
  app.setPath("userData", tmp);
  // 模拟浏览器一键添加时：临时 userData 中不存在本机代理，
  // 关闭自动代理，避免外网可用时的额外开销（不影响本地 scheme 断言）。
  try {
    session.defaultSession.setProxy({ mode: "system" });
  } catch {}

const failures = [];
function check(name, cond, detail) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  -> " + detail));
  if (!cond) failures.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const storage = require("../src/main/storage.cjs");
  const accounts = require("../src/main/accounts.cjs");
  const ipc = require("../src/main/ipc.cjs");
  const browser = require("../src/main/browser.cjs");
  const sessions = require("../src/main/sessions.cjs");
  const quota = require("../src/main/quota.cjs");
  storage.load();

  const acc = accounts.create({ accountId: "10000001", email: "10000001@example.com", displayName: "测试账号" });
  // 预置趋势历史，验证详情弹窗趋势迷你图渲染
  {
    const local = accounts.findLocal(acc.id);
    const now = Date.now();
    local.quotaHistory = [
      { at: new Date(now - 200 * 60e3).toISOString(), month: { remaining: 40, used: 60, cap: 100 }, fiveHour: { used: 2, cap: 14 }, weekly: { used: 5, cap: 35 } },
      { at: new Date(now - 150 * 60e3).toISOString(), month: { remaining: 30, used: 70, cap: 100 }, fiveHour: { used: 6, cap: 14 }, weekly: { used: 12, cap: 35 } },
      { at: new Date(now - 100 * 60e3).toISOString(), month: { remaining: 25, used: 75, cap: 100 }, fiveHour: { used: 10, cap: 14 }, weekly: { used: 20, cap: 35 } },
      { at: new Date(now - 50 * 60e3).toISOString(), month: { remaining: 20, used: 80, cap: 100 }, fiveHour: { used: 4, cap: 14 }, weekly: { used: 28, cap: 35 } },
      { at: new Date(now).toISOString(), month: { remaining: 15, used: 85, cap: 100 }, fiveHour: { used: 7, cap: 14 }, weekly: { used: 31, cap: 35 } },
    ];
    // 预置额度快照（月剩余 0.9 < 默认阈值 $2；周 31/35≈88.6% ≥75% → 应触发列表标红）
    local.quota = {
      channel: "internal-cookie",
      month: { remaining: 0.9, used: 69.1, cap: 70, periodEnd: new Date(now + 3 * 86400e3).toISOString() },
      weekly: { used: 31, cap: 35, resetAt: now + 3600e3 },
      fiveHour: { used: 7, cap: 14, resetAt: now + 1200e3 },
    };
    local.quotaFetchedAt = new Date(now).toISOString();
    storage.save();
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "main", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const events = [];
  browser.setEventHandler((p) => events.push(p));
  ipc.init(win);
  await win.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"));
  await sleep(1800);

  const root = await win.webContents.executeJavaScript("document.getElementById('root').childElementCount");
  check("React 挂载", root >= 1, "root children=" + root);

  // ---------- 1) 账号 ID（bug 4） ----------
  const list = await win.webContents.executeJavaScript("window.cc.invoke('accounts:list')");
  const accPub = list.data && list.data.find((a) => a.id === acc.id);
  check("账号列表包含新账号", Boolean(accPub), JSON.stringify(list));
  check("accountId 为登录名（非 UUID）", accPub && accPub.accountId === "10000001", JSON.stringify(accPub && { accountId: accPub.accountId }));

  await win.webContents.executeJavaScript("document.querySelector('.card').click(); true");
  let detailId = "";
  for (let i = 0; i < 10; i++) {
    detailId = await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.modal');
      if (!m) return '';
      const f = [...m.querySelectorAll('.field')].find((x) => {
        const l = x.querySelector('label');
        return l && l.textContent.includes('账号ID');
      });
      if (!f) return '';
      const inp = f.querySelector('input');
      return inp ? inp.value : '';
    })()`);
    if (detailId) break;
    await sleep(500);
  }
  if (!detailId) {
    const dbg = await win.webContents.executeJavaScript(`(() => {
      const modals = [...document.querySelectorAll('.modal')];
      const out = { count: modals.length };
      if (modals.length) {
        const m = modals[modals.length - 1];
        out.title = (m.querySelector('h2') || {}).textContent || '';
        const fields = [...m.querySelectorAll('.field')];
        fields.forEach((x) => {
          const l = x.querySelector('label');
          if (l && /账号ID|显示名称|邮箱/.test(l.textContent)) {
            out[l.textContent.slice(0, 6)] = (x.querySelector('input') || {}).value;
          }
        });
      }
      const card = document.querySelector('.card');
      out.cardName = card ? (card.querySelector('.name') || {}).textContent : '';
      return JSON.stringify(out);
    })()`);
    console.log("DEBUG detail modal: " + dbg);
  }
  check("详情弹窗账号ID=10000001", detailId === "10000001", String(detailId));
  const chart = await win.webContents.executeJavaScript(`(() => {
    const m = document.querySelector('.modal');
    const c = m ? m.querySelector('.trend-chart') : null;
    if (!c) return { err: 'no-chart' };
    const svg = c.querySelector('svg');
    const lines = document.querySelectorAll('.trend-chart path[stroke-width]').length;
    return { svg: !!svg, lines, legend: (c.textContent || '').replace(/\\s+/g, ' ').slice(0, 60) };
  })()`);
  check("详情弹窗趋势迷你图渲染(2条折线)", chart.svg === true && chart.lines === 2, JSON.stringify(chart));
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.modal .actions .btn')].find((b) => b.textContent.trim() === '关闭').click(); true`);
  await sleep(300);

  // ---------- 2) 侧边栏新建分组（bug 3 入口1） ----------
  await win.webContents.executeJavaScript("document.querySelector('.sidebar .new-group').click(); true");
  await sleep(200);
  const g1 = await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('.new-group-form input');
    if (!input) return { err: 'no-input' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'UI分组X');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const btn = document.querySelector('.new-group-btns .btn.primary');
    if (!btn) return { err: 'no-btn' };
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    const g = await window.cc.invoke('groups:list');
    return { ok: g.ok, names: (g.data || []).map((x) => x.name) };
  })()`);
  check("侧边栏新建分组成功", g1.ok === true && g1.names.includes("UI分组X"), JSON.stringify(g1));
  const sidebarHas = await win.webContents.executeJavaScript("document.querySelector('.sidebar').textContent.includes('UI分组X')");
  check("侧边栏渲染出新分组", sidebarHas === true, "sidebar text");

  // ---------- 3) 详情弹窗内联新建分组（bug 3 入口2） ----------
  await win.webContents.executeJavaScript("document.querySelector('.card').click(); true");
  await sleep(500);
  const g2 = await win.webContents.executeJavaScript(`(async () => {
    const link = [...document.querySelectorAll('.link-add')].find((x) => x.textContent.includes('新建分组'));
    if (!link) return { err: 'no-link' };
    link.click();
    await new Promise((r) => setTimeout(r, 200));
    const input = document.querySelector('.group-create-row input');
    if (!input) return { err: 'no-input' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '内联分组Y');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const btn = [...document.querySelectorAll('.group-create-row .btn')].find((b) => b.textContent.trim() === '确定');
    if (!btn) return { err: 'no-btn' };
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    const g = await window.cc.invoke('groups:list');
    const sel = [...document.querySelectorAll('.modal select')].find((s) => [...s.options].some((o) => o.text === '内联分组Y'));
    return { ok: g.ok, names: (g.data || []).map((x) => x.name), selHas: Boolean(sel) };
  })()`);
  check("详情弹窗内联新建分组成功", g2.ok === true && g2.names.includes("内联分组Y") && g2.selHas === true, JSON.stringify(g2));
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.modal .actions .btn')].find((b) => b.textContent.trim() === '关闭').click(); true`);
  await sleep(300);

  // ---------- 3b) 分组重命名 / 删除 / 收藏（补充 UI 覆盖） ----------
  const rn = await win.webContents.executeJavaScript(`(async () => {
    const g = (await window.cc.invoke('groups:list')).data.find((x) => x.name === 'UI分组X');
    if (!g) return { err: 'no-group' };
    const r = await window.cc.invoke('groups:rename', g.id, 'UI分组改名了');
    const list = (await window.cc.invoke('groups:list')).data;
    return { ok: r.ok, renamed: list.some((x) => x.name === 'UI分组改名了') };
  })()`);
  check("分组重命名成功", rn.ok === true && rn.renamed === true, JSON.stringify(rn));
  const rm = await win.webContents.executeJavaScript(`(async () => {
    const g = (await window.cc.invoke('groups:list')).data.find((x) => x.name === 'UI分组改名了');
    if (!g) return { err: 'no-group' };
    await window.cc.invoke('accounts:update', '${acc.id}', { groupId: g.id });
    const r = await window.cc.invoke('groups:remove', g.id);
    const accNow = (await window.cc.invoke('accounts:list')).data.find((a) => a.id === '${acc.id}');
    return { ok: r.ok, ungrouped: accNow && accNow.groupId === null };
  })()`);
  check("分组删除后账号回到未分组", rm.ok === true && rm.ungrouped === true, JSON.stringify(rm));
  const fav = await win.webContents.executeJavaScript(`(async () => {
    let card = document.querySelector('.card');
    if (!card) return { err: 'no-card' };
    const star = card.querySelector('.fav');
    if (!star) return { err: 'no-star' };
    star.click();
    await new Promise((r) => setTimeout(r, 700));
    const accNow = (await window.cc.invoke('accounts:list')).data.find((a) => a.id === '${acc.id}');
    return { fav: accNow && accNow.favorite };
  })()`);
  check("卡片收藏开关生效", fav.fav === 1, JSON.stringify(fav));
  await win.webContents.executeJavaScript(`(() => {
    const star = document.querySelector('.card .fav');
    if (star) star.click();
    return true;
  })()`);
  await sleep(600);

  // ---------- 3c) 设置保存链路 + 一键复制 ----------
  const setRes = await win.webContents.executeJavaScript(`(async () => {
    const btn = [...document.querySelectorAll('.topbar button')].find((b) => b.textContent.trim() === '设置');
    if (!btn) return { err: 'no-settings-btn' };
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const modal = document.querySelector('.modal');
    if (!modal) return { err: 'no-modal' };
    const label = [...modal.querySelectorAll('label')].find((l) => l.textContent.includes('自动刷新间隔'));
    if (!label) return { err: 'no-label' };
    const input = label.parentElement.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '30');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const saveBtn = [...modal.querySelectorAll('.actions .btn')].find((b) => b.textContent.trim() === '保存设置');
    if (!saveBtn) return { err: 'no-save' };
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 900));
    const s = (await window.cc.invoke('settings:get')).data || {};
    return { autoRefreshMin: s.autoRefreshMin };
  })()`);
  check("设置保存生效(autoRefreshMin=30)", setRes.autoRefreshMin === 30, JSON.stringify(setRes));
  const copyRes = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.card').click();
    await new Promise((r) => setTimeout(r, 500));
    const modal = [...document.querySelectorAll('.modal')].find((m) => (m.querySelector('h2') || {}).textContent.includes('账号详情'));
    if (!modal) return { err: 'no-detail' };
    const field = [...modal.querySelectorAll('.field')].find((x) => {
      const l = x.querySelector('label');
      return l && l.textContent.includes('账号ID');
    });
    if (!field) return { err: 'no-id-field' };
    const btn = field.querySelector('button');
    if (!btn) return { err: 'no-copy-btn' };
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true };
  })()`);
  check("详情弹窗复制按钮可用", copyRes.ok === true, JSON.stringify(copyRes));

  // ---------- 4) 添加账号弹窗：三个平台分支都能打开 ----------
  const addModal = await win.webContents.executeJavaScript(`(async () => {
    const btn = [...document.querySelectorAll('.topbar button')].find((b) => b.textContent.trim() === '+ 添加账号');
    if (!btn) return { err: 'no-add-btn' };
    btn.click();
    await new Promise((r) => setTimeout(r, 500));
    const m = [...document.querySelectorAll('.modal')].find((x) => (x.querySelector('h2') || {}).textContent.includes('添加账号'));
    if (!m) return { err: 'no-modal' };
    const sel = m.querySelector('select');
    const platforms = sel ? [...sel.options].map((o) => o.value) : [];
    const text = m.textContent || '';
    return {
      ok: true,
      platforms,
      hasManualHint: text.includes('手动添加 CommandCode'),
      hasSessionImport: text.includes('session') || text.includes('粘贴 Cookie'),
    };
  })()`);
  check(
    "添加账号弹窗含三个平台",
    addModal.ok === true &&
      ["commandcode", "bigmodel", "deepseek"].every((p) => (addModal.platforms || []).includes(p)),
    JSON.stringify(addModal)
  );
  check(
    "无浏览登录导入入口（会话改为浏览器书签/手动填写）",
    addModal.hasSessionImport === false,
    JSON.stringify(addModal)
  );
  await win.webContents.executeJavaScript(`(() => {
    const m = [...document.querySelectorAll('.modal')].find((x) => (x.querySelector('h2') || {}).textContent.includes('添加账号'));
    if (m) { const b = [...m.querySelectorAll('.actions .btn')].find((x) => x.textContent.trim() === '取消'); if (b) b.click(); }
    return true;
  })()`);
  await sleep(400);

  // ---------- 5) 打开账号窗口：IPC 返回轻量结果，窗口真实打开 ----------
  const openRes = await win.webContents.executeJavaScript("window.cc.invoke('browser:open', '" + acc.id + "')");
  check("browser:open 返回纯数据(ok=true)", openRes && openRes.ok === true, JSON.stringify(openRes));
  let accW = null;
  const navSeen = [];
  for (let i = 0; i < 30; i++) {
    accW = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed());
    if (accW) {
      // 尽早挂导航监听，记录初始 URL（该 Electron 版本 webContents.history 不可靠）
      const onNav = (_e, url) => {
        if (url && !navSeen.includes(url)) navSeen.push(url);
      };
      const cur = accW.webContents.getURL();
      if (cur && cur.startsWith("http")) onNav(null, cur);
      accW.webContents.on("did-start-navigation", (e, url, _inPlace, isMainFrame) => {
        if (isMainFrame) onNav(null, url);
      });
      accW.webContents.on("did-redirect-navigation", onNav);
      accW.webContents.on("did-navigate", onNav);
      break;
    }
    await sleep(500);
  }
  check("账号窗口已打开", Boolean(accW), "no account window");
  let accHost = "";
  let accPath = "";
  if (accW) {
    for (let i = 0; i < 40; i++) {
      try {
        const u = new URL(accW.webContents.getURL());
        accHost = u.hostname;
        accPath = u.pathname;
      } catch {
        accHost = "";
      }
      if (accHost === "commandcode.ai" && accPath.includes("/settings/usage")) break;
      await sleep(500);
    }
  }
  // 无会话的测试账号打开后会被重定向到 /signin?returnTo=…/10000001/settings/usage，
  // 属正常；核心是初始 URL 必须是 /10000001/settings/usage（链接生成正确，不会 404）。
  const initialUsage = navSeen.some(
    (u) => u.includes("/10000001/settings/usage") || (u.includes("signin") && u.includes("returnTo") && u.includes("10000001"))
  );
  check(
    "账号窗口打开正确 usage 链接",
    accHost === "commandcode.ai" && (accPath.includes("/settings/usage") || initialUsage),
    "host=" + accHost + " path=" + accPath + " nav=" + JSON.stringify(navSeen)
  );
  if (accW && !accW.isDestroyed()) accW.destroy();

  // ---------- 5b) 表格视图 + 打开全部 ----------
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.view-toggle .btn')].find((b) => b.textContent.trim() === '表格');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(400);
  const tbl = await win.webContents.executeJavaScript(`(() => {
    const rows = document.querySelectorAll('.acc-table tbody tr').length;
    const cell = document.querySelector('.acc-table tbody tr');
    return {
      rows,
      hasOpen: !!cell && [...cell.querySelectorAll('button')].some((b) => b.textContent.trim() === '打开'),
      warnRow: !!document.querySelector('.acc-table tbody tr.warn-row'),
      firstCell: cell ? (cell.textContent || '').slice(0, 40) : '',
    };
  })()`);
  check("表格视图渲染账号行", tbl.rows >= 1 && tbl.hasOpen === true, JSON.stringify(tbl));
  check("表格视图预警标红行", tbl.warnRow === true, JSON.stringify(tbl));
  const openAllBtn = await win.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.topbar button')].find((x) => x.textContent.trim() === '打开全部');
    return !!b;
  })()`);
  check("打开全部按钮存在", openAllBtn === true, "no open-all button");
  await win.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.view-toggle .btn')].find((x) => x.textContent.trim() === '卡片');
    if (b) b.click();
    return true;
  })()`);
  await sleep(300);
  const cardWarn = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.card');
    return { warn: !!card && card.classList.contains('warn-card'), hasFlag: !!card && (card.textContent || '').includes('⚠️') };
  })()`);
  check("卡片视图预警标红", cardWarn.warn === true && cardWarn.hasFlag === true, JSON.stringify(cardWarn));

  // 卡片视觉回归：同一行账号的卡片/进度条/按钮必须完全对齐（至少两张卡片才有意义）
  accounts.create({ accountId: "10000002", email: "10000002@example.com", displayName: "对齐测试账号" });
  win.webContents.send("cc:event", { type: "accounts:changed" });
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.view-toggle .btn')].find((x) => x.textContent.trim() === '卡片');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(1200);
  const cardAlignment = await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('.card')];
    const barRects = [...document.querySelectorAll('.card .metric:nth-child(2) .bar')].map((node) => node.getBoundingClientRect());
    const buttons = cards.map((card) => [...card.querySelectorAll('.foot .btn')]);
    const values = (rects, key) => rects.map((rect) => Math.round(rect[key]));
    const cardRects = cards.map((card) => card.getBoundingClientRect());
    const buttonTops = buttons.map((group) => Math.round(group[0].getBoundingClientRect().top));
    const buttonHeights = buttons.map((group) => Math.round(group[0].getBoundingClientRect().height));
    return {
      count: cards.length,
      cardHeights: values(cardRects, 'height'),
      barTops: values(barRects, 'top'),
      buttonTops,
      buttonHeights,
    };
  })()`);
  check(
    "卡片高度与按钮对齐",
    cardAlignment.count >= 2 &&
      new Set(cardAlignment.cardHeights).size === 1 &&
      new Set(cardAlignment.barTops).size === 1 &&
      new Set(cardAlignment.buttonTops).size === 1 &&
      new Set(cardAlignment.buttonHeights).size === 1,
    JSON.stringify(cardAlignment)
  );
  const cardPeriod = await win.webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll('.card .month .period')];
    return nodes.map((node) => node.textContent || '');
  })()`);
  check(
    "卡片显示套餐剩余到期时间",
    cardPeriod.length >= 1 && cardPeriod.some((text) => text === "已到期" || /(天|小时|分钟)后到期$/.test(text)),
    JSON.stringify(cardPeriod)
  );

  // ---------- 5c) URL Scheme 解析（ccam://add?cookie=…，主进程侧） ----------
  // 注意：渲染层的「书签唤起确认框 / scheme:apply」入口在当前版本不存在
  // （scheme.cjs 只被 index.cjs 用于暂存 + 打日志），这里只验证解析与暂存本身。
  const schemeMod = require("../src/main/scheme.cjs");
  {
    const sb64 = Buffer.from(JSON.stringify({ session: { user: { userName: "777777", email: "scheme777@example.com" } }, expiresAt: Date.now() + 24 * 3600e3 })).toString("base64");
    const scookie = "_Secure-commandcode_prod.session_data=" + sb64 + "; _Secure-commandcode_prod.session_token=abc.def%3D";
    const sp = schemeMod.parseUrl("ccam://add?cookie=" + encodeURIComponent(scookie));
    check(
      "ccam:// URL 解析出 Cookie 并规范化名字",
      sp && sp.cookie.includes("__Secure-commandcode_prod_.session_token="),
      JSON.stringify(sp && { cookie: sp.cookie.slice(0, 80) })
    );
    // 登录名/邮箱不在 URL 里，由 setPending 从 Cookie 离线解码
    const pend = schemeMod.setPending(sp);
    check(
      "ccam:// 离线解码出登录名与邮箱",
      pend && pend.login === "777777" && pend.email === "scheme777@example.com",
      JSON.stringify(pend && { login: pend.login, email: pend.email })
    );
    check("ccam:// 暂存后 pending 可读", schemeMod.getPending() !== null, "pending null");
    check("ccam:// pendingInfo 不含 Cookie 明文", !JSON.stringify(schemeMod.pendingInfo()).includes("session_token"), JSON.stringify(schemeMod.pendingInfo()));
    check("ccam:// 非 add 链接被拒绝", schemeMod.parseUrl("ccam://other?cookie=x") === null, "should be null");
    check("ccam:// 缺 Cookie 被拒绝", schemeMod.parseUrl("ccam://add?login=777777") === null, "should be null");
    schemeMod.clearPending();
    check("ccam:// 清空 pending 生效", schemeMod.getPending() === null, "pending not cleared");
  }

  // ---------- 6) 可选线上验证：真实 Cookie / API Key ----------
  const cookieFile = process.env.CC_COOKIE_FILE;
  const keyFile = process.env.CC_APIKEY_FILE;
  if (cookieFile && fs.existsSync(cookieFile)) {
    const cookie = fs.readFileSync(cookieFile, "utf8").trim();
    const p = "persist:cc-e2e-live";
    await sessions.injectCookies(p, cookie);
    const cap = await sessions.captureSession(p, { timeoutMs: 15000 });
    check("真实 Cookie → 会话捕获成功", cap.ok === true, JSON.stringify(cap && { ok: cap.ok, reason: cap.reason }));
    check("捕获 userName=10000001", cap.username === "10000001", String(cap.username));
    check("捕获 email=10000001@example.com", cap.email === "10000001@example.com", String(cap.email));
    check("捕获 userId=用户UUID", cap.userId === "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", String(cap.userId));
    check("离线解码登录名", sessions.loginFromCookie(cookie) === "10000001", String(sessions.loginFromCookie(cookie)));
    check("decodeSessionExpiry 可解析", Boolean(sessions.decodeSessionExpiry(cookie)), String(sessions.decodeSessionExpiry(cookie)));
    // 存量 UUID 账号离线修复（bug 4 直接场景）
    const legacy = accounts.create({ accountId: cap.userId, email: cap.email, displayName: "历史号" });
    const localLegacy = accounts.findLocal(legacy.id);
    localLegacy.session = { cookieEnc: storage.encrypt(cookie), expiresAt: cap.expiresAt, userId: cap.userId, email: cap.email, state: "ok", updatedAt: new Date().toISOString() };
    storage.save();
    const healed = await sessions.healAccountIdentity(accounts.findLocal(legacy.id), { onlyIfWrong: true });
    check("存量 UUID 账号 ID 自动修复", healed && healed.accountId === "10000001", JSON.stringify(healed));
  } else {
    console.log("SKIP  线上 Cookie 验证（未设置 CC_COOKIE_FILE）");
  }
  if (keyFile && fs.existsSync(keyFile)) {
    const key = fs.readFileSync(keyFile, "utf8").trim();
    const byKey = await quota.collectByKey(key);
    check("真实 API Key → 额度通道可用", byKey.ok === true, JSON.stringify(byKey && { ok: byKey.ok, reason: byKey.reason, status: byKey.status }));
    if (byKey.ok) {
      check("API Key 快照含月度额度", typeof byKey.snapshot.month.remaining === "number", JSON.stringify(byKey.snapshot.month));
      check("API Key 快照含窗口限制", Boolean(byKey.snapshot.fiveHour) && Boolean(byKey.snapshot.weekly), JSON.stringify({ f5: byKey.snapshot.fiveHour, wk: byKey.snapshot.weekly }));
    }
  } else {
    console.log("SKIP  线上 API Key 验证（未设置 CC_APIKEY_FILE）");
  }

  console.log(failures.length ? "E2E_FAIL: " + failures.join(", ") : "E2E_OK");
  app.exit(failures.length ? 1 : 0);
}).catch((e) => {
  console.log("E2E_FAIL: " + String((e && e.stack) || e));
  app.exit(1);
});
