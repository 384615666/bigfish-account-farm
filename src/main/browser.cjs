"use strict";
// 内置浏览器：1) 打开账号 usage 页（每账号独立 partition 窗口） 2) 添加账号登录窗口
const { BrowserWindow, shell, session } = require("electron");
const path = require("node:path");
const accounts = require("./accounts.cjs");
const sessions = require("./sessions.cjs");
const api = require("./api.cjs");

const STUDIO = "https://commandcode.ai";
let onEvent = null;
const accountWindows = new Map(); // localId -> BrowserWindow

function setEventHandler(handler) {
  onEvent = handler;
}
function emit(payload) {
  if (onEvent) onEvent(payload);
}

function usageUrl(acc) {
  // 优先登录名；存量错误 ID（用户 UUID）时从 session_data Cookie 离线解码登录名，
  // 保证"打开/系统浏览器打开"永远指向正确页面而不是 404
  let login = acc.accountId || "";
  if (!login || sessions.looksLikeUuid(login)) {
    const fromCookie = acc.session ? sessions.loginFromCookie(sessions.sessionCookie(acc)) : null;
    login = fromCookie || acc.email || "";
  }
  // 存量错误 ID（用户 UUID）或缺失登录名：退回个人 usage 页，避免 404
  const usable = login && !sessions.looksLikeUuid(login);
  return usable ? `${STUDIO}/${encodeURIComponent(login)}/settings/usage` : `${STUDIO}/settings/usage`;
}

// 添加/重新登录时查找可复用的存量账号：登录名、邮箱、或会话 user UUID 任一命中即可
function findReusableAccount({ login, email, userId } = {}) {
  return accounts
    .listAll(true)
    .find(
      (a) =>
        a.status !== "archived" &&
        ((login && a.accountId === login) || (email && a.email === email) || (userId && a.session?.userId === userId))
    );
}

async function openAccountWindow(acc) {
  if (accountWindows.has(acc.id)) {
    accountWindows.get(acc.id).focus();
    return accountWindows.get(acc.id);
  }
  const partitionName = sessions.partitionFor(acc.id);
  // 每次打开都重新注入最新保存的 Cookie；随后在线校验一次，避免旧分区状态或
  // 重签 Cookie 造成“本地显示已登录、内嵌页面未登录”。
  let cookie = sessions.sessionCookie(acc);
  if (cookie) {
    try {
      await sessions.injectCookies(partitionName, cookie);
    } catch {
      /* 注入失败不阻塞打开 */
    }
  }
  if (cookie) {
    try {
      const health = await sessions.checkHealth(acc, { refresh: true });
      if (health.state === "ok") {
        cookie = sessions.sessionCookie(accounts.findLocal(acc.id)) || cookie;
        await sessions.injectCookies(partitionName, cookie);
      } else if (acc.session?.state !== health.state) {
        accounts.setSession(acc.id, { ...acc.session, state: health.state, updatedAt: new Date().toISOString() });
      }
    } catch {
      /* 网络失败时仍用已保存会话打开 */
    }
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: `${acc.displayName || acc.accountId || "账号"} - CommandCode`,
    autoHideMenuBar: true,
    webPreferences: {
      partition: partitionName,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-navigate", (_e, url) => {
    if (url.includes("/signin")) {
      emit({ type: "browser:session-invalid", accountId: acc.id, url });
    } else {
      // 无论本地状态如何，窗口内重新登录成功后都自动回写新会话；
      // 已保存会话也周期性捕获，确保站点重签 Cookie 后本地不落后。
      sessions
        .captureSession(partitionName)
        .then((c) => {
          if (c && c.ok) {
            sessions.saveSessionToAccount(acc.id, {
              cookieHeader: c.cookieHeader,
              expiresAt: c.expiresAt,
              userId: c.userId,
              email: c.email,
            });
            emit({ type: "accounts:changed" });
          }
        })
        .catch(() => {});
    }
  });
  win.on("closed", () => accountWindows.delete(acc.id));
  accountWindows.set(acc.id, win);
  accounts.setLastUsed(acc.id);
  try {
    await win.loadURL(usageUrl(acc));
  } catch (e) {
    emit({ type: "browser:load-error", accountId: acc.id, error: String(e) });
  }
  emit({ type: "browser:opened", accountId: acc.id });
  return win;
}

