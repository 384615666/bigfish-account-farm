"use strict";
// 额度采集：通道1 Cookie -> /internal/ 接口组；通道2 API Key -> /alpha/ 接口组
// 统一输出 QuotaSnapshot，字段多候选容错（/internal/ 确切结构待阶段0实测后收敛）。
const api = require("./api.cjs");
const accounts = require("./accounts.cjs");
const sessions = require("./sessions.cjs");
const bigmodel = require("./bigmodel.cjs");
const deepseek = require("./deepseek.cjs");

function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && !Number.isNaN(Number(v)) ? Number(v) : null);

// 归一化 windowLimits（fiveHour / weekly 或 five_hour / 5hour 等可能命名）
// 实测（阶段0）：奖励在 JSON 顶层与 credits 平级；另有 exceeded 标记哪个窗口已超限
function normalizeLimits(raw) {
  const fiveHour = raw?.fiveHour || raw?.five_hour || raw?.fivehour || null;
  const weekly = raw?.weekly || raw?.week || null;
  return {
    limited: Boolean(raw?.limited),
    exceeded: raw?.exceeded || null,
    fiveHour: fiveHour ? { used: num(fiveHour.used), cap: num(fiveHour.cap), resetAt: num(fiveHour.resetAt), exceeded: Boolean(fiveHour.exceeded) } : null,
    weekly: weekly ? { used: num(weekly.used), cap: num(weekly.cap), resetAt: num(weekly.resetAt), exceeded: Boolean(weekly.exceeded) } : null,
  };
}

// 归一化一个月度额度对象（可能叫 monthlyCredits / remaining / creditsRemaining ...）
// windowLimits 单独传入（实测在响应顶层，与 credits 平级）
function normalizeCreditsObject(credits, windowLimits) {
  if (!credits) return null;
  const monthly = pick(credits, ["monthlyCredits", "monthlyRemaining", "remaining", "creditsRemaining", "opensourceMonthlyCredits"]);
  const purchased = pick(credits, ["purchasedCredits", "purchasedRemaining"]);
  const free = pick(credits, ["freeCredits", "freeRemaining"]);
  const belowThreshold = credits.belowThreshold === true || credits.willBeShutoff === true;
  return {
    planId: credits.planId || null,
    monthlyRemaining: num(monthly),
    purchasedRemaining: num(purchased),
    freeRemaining: num(free),
    belowThreshold,
    windowLimits: normalizeLimits(windowLimits || credits.windowLimits || credits.limits),
  };
}

function toSnapshot({ creditsObj, subscriptionData, summaryObj, planId }) {
  const limits = creditsObj?.windowLimits || { fiveHour: null, weekly: null, limited: false };
  return {
    month: {
      remaining: creditsObj?.monthlyRemaining ?? null,
      purchased: creditsObj?.purchasedRemaining ?? null,
      free: creditsObj?.freeRemaining ?? null,
      totalSpent: num(summaryObj?.totalCost),
      periodEnd: subscriptionData?.currentPeriodEnd || summaryObj?.periodEnd || null,
      planId: planId || creditsObj?.planId || subscriptionData?.planId || null,
    },
    fiveHour: limits.fiveHour || null,
    weekly: limits.weekly || null,
    channel: null, // 由调用方标注 "internal-cookie" | "alpha-key"
    raw: {
      credits: creditsObj || null,
      subscription: subscriptionData || null,
      summary: summaryObj || null,
    },
  };
}

// ---- 通道1：Cookie -> /internal/ ----
async function collectByCookie(acc) {
  const cookie = sessions.sessionCookie(acc);
  if (!cookie) return { ok: false, reason: "no_session" };

  const results = {};
  const calls = [
    ["usage", "/internal/usage"],
    ["summary", "/internal/usage/summary"],
    ["credits", "/internal/billing/credits"],
    ["subscriptions", "/internal/billing/subscriptions"],
  ];
  for (const [key, path] of calls) {
    const r = await api.request(path, { cookie }).catch(() => ({ status: 0, json: null }));
    results[key] = { status: r.status, body: r.json };
  }
  // 会话失效判定
  if (results.usage.status === 401) return { ok: false, reason: "session_invalid", detail: results };

  // 兼容结构：credits 可能直接是对象，也可能包在 {data}/{credits} 里
  const creditsRaw = results.credits.body;
  const creditsInner = creditsRaw?.credits || creditsRaw?.data || creditsRaw;
  const subRaw = results.subscriptions.body;
  const subInner = subRaw?.data || subRaw;
  const sumRaw = results.summary.body || results.usage.body || null;

  const snapshot = toSnapshot({
    creditsObj: normalizeCreditsObject(creditsInner, creditsRaw?.windowLimits),
    subscriptionData: subInner || null,
    summaryObj: sumRaw || null,
    planId: null,
  });
  snapshot.channel = "internal-cookie";
  return { ok: true, snapshot, detail: results };
}

