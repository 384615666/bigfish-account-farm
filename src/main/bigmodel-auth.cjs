"use strict";
// 智谱登录窗口只把官方令牌保留在主进程；保存账号时才写入本机加密存储。
const { BrowserWindow, shell, session } = require("electron");
const crypto = require("node:crypto");
const accounts = require("./accounts.cjs");
const sessions = require("./sessions.cjs");
const bigmodel = require("./bigmodel.cjs");

const ORIGIN = "https://www.bigmodel.cn";
const TOKEN_COOKIE = "bigmodel_token_production";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/139.0.0.0 Safari/537.36";

let eventHandler = null;
let mainWindow = null;
let authWindow = null;
let partitionName = null;
let capturedToken = null;
let pendingOptions = {};
let terminated = false;
let busy = false;
let pollTimer = null;
let maxWaitTimer = null;

function setMainWindow(window) {
  mainWindow = window;
}

function send(payload) {
  if (eventHandler) {
    eventHandler(payload);
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("cc:event", payload);
}

function proxyRules() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || "";
  const rules = String(raw).replace(/^https?:\/\//i, "").trim();
  return rules ? `http=${rules};https=${rules}` : null;
}

function closeTimers() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }
}

function windowAlive() {
  return Boolean(authWindow && !authWindow.isDestroyed());
}

async function closeLoginWindow({ cleanup = true } = {}) {
  closeTimers();
  const partition = partitionName;
  if (authWindow && !authWindow.isDestroyed()) {
    try {
      authWindow.destroy();
    } catch {
      /* 窗口可能正在销毁 */
    }
  }
  authWindow = null;
  partitionName = null;
  if (cleanup && partition) {
    try {
      await session.fromPartition(partition).clearStorageData();
    } catch {
      /* 清理失败不阻塞保存 */
    }
  }
}

function normalizeProfile(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const email = item.email || item.userEmail || null;
  const mobile = item.mobile || item.phone || item.phoneNumber || null;
  const username = item.username || item.userName || item.loginName || mobile || email || null;
  const name = item.name || item.nickname || item.displayName || username || "智谱账号";
  const id = String(item.id || item.userId || item.customerId || item.customerNumber || username || "") || null;
  return { id, username, email, name };
}

async function readProfile() {
  if (!windowAlive()) return {};
  try {
    const raw = await authWindow.webContents.executeJavaScript(`(() => {
      try { return JSON.parse(localStorage.getItem("user") || "{}"); }
      catch { return {}; }
    })()`);
    return normalizeProfile(raw);
  } catch {
    return {};
  }
}

