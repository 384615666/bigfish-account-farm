"use strict";
// 启动时恢复旧版本已登录但未落库的智谱草稿会话。
const fs = require("node:fs");
const path = require("node:path");
const { session } = require("electron");
const accounts = require("./accounts.cjs");
const bigmodel = require("./bigmodel.cjs");
const quota = require("./quota.cjs");

const ORIGIN = "https://www.bigmodel.cn";
const TOKEN_COOKIE = "bigmodel_token_production";

function normalizeProfile(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const email = item.email || item.userEmail || null;
  const mobile = item.mobile || item.phone || item.phoneNumber || null;
  const username = item.username || item.userName || item.loginName || mobile || email || null;
  const name = item.name || item.nickname || item.displayName || username || "智谱账号";
  const id = String(item.id || item.userId || item.customerId || item.customerNumber || username || "") || null;
  return { id, username, email, name };
}

async function readProfileFromPartition(partitionName) {
  try {
    const code = `(() => {
      try { return JSON.parse(localStorage.getItem("user") || "{}"); }
      catch { return {}; }
    })()`;
    const raw = await session.fromPartition(partitionName).executeJavaScript(code, false);
    return normalizeProfile(raw);
  } catch {
    return {};
  }
}

function readSelector(storage, name) {
  try {
    const value = storage.getItem(name);
    return String(value || "").trim() || null;
  } catch {
    return null;
  }
}

async function readSelectorsFromPartition(partitionName) {
  try {
    const code = `(() => ({
      organization: (() => { try { return localStorage.getItem("Bigmodel-Organization") || ""; } catch { return ""; } })(),
      project: (() => { try { return localStorage.getItem("Bigmodel-Project") || ""; } catch { return ""; } })()
    }))()`;
    const raw = await session.fromPartition(partitionName).executeJavaScript(code, false);
    return {
      organization: String(raw?.organization || "").trim() || null,
      project: String(raw?.project || "").trim() || null,
    };
  } catch {
    return { organization: null, project: null };
  }
}

async function recoverDrafts({ cleanup = true } = {}) {
  const root = path.join(require("electron").app.getPath("userData"), "Partitions");
  if (!fs.existsSync(root)) return { recovered: 0, checked: 0 };
  const names = fs.readdirSync(root).filter((name) => name.startsWith("cc-acct-bigmodel-draft-"));
  const results = [];
  for (const name of names) {
    const partitionName = "persist:" + name;
    let cookie = null;
    let profile = {};
    let selectors = { organization: null, project: null };
    try {
      const ses = session.fromPartition(partitionName);
      const cookies = await ses.cookies.get({ url: ORIGIN });
      cookie = cookies.find((item) => item.name === TOKEN_COOKIE);
      if (!cookie?.value) {
        results.push({ partition: partitionName, reason: "no_cookie", cookies: cookies.map((item) => item.name) });
        continue;
      }
      const token = decodeURIComponent(cookie.value);
      const response = await bigmodel.request("/monitor/usage/quota/limit", {
        token,
        organization: selectors.organization,
        project: selectors.project,
      });
      const normalized = bigmodel.normalizeSnapshot(response, {});
      if (!normalized.ok) {
        results.push({ partition: partitionName, reason: normalized.reason, status: response.status, detail: normalized.detail || response.json || response.text?.slice(0, 300) });
        continue;
      }

      profile = await readProfileFromPartition(partitionName);
      selectors = await readSelectorsFromPartition(partitionName);
      if (!profile.username && !profile.email) {
        profile = normalizeProfile(normalized.detail?.response?.data?.user || normalized.detail?.response?.user || {});
      }
      const identity = profile.username || profile.id || profile.email || null;
      const existing = accounts.listAll(true).find((account) =>
        (account.platform || "commandcode") === "bigmodel" &&
        (Boolean(identity && (account.accountId === identity || account.loginUsername === identity)) ||
          Boolean(profile.email && account.email === profile.email))
      );
      const fields = {
        displayName: profile.name || identity || "智谱账号",
        accountId: identity,
        email: profile.email || null,
        loginUsername: identity,
      };
      const account = existing
        ? accounts.update(existing.id, fields)
        : accounts.create({ platform: "bigmodel", ...fields });
      accounts.setPlatformSecret(account.id, {
        token,
        expiresAt: cookie.expirationDate ? cookie.expirationDate * 1000 : Date.now() + 7 * 86400000,
        organization: selectors.organization,
        project: selectors.project,
      });
      try {
        await quota.refreshAccount(accounts.findLocal(account.id));
      } catch {}
      results.push({ id: account.id, accountId: account.accountId });
      if (cleanup) {
        try {
          await ses.clearStorageData();
          await fs.promises.rm(path.join(root, name), { recursive: true, force: true });
        } catch {}
      }
    } catch (error) {
      results.push({ partition: partitionName, reason: "exception", error: error?.message || String(error) });
      continue;
    }
  }
  return { recovered: results.length, checked: names.length, accounts: results };
}

module.exports = { recoverDrafts };