// ---- 通道2：API Key -> /alpha/ ----
async function collectByKey(apiKey) {
  if (!apiKey) return { ok: false, reason: "no_api_key" };
  const who = await api.request("/alpha/whoami", { apiKey }).catch(() => ({ status: 0, json: null }));
  if (who.status !== 200) {
    return { ok: false, reason: who.status === 401 ? "invalid_key" : "whoami_failed", status: who.status };
  }
  const org = who.json?.org || null;
  const userId = who.json?.user?.id || null;
  // 实测：个人账号（org=null）必须用 userId 参数，orgId 会 403
  const idParam = org?.id ? `orgId=${encodeURIComponent(org.id)}` : `userId=${encodeURIComponent(userId || "")}`;
  if (!org?.id && !userId) return { ok: false, reason: "no_account_id" };
  const [c, s, u] = await Promise.all([
    api.request("/alpha/billing/credits?" + idParam, { apiKey }),
    api.request("/alpha/billing/subscriptions?" + idParam, { apiKey }),
    api.request("/alpha/usage/summary?" + idParam, { apiKey }),
  ]);
  const creditsRaw = c.json?.credits || c.json?.data || c.json;
  const subInner = s.json?.data || s.json;

  const snapshot = toSnapshot({
    creditsObj: normalizeCreditsObject(creditsRaw, c.json?.windowLimits),
    subscriptionData: subInner || null,
    summaryObj: u.json || null,
    planId: org?.planId || null,
  });
  snapshot.channel = "alpha-key";
  snapshot.account = { accountId: org?.login || null, userName: who.json?.user?.userName || null, userId };
  return { ok: true, snapshot };
}

// 刷新单个账号：CommandCode 优先 API Key 通道（手动添加模式）；无 Key 时回退 Cookie 通道
async function refreshAccount(acc) {
  if ((acc.platform || "commandcode") === "bigmodel") {
    const result = await bigmodel.collect(acc);
    if (result.ok) {
      const saved = accounts.setQuota(acc.id, result.snapshot);
      return { ok: true, reason: "bigmodel", account: saved };
    }
    return result;
  }
  if ((acc.platform || "commandcode") === "deepseek") {
    const key = acc.apiKeys?.find((k) => k.keyEnc);
    if (!key) return { ok: false, reason: "no_api_key" };
    const result = await deepseek.collectByKey(storageDecrypt(key.keyEnc));
    if (result.ok) {
      const saved = accounts.setQuota(acc.id, result.snapshot);
      return { ok: true, reason: "deepseek", account: saved };
    }
    return result;
  }
  const key = acc.apiKeys?.find((k) => k.keyEnc);
  if (key) {
    const byKey = await collectByKey(storageDecrypt(key.keyEnc));
    if (byKey.ok) {
      const saved = accounts.setQuota(acc.id, byKey.snapshot);
      return { ok: true, reason: "key", account: saved };
    }
    if (byKey.reason === "invalid_key") return byKey;
  }
  const byCookie = await collectByCookie(acc);
  if (byCookie.ok) {
    const saved = accounts.setQuota(acc.id, byCookie.snapshot);
    return { ok: true, reason: "cookie", account: saved };
  }
  return { ok: false, reason: key ? "key_failed" : (byCookie ? byCookie.reason : "no_session") };
}

const storage = require("./storage.cjs");
function storageDecrypt(b64) {
  return storage.decrypt(b64);
}

module.exports = { collectByCookie, collectByKey, refreshAccount, toSnapshot, normalizeCreditsObject };