async function readSelector(name) {
  if (!windowAlive()) return null;
  try {
    const value = await authWindow.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(name)})`
    );
    const text = String(value || "").trim();
    return text || null;
  } catch {
    return null;
  }
}

async function readSelectors() {
  const [organization, project] = await Promise.all([
    readSelector("Bigmodel-Organization"),
    readSelector("Bigmodel-Project"),
  ]);
  return { organization, project };
}

async function captureFromWindow() {
  if (busy || terminated || !partitionName) return false;
  busy = true;
  try {
    const cookies = await session.fromPartition(partitionName).cookies.get({ url: ORIGIN });
    const cookie = cookies.find((item) => item.name === TOKEN_COOKIE);
    if (!cookie?.value) return false;

    const token = decodeURIComponent(cookie.value);
    const selectors = await readSelectors();
    const response = await bigmodel.request("/monitor/usage/quota/limit", {
      token,
      organization: selectors.organization,
      project: selectors.project,
    });
    const result = bigmodel.normalizeSnapshot(response, {});
    if (!result.ok) return false;

    const profile = await readProfile();
    const captured = {
      token,
      expiresAt: cookie.expirationDate ? cookie.expirationDate * 1000 : Date.now() + 7 * 86400000,
      profile,
      ...selectors,
    };
    terminated = true;
    capturedToken = captured;
    await closeLoginWindow({ cleanup: false });
    send({ type: "bigmodel:auth:success", account: {
      id: profile.id,
      name: profile.name,
      username: profile.username,
      email: profile.email,
    } });
    return true;
    return true;
  } finally {
    busy = false;
  }
}

async function startLogin(options = {}) {
  if (windowAlive()) {
    authWindow.focus();
    pendingOptions = options || {};
    return { ok: true, alreadyOpen: true };
  }
  closeTimers();
  capturedToken = null;
  pendingOptions = options || {};
  terminated = false;
  partitionName = sessions.partitionFor("bigmodel-draft-" + crypto.randomUUID());
  try {
    await session.fromPartition(partitionName).setProxy(
      proxyRules() ? { mode: "fixed_servers", proxyRules: proxyRules() } : { mode: "system" }
    );
  } catch {
    /* 使用系统代理兜底 */
  }

  authWindow = new BrowserWindow({
    width: 480,
    height: 760,
    title: "登录智谱 BigModel",
    autoHideMenuBar: true,
    webPreferences: {
      partition: partitionName,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  authWindow.webContents.setUserAgent(USER_AGENT);
  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    if (/bigmodel\.cn$|qq\.com$|weixin\.qq\.com$|alipay\.com$|github\.com$/i.test(host)) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 480, height: 720 } };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  authWindow.on("closed", () => {
    closeTimers();
    authWindow = null;
    const stalePartition = partitionName;
    partitionName = null;
    if (!terminated) {
      terminated = true;
      send({ type: "bigmodel:auth:canceled" });
    }
    if (stalePartition) {
      session.fromPartition(stalePartition).clearStorageData().catch(() => {});
    }
  });
  authWindow.webContents.on("did-navigate", () => {
    captureFromWindow().catch(() => {});
  });
  pollTimer = setInterval(() => {
    captureFromWindow().catch(() => {});
  }, 1200);
  maxWaitTimer = setTimeout(async () => {
    if (windowAlive() && !terminated) {
      terminated = true;
      await closeLoginWindow();
      send({ type: "bigmodel:auth:canceled", reason: "登录等待超时，请重试。" });
    }
  }, 15 * 60000);

  try {
    await authWindow.loadURL(`${ORIGIN}/coding-plan/personal/usage`);
  } catch (error) {
    if (/ERR_ABORTED|aborted/i.test(String(error?.message || error))) return { ok: true };
    terminated = true;
    await closeLoginWindow();
    throw error;
  }
  return { ok: true };
}

function findReusable(profile, input = {}) {
  const identity = profile.username || input.loginUsername;
  return accounts.listAll(true).find((account) =>
    (account.platform || "commandcode") !== "bigmodel" ? false :
    Boolean(identity && (account.accountId === identity || account.loginUsername === identity)) ||
    Boolean(profile.email && account.email === profile.email)
  );
}

async function finalizeLogin(input = {}) {
  if (!capturedToken) throw new Error("尚未捕获智谱登录令牌，请重新登录");
  const pending = capturedToken;
  capturedToken = null;
  const profile = pending.profile || {};
  const identity = profile.username || profile.id || profile.email || input.loginUsername || null;
  let fields = {
    displayName: input.displayName || profile.name || identity || "智谱账号",
    groupId: input.groupId || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    note: input.note || "",
    loginMethod: input.loginMethod || null,
    loginUsername: input.loginUsername || identity || null,
  };
  const existing = findReusable(profile, input);
  if (existing) {
    fields = {
      platform: "bigmodel",
      displayName: input.displayName || existing.displayName || profile.name || identity || "智谱账号",
      groupId: input.groupId != null ? input.groupId : existing.groupId,
      tags: Array.isArray(input.tags) && input.tags.length ? input.tags : existing.tags || [],
      note: input.note || existing.note || "",
      loginMethod: input.loginMethod || existing.loginMethod,
      loginUsername: input.loginUsername || identity || existing.loginUsername,
    };
  }
  const account = existing
    ? accounts.update(existing.id, {
        ...fields,
        status: "active",
        accountId: identity || existing.accountId,
        email: profile.email || existing.email,
      })
    : accounts.create({
        platform: "bigmodel",
        accountId: identity,
        email: profile.email || null,
        ...fields,
      });

  accounts.setPlatformSecret(account.id, {
    token: pending.token,
    expiresAt: pending.expiresAt,
    organization: pending.organization,
    project: pending.project,
    apiKey: input.apiKey || null,
  });
  try {
    await require("./quota.cjs").refreshAccount(accounts.findLocal(account.id));
  } catch {
    /* 刷新失败保留账号，用户可在列表里重试 */
  }
  return accounts.findPublic(account.id);
}

function discardToken() {
  capturedToken = null;
}

function hasCapturedToken() {
  return Boolean(capturedToken);
}

module.exports = {
  setMainWindow,
  startLogin,
  finalizeLogin,
  captureFromWindow,
  hasCapturedToken,
  discardToken,
  closeLoginWindow,
};
