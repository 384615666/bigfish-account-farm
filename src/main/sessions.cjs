"use strict";
// 每个账号一个持久化 Electron session partition：persist:cc-acct-<id>
// 捕获：登录成功后收集相关域名 Cookie，加密存入账号
// 注入：打开账号浏览器前把 Cookie 写回对应 partition
const { session } = require("electron");
const storage = require("./storage.cjs");
const accounts = require("./accounts.cjs");
const api = require("./api.cjs");

const DOMAINS = ["commandcode.ai", "api.commandcode.ai"];
const partitionFor = (localId) => `persist:cc-acct-${localId}`;
const TOKEN_COOKIE = "__Secure-commandcode_prod_.session_token";
const DATA_COOKIE = "__Secure-commandcode_prod_.session_data";
const LEGACY_COOKIE_RE = /^_+Secure-commandcode(?:_prod)?_?\.session_(token|data)$/i;
// 历史 bug：早期版本把用户 UUID（user.id）误存为 accountId。
// 链接用的"登录名"是 get-session 的 user.userName（回退 user.name）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(v) {
  return UUID_RE.test(String(v || ""));
}

// 账号 identity 在本地是否显然错误（缺登录名或存成了 UUID）
function accountIdLooksWrong(acc) {
  return !acc || !acc.accountId || looksLikeUuid(acc.accountId);
}

// 由 get-session 响应提取账号登录名（usage URL 用的 id）
function loginFromSession(gs) {
  const user = (gs && gs.user) || {};
  return user.userName || user.name || null;
}

