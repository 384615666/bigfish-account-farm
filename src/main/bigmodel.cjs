"use strict";
// 智谱 BigModel 套餐余量采集。
// 官方用量页前端使用 /api/monitor/usage/quota/limit，登录态返回 {success,data:{limits,level}}。
const BASE = "https://www.bigmodel.cn/api";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 CCAccountManager/0.1";

async function request(path, { token, apiKey, organization, project, query = {}, timeoutMs = 20000 } = {}) {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const headers = { "User-Agent": UA, Accept: "application/json" };
  if (token) headers.Authorization = token;
  if (apiKey) headers["Api-Key"] = apiKey;
  if (organization) headers["Bigmodel-Organization"] = organization;
  if (project) headers["Bigmodel-Project"] = project;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
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

function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function normalizeLimit(raw, unit, title) {
  if (!raw) return null;
  const used = num(raw.currentValue ?? raw.usedAmount ?? raw.used);
  const cap = num(raw.usage ?? raw.limit ?? raw.totalAmount ?? raw.cap ?? raw.total) ??
    (() => {
      const text = JSON.stringify(raw);
      const match = String(text || "").match(/(?:上限|总额度|总量|total|limit)[^0-9]{0,30}([0-9]+(?:\.[0-9]+)?)/i);
      return match ? num(match[1]) : null;
    })();
  const resetAt = parseTime(raw.nextResetTime ?? raw.resetAt ?? raw.expireTime);
  return {
    title,
    used: used ?? null,
    cap: cap ?? null,
    remaining: cap != null && used != null ? Math.max(0, cap - used) : null,
    percentage: num(raw.percentage),
    resetAt,
    unit: raw.unit ?? unit,
    type: raw.type ?? null,
  };
}

function normalizeSnapshot(response, account) {
  const body = response.json;
  if (!body || body.success === false || response.status >= 400) {
    const invalid = response.status === 401 || body?.code === 401 || body?.code === 1001;
    return { ok: false, reason: invalid ? "invalid_token" : "request_failed", status: response.status, detail: body };
  }
  const data = body.data || body || {};
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const matchesTitle = (item, pattern) => pattern.test(String(item?.title || item?.name || item?.label || ""));
  const fiveHour = normalizeLimit(
    limits.find((item) => item.unit === 3 && item.type === "CREDIT_LIMIT") ||
      limits.find((item) => item.unit === 3 || matchesTitle(item, /5\s*小时|five/i)) ||
      limits.find((item) => item.type === "CREDIT_LIMIT"),
    3,
    "5小时额度"
  );
  const weekly = normalizeLimit(
    limits.find((item) => item.unit === 6 && item.type === "CREDIT_LIMIT") ||
      limits.find((item) => item.unit === 6 || matchesTitle(item, /周/i)) ||
      limits.find((item) => item.type === "CREDIT_LIMIT"),
    6,
    "周额度"
  );
  const mcp = normalizeLimit(limits.find((item) => item.unit === 5 || /MCP/i.test(item.title || "")), 5, "MCP月额度");
  const credit = limits.find((item) => item.type === "CREDIT_LIMIT");
  const tokens = limits.find((item) => item.type === "TOKENS_LIMIT");
  return {
    ok: true,
    snapshot: {
      platform: "bigmodel",
      level: data.level || account?.planId || null,
      planId: data.level || account?.planId || null,
      fiveHour,
      weekly,
      mcp,
      raw: { limits, level: data.level || null, version: data.version || null },
    },
    detail: { fiveHour, weekly, mcp, credit: credit || null, tokens: tokens || null, response: body },
  };
}

async function collect(acc) {
  const apiKey = acc?.bigmodelCredentials?.apiKeyEnc ? require("./storage.cjs").decrypt(acc.bigmodelCredentials.apiKeyEnc) : null;
  const token = acc?.bigmodelCredentials?.tokenEnc ? require("./storage.cjs").decrypt(acc.bigmodelCredentials.tokenEnc) : null;
  if (!apiKey && !token) return { ok: false, reason: "no_credentials" };
  const organization = acc?.bigmodelCredentials?.organizationEnc ? require("./storage.cjs").decrypt(acc.bigmodelCredentials.organizationEnc) : null;
  const project = acc?.bigmodelCredentials?.projectEnc ? require("./storage.cjs").decrypt(acc.bigmodelCredentials.projectEnc) : null;
  const response = await request("/monitor/usage/quota/limit", { token, apiKey, organization, project });
  return normalizeSnapshot(response, acc);
}

module.exports = { BASE, request, collect, normalizeLimit, normalizeSnapshot };
