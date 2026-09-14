"use strict";
// 与 api.commandcode.ai 通信的最小客户端（主进程使用 Node fetch）
const BASE = "https://api.commandcode.ai";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 CCAccountManager/0.1";

async function request(path, { cookie, apiKey, method = "GET", body, origin, timeoutMs = 20000 } = {}) {
  const headers = { "User-Agent": UA, Accept: "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (origin) headers.Origin = origin;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    method = method || "POST";
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text, headers: res.headers };
}

// 会话探针：返回 null 表示未登录（登录态返回 {session, user}）
async function getSession(cookie, opts = {}) {
  const r = await request("/auth/get-session", { cookie, timeoutMs: opts.timeoutMs });
  if (r.status !== 200 || r.json === null) return null;
  return r.json;
}

// better-auth 标准续期接口。返回 { status, json, setCookie: string[] }；
// setCookie 用于把服务器重签的会话 Cookie 同步回本地（令牌窗口较短时必须）。
async function updateSession(cookie) {
  try {
    let lastStatus = 0;
    const attempts = [
      () => request("/auth/update-session", { cookie, method: "POST", body: {}, origin: "https://commandcode.ai" }),
      () => request("/auth/update-session", { cookie, method: "GET" }),
    ];
    for (const attempt of attempts) {
      const r = await attempt();
      lastStatus = r.status || lastStatus;
      if (r.status === 200 && r.json) {
        const setCookie = collectSetCookie(r.headers);
        return { status: r.status, json: r.json, setCookie };
      }
      if (r.status === 401 || r.status === 403) return { status: r.status, json: null, setCookie: [] };
    }
    return { status: lastStatus, json: null, setCookie: [] };
  } catch {
    return { status: 0, json: null, setCookie: [] };
  }
}

function collectSetCookie(headers) {
  try {
    if (headers && typeof headers.getSetCookie === "function") return headers.getSetCookie();
    const single = headers && headers.get("set-cookie");
    return single ? [single] : [];
  } catch {
    return [];
  }
}

module.exports = { BASE, request, getSession, updateSession, collectSetCookie };