function openExternal(acc) {
  accounts.setLastUsed(acc.id);
  shell.openExternal(usageUrl(acc));
}

// 清理单个账号的窗口与分区数据（彻底删除时调用）
function disposeAccount(localId) {
  const win = accountWindows.get(localId);
  if (win && !win.isDestroyed()) win.destroy();
  accountWindows.delete(localId);
  try {
    session.fromPartition(sessions.partitionFor(localId)).clearStorageData();
  } catch {
    /* 分区清理失败不影响删除 */
  }
}

// ---- 添加账号登录窗口 ----
// 打开登录页（带 returnTo 指向 usage），轮询 get-session 判定登录成功，
// 成功后捕获会话并通知主窗口进入"补全资料"流程。
// 说明：GitHub 登录是同一窗口内的整页跳转（signin -> github -> 回调），
// 期间原页面加载会被新导航替代，loadURL 报 ERR_ABORTED 属正常，不能当作失败。
let authWin = null;
let authPollTimer = null;
let authCaptured = null;
let authPartitionName = null;
let authBusy = false; // 防止轮询重叠导致重复成功
let authTerminated = false; // 已发出终止事件（成功/取消）
let authMaxWait = null; // 登录窗口最长等待，超时自动取消
let authVerifyMonitor = null; // Turnstile 超时自动重置监视器
const authChildWindows = new Set(); // window.open 弹出的子窗口（同一 partition）
const authRecoveryAttempts = new WeakMap(); // contents -> 已自动修复次数