// 从 session_data Cookie 解码得到登录名（user.userName），无需联网即可修复
// 早期版本把用户 UUID 当 accountId 的存量数据。解码失败返回 null。
function loginFromCookie(cookieHeader) {
  const pair = String(cookieHeader || "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .find((p) => /session_data/i.test(p.split("=")[0]));
  if (!pair) return null;
  try {
    const json = JSON.parse(Buffer.from(decodeCookieValue(pair.slice(pair.indexOf("=") + 1)), "base64").toString("utf8"));
    // 实测 session_data 结构：{session:{session:{...},user:{...}},expiresAt,signature}
    // 兼容两种层级，避免旧版/新版字段位置差异
    const user = (json && (json.session?.user || json.user)) || null;
    return (user && (user.userName || user.name)) || null;
  } catch {
    return null;
  }
}

// 从 session_data Cookie 离线解码邮箱（与 loginFromCookie 同源，供浏览器一键添加等场景）
function emailFromCookie(cookieHeader) {
  const pair = String(cookieHeader || "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .find((p) => /session_data/i.test(p.split("=")[0]));
  if (!pair) return null;
  try {
    const json = JSON.parse(Buffer.from(decodeCookieValue(pair.slice(pair.indexOf("=") + 1)), "base64").toString("utf8"));
    const user = (json && (json.session?.user || json.user)) || null;
    return (user && user.email) || null;
  } catch {
    return null;
  }
}

// 对比本地账号与最新 get-session，返回需要写回的字段（无变化返回 null）
function identityPatch(acc, gs) {
  const user = (gs && gs.user) || {};
  const login = user.userName || user.name || null;
  const email = user.email || null;
  const patch = {};
  const currentAccountId = String((acc && acc.accountId) || "");
  if (login && (!currentAccountId || looksLikeUuid(currentAccountId) || login !== currentAccountId)) {
    patch.accountId = login;
  }
  if (email && email !== (acc && acc.email)) patch.email = email;
  return Object.keys(patch).length ? patch : null;
}

// 用会话 Cookie 拉一次 get-session，把账号登录名/邮箱纠正回来（修复 UUID 当 ID 的存量数据）
async function healAccountIdentity(acc, { onlyIfWrong = false } = {}) {
  if (!acc || !acc.session || !acc.session.cookieEnc) return null;
  if (onlyIfWrong && !accountIdLooksWrong(acc)) return null;
  const cookie = sessionCookie(acc);
  if (!cookie) return null;
  let changed = false;
  // 1) 离线修复：session_data Cookie 里就带登录名，先解码纠正（不依赖网络）
  const offlineLogin = loginFromCookie(cookie);
  if (offlineLogin && accountIdLooksWrong(acc)) {
    accounts.update(acc.id, {
      accountId: offlineLogin,
      email: acc.session?.email || acc.email || null,
    });
    acc.accountId = offlineLogin;
    acc.email = acc.session?.email || acc.email || null;
    changed = true;
  }
  // 2) 在线校验：get-session 拿到最新登录名/邮箱（会话若已失效则保持现状）
  const gs = await api.getSession(cookie).catch(() => null);
  if (!gs) return { accountId: acc.accountId, email: acc.email, changed };
  const patch = identityPatch(acc, gs);
  if (patch) accounts.update(acc.id, patch);
  return {
    accountId: (patch && patch.accountId) || acc.accountId,
    email: (patch && patch.email) || acc.email,
    changed: changed || Boolean(patch),
  };
}

// 浏览器复制的 Cookie 值可能带 URL 转义（如 %2B/%3D），发给服务端前需还原；
// 解码失败则按原值使用。
function decodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// 早期书签把官网 Cookie 名少写了一个前导下划线和 prod 后缀。
// 这些错名会让 get-session 偶然通过，但 /internal/usage 必定 401。
function canonicalizeSessionCookie(cookieHeader) {
  const pairs = String(cookieHeader || "").split(";").map((pair) => pair.trim()).filter(Boolean);
  let changed = false;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const match = name.match(LEGACY_COOKIE_RE);
    if (!match) continue;
    const canonicalName = match[1].toLowerCase() === "token" ? TOKEN_COOKIE : DATA_COOKIE;
    if (name !== canonicalName) {
      pairs[index] = canonicalName + "=" + pair.slice(eq + 1);
      changed = true;
    }
  }
  return changed ? pairs.join("; ") : String(cookieHeader || "");
}

// 启动时把已保存的旧书签 Cookie 名一次性迁移到官网规范名。
// 不改动解密失败的数据；迁移失败不影响应用启动。
function repairStoredCookieNames() {
  let repaired = 0;
  for (const acc of accounts.listAll(true)) {
    if (!acc?.session?.cookieEnc || !sessionUsable(acc)) continue;
    const raw = storage.decrypt(acc.session.cookieEnc);
    const next = canonicalizeSessionCookie(raw);
    if (!next || next === raw) continue;
    accounts.setSession(acc.id, {
      ...acc.session,
      cookieEnc: storage.encrypt(next),
      updatedAt: new Date().toISOString(),
    });
    repaired += 1;
  }
  return repaired;
}

async function grabCookies(partitionName) {
  const s = session.fromPartition(partitionName);
  const all = [];
  for (const domain of DOMAINS) {
    const cookies = await s.cookies.get({ domain });
    for (const c of cookies) {
      all.push(`${c.name}=${c.value}`);
    }
  }
  return canonicalizeSessionCookie(all.join("; "));
}

async function injectCookies(partitionName, cookieHeader) {
  const s = session.fromPartition(partitionName);
  await s.cookies.flushStore();
  const pairs = String(cookieHeader || "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  let injected = 0;
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const value = decodeCookieValue(pair.slice(eq + 1));
    // 站点与 API 两个域名都写入，保证打开 usage 页时前端/后端都带得上会话
    for (const host of ["https://commandcode.ai", "https://api.commandcode.ai"]) {
      try {
        await s.cookies.set({
          url: host,
          name,
          value,
          domain: host.replace("https://", ""),
          path: "/",
          secure: true,
          sameSite: "no_restriction",
        });
        injected++;
      } catch {
        /* 单条失败忽略 */
      }
    }
  }
  return injected;
}

// 登录成功回调后：抓 Cookie + 拉 get-session -> 组装 sessionData
async function captureSession(partitionName, opts = {}) {
  const cookieHeader = canonicalizeSessionCookie(await grabCookies(partitionName));
  const gs = await api.getSession(cookieHeader, { timeoutMs: opts.timeoutMs || 20000 }).catch(() => null);
  if (!gs) return { ok: false, reason: "not_logged_in" };
  const sessionInfo = gs.session || {};
  const user = gs.user || {};
  return {
    ok: true,
    cookieHeader,
    expiresAt: sessionInfo.expiresAt || null,
    userId: user.id || null, // 用户 UUID（仅内部标识，不能用于 usage URL）
    username: user.userName || user.name || null, // 登录名（usage URL 用）
    email: user.email || null,
    session: gs,
  };
}

// 保存到账号（加密）
function saveSessionToAccount(localId, { cookieHeader, expiresAt, userId, email }) {
  const acc = accounts.findLocal(localId);
  if (!acc) return null;
  const sessionData = {
    cookieEnc: storage.encrypt(cookieHeader),
    expiresAt: expiresAt || null,
    userId: userId || null,
    email: email || null,
    state: "ok",
    updatedAt: new Date().toISOString(),
  };
  return accounts.setSession(localId, sessionData);
}

function sessionCookie(acc) {
  if (!acc?.session?.cookieEnc) return null;
  return canonicalizeSessionCookie(storage.decrypt(acc.session.cookieEnc));
}

// 会话 Cookie 是否可用（能解出明文才可用于请求/注入）
function sessionUsable(acc) {
  return Boolean(sessionCookie(acc));
}

// 健康检查：get-session 是否有效（可选刷新保存）
async function checkHealth(acc, { refresh = false } = {}) {
  const cookie = sessionCookie(acc);
  if (!cookie) return { state: "no_session", accountId: acc.id };
  const probe = await api.request("/auth/get-session", { cookie, timeoutMs: 12000 });
  const gs = probe.status === 200 ? probe.json : null;
  if (!gs) return { state: "invalid", accountId: acc.id };
  // 顺手纠正账登录名/邮箱（修复早期版本 UUID 当 ID 的存量数据）
  const patch = identityPatch(acc, gs);
  if (patch) accounts.update(acc.id, patch);
  const s = gs.session || {};
  if (refresh) {
    const next = applySetCookie(cookie, probe.headers?.getSetCookie ? probe.headers.getSetCookie() : []);
    if (next && next !== cookie) {
      saveSessionToAccount(acc.id, {
        cookieHeader: next,
        expiresAt: s.expiresAt || acc.session?.expiresAt,
        userId: acc.session?.userId || gs.user?.id || null,
        email: acc.session?.email || gs.user?.email || acc.email || null,
      });
      return { state: "ok", expiresAt: s.expiresAt || null, accountId: acc.id };
    }
    accounts.setSession(acc.id, {
      ...acc.session,
      expiresAt: s.expiresAt || acc.session?.expiresAt,
      state: "ok",
      updatedAt: new Date().toISOString(),
    });
  }
  return { state: "ok", expiresAt: s.expiresAt || null, accountId: acc.id };
}

// 尝试续期 / 健康刷新（阶段0实测结论）：
// - 会话本体约 8 天有效（get-session 的 session.expiresAt），服务器端无法远程续期：
//   update-session 本站返回 400（无可更新字段），POST get-session 返回 405（未开启刷新）。
// - 因此保活 = 定期 get-session 校验 + 应用其 Set-Cookie（刷新 session_data 缓存），
//   会话真正到期前交由 keeper 提示一键重登。
async function tryRenew(acc) {
  // 优先用分区里的活跃 Cookie（内嵌浏览器开着时会携带并自动刷新缓存）
  let header = null;
  try {
    header = await grabCookies(partitionFor(acc.id));
  } catch {
    header = null;
  }
  if (!header) header = sessionCookie(acc);
  if (!header) return { state: "no_session" };

  // 兼容分支：若未来某实例 update-session 可用，仍走 Set-Cookie 重签
  const upd = await api.updateSession(header);
  if (upd.status === 200 && upd.json) {
    const next = applySetCookie(header, upd.setCookie || []);
    // 以会话本体（内层）过期时间为准，不用 session_data 包裹层的 5 分钟缓存态
    const expiresAt = upd.json.session?.expiresAt || acc.session?.expiresAt || null;
    if (next && next !== header) {
      saveSessionToAccount(acc.id, {
        cookieHeader: next,
        expiresAt,
        userId: acc.session?.userId || null,
        email: acc.session?.email || acc.email || null,
      });
      try {
        await injectCookies(partitionFor(acc.id), next);
      } catch {
        /* 注入失败不阻塞 */
      }
    } else {
      accounts.setSession(acc.id, { ...acc.session, expiresAt, state: "ok", updatedAt: new Date().toISOString() });
    }
    return { state: "ok", expiresAt };
  }

  // 主路径：GET /auth/get-session 健康检查 + 应用其 Set-Cookie（刷新 session_data 缓存）
  const r = await api.request("/auth/get-session", { cookie: header }).catch(() => null);
  if (!r || r.status !== 200 || !r.json) return { state: "invalid" };
    const setCookie = api.collectSetCookie ? api.collectSetCookie(r.headers) : [];
    const next = applySetCookie(header, setCookie);
    const s = r.json.session || {};
    const expiresAt = s.expiresAt || acc.session?.expiresAt || null;
    const patch = identityPatch(acc, r.json);
    if (patch) accounts.update(acc.id, patch);
    if (next && next !== header) {
    saveSessionToAccount(acc.id, {
      cookieHeader: next,
      expiresAt,
      userId: acc.session?.userId || s.userId || null,
      email: acc.session?.email || r.json.user?.email || acc.email || null,
    });
    try {
      await injectCookies(partitionFor(acc.id), next);
    } catch {
      /* 注入失败不阻塞 */
    }
  } else {
    accounts.setSession(acc.id, { ...acc.session, expiresAt, state: "ok", updatedAt: new Date().toISOString() });
  }
  return { state: "ok", expiresAt };
}

// ---- 会话 Cookie 重签应用 ----
// 把 update-session 返回的 Set-Cookie（如 _Secure-commandcode_prod.session_token/data）
// 应用到现有 Cookie 头：同名替换，新名追加。
function applySetCookie(header, setCookieList) {
  if (!Array.isArray(setCookieList) || !setCookieList.length) return header;
  const byName = new Map(
    String(header || "")
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => [p.slice(0, p.indexOf("=")), p])
  );
  let changed = false;
  for (const line of setCookieList) {
    const eq = String(line).indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).split(";")[0].trim();
    const pair = name + "=" + value;
    if (byName.get(name) !== pair) {
      byName.set(name, pair);
      changed = true;
    }
  }
  return changed ? [...byName.values()].join("; ") : header;
}

// 从 session_data Cookie 解码包裹层过期时间（毫秒时间戳），返回 ISO 字符串
function decodeSessionExpiry(cookieHeader) {
  const pair = String(cookieHeader || "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .find((p) => /session_data/i.test(p.split("=")[0]));
  if (!pair) return null;
  try {
    const json = JSON.parse(Buffer.from(pair.slice(pair.indexOf("=") + 1), "base64").toString("utf8"));
    const ms = json && typeof json.expiresAt === "number" ? json.expiresAt : null;
    return ms ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

module.exports = {
  partitionFor,
  decodeCookieValue,
  canonicalizeSessionCookie,
  repairStoredCookieNames,
  grabCookies,
  injectCookies,
  captureSession,
  saveSessionToAccount,
  sessionCookie,
  checkHealth,
  tryRenew,
  looksLikeUuid,
  accountIdLooksWrong,
  loginFromSession,
  loginFromCookie,
  emailFromCookie,
  identityPatch,
  healAccountIdentity,
  sessionUsable,
  applySetCookie,
  decodeSessionExpiry,
};
