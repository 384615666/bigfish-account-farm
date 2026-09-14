"use strict";
// DeepSeek 官方余额采集：仅凭 API Key（sk-...）调 GET /user/balance。
// 官方（api-docs.deepseek.com）仅公开该余额端点；今日消费/Token 用量需登录
// platform.deepseek.com 查看，无仅凭 Key 的接口，故本模块不采集用量。
const BASE = "https://api.deepseek.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 CCAccountManager/0.1";

async function request(path, { apiKey, timeoutMs = 20000 } = {}) {
  const headers = { "User-Agent": UA, Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

// 把官方 balance_infos 项归一化：{currency,total_balance,granted_balance,topped_up_balance}
function normalizeBalance(raw) {
  if (!raw || typeof raw !== "object") return null;
  const currency = String(raw.currency || "CNY").toUpperCase();
  const total = num(raw.total_balance ?? raw.totalBalance ?? raw.total);
  const granted = num(raw.granted_balance ?? raw.grantedBalance ?? raw.granted);
  const toppedUp = num(raw.topped_up_balance ?? raw.toppedUpBalance ?? raw.topped_up ?? raw.toppedUp);
  if (total === null && granted === null && toppedUp === null) return null;
  return { currency, total, granted, toppedUp };
}

function normalizeSnapshot(response) {
  const body = response.json;
  // 网关对任意路径一律先鉴权：401/403 = Key 无效；其余非 200 或结构异常 = 接口失败
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "invalid_key", status: response.status, detail: body };
  }
  if (response.status >= 400 || !body || typeof body !== "object") {
    return { ok: false, reason: "request_failed", status: response.status, detail: body };
  }
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const balances = infos.map(normalizeBalance).filter(Boolean);
  const snapshot = {
    platform: "deepseek",
    channel: "deepseek-key",
    isAvailable: body.is_available === true,
    balances,
    primary: balances[0] || null,
    raw: { body },
  };
  if (!balances.length) {
    return { ok: false, reason: "request_failed", status: response.status, detail: body, snapshot };
  }
  return { ok: true, snapshot, status: response.status, detail: body };
}

async function collectByKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, reason: "no_api_key" };
  let response;
  try {
    response = await request("/user/balance", { apiKey: key });
  } catch {
    // fetch 抛错（超时/断网/DNS）视为网络异常，与 HTTP 错误区分
    return { ok: false, reason: "network_error", status: 0 };
  }
  return normalizeSnapshot(response);
}

module.exports = { BASE, request, collectByKey, normalizeBalance, normalizeSnapshot };