// Cloudflare Turnstile 会把“Electron + 旧 Chromium”视为高风险环境，可能静默拒绝令牌。
// 登录窗统一使用 Windows Chrome 的公开标识，避免 Turnstile 看到 Electron 旧内核标识。
const AUTH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/139.0.0.0 Safari/537.36";
function authProxyRules() {
  const raw =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || "";
  const rules = raw.replace(/^https?:\/\//i, "").trim();
  return rules ? "http=" + rules + ";https=" + rules : null;
}

// 防止登录窗口进入 Chromium view-source 模式（表现为整页文字源码）。
// 一旦检测到，剥离前缀并回到真实 URL；正常 https 页面原样返回。
function stripViewSource(url) {
  const raw = String(url || "");
  return raw.toLowerCase().startsWith("view-source:") ? raw.slice("view-source:".length) : raw;
}

// 判断页面是否退化为"文字源码"：正常登录页是 text/html，且有 GitHub/邮箱等交互入口；
// 异常页会像截图那样把 head 内脚本、JSON-LD 原文渲染出来。这个判定只看公开 UI 特征。
function looksLikeRawAuthDocument(snapshot) {
  const s = snapshot || {};
  const text = String(s.bodyText || "");
  const rawMarkers = [
    '"@context":"https://schema.org"',
    "__pwResetToken",
    "window.location.pathname",
  ];
  if (s.contentType && s.contentType !== "text/html") return true;
  return rawMarkers.some((m) => text.includes(m));
}

function destroyAuthChildren() {
  for (const w of authChildWindows) {
    if (w && !w.isDestroyed()) w.destroy();
  }
  authChildWindows.clear();
}

function closeAuthWindow() {
  if (authPollTimer) {
    clearInterval(authPollTimer);
    authPollTimer = null;
  }
  if (authMaxWait) {
    clearTimeout(authMaxWait);
    authMaxWait = null;
  }
  if (authVerifyMonitor) {
    clearInterval(authVerifyMonitor);
    authVerifyMonitor = null;
  }
  destroyAuthChildren();
  if (authWin && !authWin.isDestroyed()) {
    // destroy() 可绕过页面 beforeunload 拦截，确保登录成功后必然关窗不卡住
    try {
      authWin.webContents.stop();
    } catch {
      /* 窗口可能已在卸载中 */
    }
    try {
      authWin.destroy();
    } catch {
      try {
        authWin.close();
      } catch {
        /* 忽略 */
      }
    }
  }
  authWin = null;
}

// 页面导航被替换（如登录页跳转到 GitHub OAuth）时 loadURL 的 ERR_ABORTED 属正常，
// 不能当作登录失败弹窗；其余错误才向上抛。
function isAbortError(err) {
  const msg = String((err && err.message) || err || "");
  return /ERR_ABORTED|net::ERR_ABORTED|\b-3\b|aborted/i.test(msg);
}

function tryCaptureNow() {
  if (authPartitionName) captureFromAuthWindow(authPartitionName).catch(() => {});
}

function authWindowAlive() {
  return (authWin && !authWin.isDestroyed()) || authChildWindows.size > 0;
}

async function captureFromAuthWindow(partitionName) {
  if (authBusy || authTerminated) return false;
  authBusy = true;
  try {
    // 捕获用更短超时：登录回调瞬间就应能拉到会话，避免窗口"卡在重定向页"
    const captured = await sessions.captureSession(partitionName, { timeoutMs: 8000 });
    if (!captured.ok || authTerminated) return false;
    // 先暂存会话（不依赖窗口状态），再关窗并通知渲染层
    authTerminated = true;
    authCaptured = captured;
    closeAuthWindow();
    emit({
      type: "auth:success",
      session: {
        cookieEnc: null /* 不经过 IPC 传明文 */,
        expiresAt: captured.expiresAt,
        userId: captured.userId,
        email: captured.email,
      },
    });
    return true;
  } finally {
    authBusy = false;
  }
}

// 只要导航到本站域名（登录回调回来的一刻），立即尝试捕获，不用等下一轮轮询
async function inspectAndRecoverAuthRender(contents) {
  try {
    const current = contents.getURL();
    if (!/^https:\/\/([^/]+\.)?commandcode\.ai\//i.test(current)) return;
    const snap = await contents.executeJavaScript(`(() => ({
      contentType: document.contentType,
      title: document.title,
      bodyText: document.body ? (document.body.innerText || "") : "",
      verificationNotice: (document.body ? document.body.innerText || "" : "").includes(
        "Verification didn't finish in time"
      ),
    }))()`);
    if (!snap.verificationNotice && !looksLikeRawAuthDocument(snap)) return;

    if (snap.verificationNotice && !looksLikeRawAuthDocument(snap)) {
      authTerminated = true;
      closeAuthWindow();
      emit({
        type: "auth:canceled",
        error: null,
        reason: "网站人机验证拦截了内嵌邮箱登录。请点「系统浏览器登录」，登录后按弹窗里的书签步骤一键带回。",
      });
      return;
    }

    const attempts = (authRecoveryAttempts.get(contents) || 0) + 1;
    authRecoveryAttempts.set(contents, attempts);
    if (attempts <= 2) {
      await contents.session.clearCache().catch(() => {});
      contents.reloadIgnoringCache();
      emit({ type: "auth:render-recovered", attempt: attempts });
      return;
    }

    // 连续三次仍坏，不把用户卡在文字页面：交给系统浏览器继续登录，
    // 用户也可回到本软件用「浏览器一键添加」直接带入会话。
    const fallbackUrl = stripViewSource(current);
    shell.openExternal(fallbackUrl);
    emit({
      type: "auth:canceled",
      error: null,
      reason: "登录页显示异常已转系统浏览器打开",
      fallbackUrl,
    });
  } catch {
    /* 页面尚未就绪/用户已关闭时忽略 */
  }
}

function hookAuthNavigation(contents) {
  // 登录回调是 302 跳转链（github -> api.commandcode.ai -> 本站页面），
  // 在「跳转发生的那一刻」就尝试捕获，比等最终页面提交更快更稳
  contents.on("did-redirect-navigation", (_e, url) => {
    const navUrl = stripViewSource(url);
    if (navUrl !== url) {
      contents.loadURL(navUrl).catch(() => {});
      return;
    }
    try {
      const host = new URL(url).hostname;
      if (host.endsWith("commandcode.ai")) {
        captureFromAuthWindow(authPartitionName).catch(() => {});
      }
    } catch {
      /* 非法 URL 忽略 */
    }
  });
  contents.on("did-navigate", (_e, url) => {
    const navUrl = stripViewSource(url);
    if (navUrl !== url) {
      contents.loadURL(navUrl).catch(() => {});
      return;
    }
    try {
      const host = new URL(url).hostname;
      if (host.endsWith("commandcode.ai")) {
        captureFromAuthWindow(authPartitionName).catch(() => {});
      }
    } catch {
      /* 非法 URL 忽略 */
    }
  });
  // 页面加载完成的一刻也补一次捕获（防止 302 链上某些环节没有触发上面两个事件）
  contents.on("did-finish-load", () => {
    try {
      const current = contents.getURL();
      const real = stripViewSource(current);
      if (real !== current) {
        contents.loadURL(real).catch(() => {});
        return;
      }
      const host = new URL(real).hostname;
      if (host.endsWith("commandcode.ai")) tryCaptureNow();
    } catch {
      /* 非法 URL 忽略 */
    }
    inspectAndRecoverAuthRender(contents);
  });
  // 登录过程的导航失败（ERR_ABORTED 等）不弹窗、不显示错误状态
  contents.on("did-fail-load", (_e, code) => {
    if (code === -3) return; // ERR_ABORTED：导航被替换，忽略
  });
  contents.setWindowOpenHandler(({ url }) => {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    // GitHub OAuth 允许弹窗：交给新窗口并在同一 partition 内完成登录；
    // 其余外部链接一律交给系统浏览器。
    if (host.endsWith("commandcode.ai") || host === "github.com" || host.endsWith(".github.com")) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 480, height: 720, autoHideMenuBar: true } };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (win) => {
    authChildWindows.add(win);
    win.on("closed", () => authChildWindows.delete(win));
    hookAuthNavigation(win.webContents);
  });
}

async function startAddAccount() {
  if (authWindowAlive()) {
    if (authWin) authWin.focus();
    return { ok: true, alreadyOpen: true };
  }
  authCaptured = null;
  authTerminated = false;
  const draftId = accounts.uid();
  authPartitionName = sessions.partitionFor("draft-" + draftId);
  try {
    await session.fromPartition(authPartitionName).setProxy(
      authProxyRules()
        ? { mode: "fixed_servers", proxyRules: authProxyRules() }
        : { mode: "system" }
    );
  } catch {
    /* 代理配置失败时保留直连 */
  }
  authWin = new BrowserWindow({
    width: 480,
    height: 720,
    title: "登录 CommandCode 添加账号",
    autoHideMenuBar: true,
    webPreferences: { partition: authPartitionName, contextIsolation: true, sandbox: true },
  });
  authWin.webContents.setUserAgent(AUTH_USER_AGENT);
  authWin.on("closed", () => {
    if (authPollTimer) {
      clearInterval(authPollTimer);
      authPollTimer = null;
    }
    if (authMaxWait) {
      clearTimeout(authMaxWait);
      authMaxWait = null;
    }
    authWin = null;
    destroyAuthChildren();
    if (authVerifyMonitor) {
      clearInterval(authVerifyMonitor);
      authVerifyMonitor = null;
    }
    // 用户手动关闭且尚未登录成功 → 通知渲染层恢复按钮
    if (!authTerminated) {
      authTerminated = true;
      emit({ type: "auth:canceled" });
    }
  });
  hookAuthNavigation(authWin.webContents);
  authVerifyMonitor = setInterval(async () => {
    if (!authWin || authWin.isDestroyed()) return;
    try {
      const snapshot = await authWin.webContents.executeJavaScript(`(() => ({
        notice: (document.body ? document.body.innerText || "" : "").includes("Verification didn't finish in time"),
      }))()`);
      if (!snapshot?.notice) return;
      authTerminated = true;
      closeAuthWindow();
      emit({
        type: "auth:canceled",
        error: null,
        reason: "网站人机验证拦截了内嵌邮箱登录。请点「系统浏览器登录」，登录后按弹窗里的书签步骤一键带回。",
      });
    } catch {
      /* 页面跳转中忽略 */
    }
  }, 1000);
  authPollTimer = setInterval(() => {
    if (authWindowAlive()) {
      captureFromAuthWindow(authPartitionName).catch(() => {
        /* 网络抖动忽略，下一轮重试 */
      });
    }
  }, 1200);
  // 兜底：登录太慢（如在 GitHub 停留过久）也不让窗口无限挂着
  authMaxWait = setTimeout(() => {
    if (authWindowAlive() && !authTerminated) {
      authTerminated = true;
      closeAuthWindow();
      emit({ type: "auth:canceled" });
    }
  }, 20 * 60 * 1000);
  const signinUrl = `${STUDIO}/signin?returnTo=${encodeURIComponent("/settings/usage")}`;
  try {
    await authWin.loadURL(signinUrl);
  } catch (err) {
    // GitHub 跳转 / 页面内新导航替换原加载时的正常中断，不算失败
    if (isAbortError(err)) return { ok: true };
    // 真失败（断网/DNS 等）：关窗并让渲染层提示
    authTerminated = true;
    closeAuthWindow();
    throw err;
  }
  return { ok: true };
}

// 添加成功后由主进程调用：生成账号草稿并保存会话
function persistCapturedAccount(captured, { displayName, groupId, tags, note } = {}) {
  // usage URL 用的是"登录名"（user.userName），不是用户 UUID（user.id）
  const login =
    captured.username || sessions.loginFromCookie(captured.cookieHeader) || captured.userId || null;
  const email = captured.email || null;
  // 同一账号（登录名或邮箱相同）再次添加时：只更新会话与资料，避免重复建号
  // 存量错误 ID 账号（accountId 还是用户 UUID）按 session.userId 也能命中，重登不重复建号
  const existing = findReusableAccount({ login, email, userId: captured.userId });
  let acc;
  if (existing) {
    acc = existing;
    accounts.update(existing.id, {
      accountId: login || existing.accountId,
      email: email || existing.email,
      displayName: displayName || existing.displayName || email || "新账号",
      groupId: groupId !== undefined && groupId !== null ? groupId : existing.groupId,
      note: note !== undefined && note !== null ? note : existing.note,
    });
  } else {
    acc = accounts.create({
      accountId: login,
      email,
      displayName: displayName || email || "新账号",
      groupId,
      tags,
      note,
    });
  }
  sessions.saveSessionToAccount(acc.id, {
    cookieHeader: captured.cookieHeader,
    expiresAt: captured.expiresAt,
    userId: captured.userId,
    email: captured.email,
  });
  // 无持久化 partition 对应真实 id；迁移：把 draft partition 的 cookie 写进真实 partition
  const realPartition = sessions.partitionFor(acc.id);
  sessions.injectCookies(realPartition, captured.cookieHeader).catch(() => {});
  const { session, ...pub } = accounts.findLocal(acc.id);
  return pub;
}

function finalizeAddedAccount(options) {
  if (!authCaptured) throw new Error("尚未捕获到登录会话，请先完成登录");
  const captured = authCaptured;
  authCaptured = null;
  return persistCapturedAccount(captured, options);
}

async function importCookieSession(rawCookie) {
  const cookie = sessions.canonicalizeSessionCookie(String(rawCookie || "").trim());
  const hasToken = /__Secure-commandcode_prod_\.session_token=/i.test(cookie);
  const hasData = /__Secure-commandcode_prod_\.session_data=/i.test(cookie);
  if (!hasToken || !hasData) {
    throw new Error("请粘贴包含 session_token 和 session_data 的完整 Cookie");
  }
  const partitionName = sessions.partitionFor("cookie-import-" + accounts.uid());
  try {
    await sessions.injectCookies(partitionName, cookie);
    const captured = await sessions.captureSession(partitionName, { timeoutMs: 15000 });
    if (!captured.ok) throw new Error("Cookie 无效或会话已过期");
    return persistCapturedAccount(captured);
  } finally {
    try {
      await session.fromPartition(partitionName).clearStorageData();
    } catch {
      /* 清理失败不影响账号保存 */
    }
  }
}

module.exports = { setEventHandler, openAccountWindow, openExternal, startAddAccount, finalizeAddedAccount, importCookieSession, closeAuthWindow, findReusableAccount, disposeAccount, usageUrl, stripViewSource, looksLikeRawAuthDocument };
