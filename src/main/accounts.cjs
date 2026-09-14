"use strict";
// 账号/分组 CRUD。本地 id 用 uuid；account_id 是 commandcode.ai 的 login（如 10000001）。
const crypto = require("node:crypto");
const storage = require("./storage.cjs");

const uid = () => crypto.randomUUID();

const PLAN_NAMES = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-max": "Max10×",
  "individual-ultra": "Ultra",
  "teams-pro": "Team Pro",
  "individual-max-20x": "Max20×",
};
function planName(planId) {
  return PLAN_NAMES[planId] || (planId ? String(planId) : "");
}
const PLATFORM_NAMES = { commandcode: "CommandCode", bigmodel: "智谱 BigModel", deepseek: "DeepSeek" };
function platformName(id) {
  return PLATFORM_NAMES[id] || id || "CommandCode";
}

// 脱敏输出：绝不把会话 cookie 明文发给渲染进程
// 会话可用性以「能否用当前 safeStorage 密钥解出 Cookie」为准：
// 本地密钥轮换（重装/升级等）会导致旧密文解不开，此时会话状态应为 broken（需重新登录）。
function sessionUsable(acc) {
  if (!acc || !acc.session || !acc.session.cookieEnc) return false;
  return Boolean(storage.decrypt(acc.session.cookieEnc));
}

function toPublic(acc) {
  const { session, apiKeys, quotaHistory, passwordEnc, bigmodelCredentials, ...rest } = acc;
  // 最近 10 条趋势（5h/周窗口用量），供卡片迷你柱展示
  const hist = Array.isArray(quotaHistory) ? quotaHistory.slice(-10) : [];
  const usable = sessionUsable(acc);
  return {
    ...rest,
    loginMethod: acc.loginMethod || null,
    loginUsername: acc.loginUsername || null,
    hasPassword: Boolean(passwordEnc),
    apiKeys: (apiKeys || []).map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, hasKey: Boolean(k.keyEnc) })),
    planName: planName(acc.planId),
    platform: rest.platform || "commandcode",
    platformName: platformName(acc.platform),
    hasSession: usable,
    sessionExpiresAt: acc.session?.expiresAt || null,
    sessionState: acc.session ? (usable ? acc.session.state || "ok" : "broken") : "none",
    trend: hist.map((h) => ({
      at: h.at,
      fiveHourUsed: h.fiveHour?.used ?? null,
      fiveHourCap: h.fiveHour?.cap ?? null,
      weeklyUsed: h.weekly?.used ?? null,
      weeklyCap: h.weekly?.cap ?? null,
      monthRemaining: h.month?.remaining ?? null,
    })),
  };
}

function list() {
  return storage.get("accounts").map(toPublic);
}


function listAll(includePrivate = false) {
  const accounts = storage.get("accounts");
  return includePrivate ? accounts : accounts.map(toPublic);
}

function findLocal(id) {
  return storage.get("accounts").find((a) => a.id === id) || null;
}

function findPublic(id) {
  const acc = findLocal(id);
  return acc ? toPublic(acc) : null;
}

function create(input = {}) {
  const accounts = storage.get("accounts");
  const now = new Date().toISOString();
  const acc = {
    id: uid(),
    accountId: input.accountId || null, // commandcode.ai login
    email: input.email || null,
    displayName: input.displayName || input.accountId || "未命名账号",
    platform: input.platform || "commandcode",
    loginMethod: input.loginMethod || null,
    loginUsername: input.loginUsername || null,
    passwordEnc: input.passwordEnc || null,
    planId: input.planId || null,
    groupId: input.groupId || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    note: input.note || "",
    status: "active", // active | disabled | archived
    favorite: 0,
    sortOrder: accounts.length,
    lastUsedAt: null,
    quota: null, // 最近一次额度快照（明文展示字段）
    quotaFetchedAt: null,
    apiKeys: [], // [{id, name, keyEnc, createdAt}]
    session: null, // { cookieEnc, expiresAt, state, updatedAt }
    createdAt: now,
    updatedAt: now,
  };
  accounts.push(acc);
  storage.save();
  return toPublic(acc);
}

function update(id, patch) {
  const acc = findLocal(id);
  if (!acc) throw new Error("账号不存在: " + id);
  const allowed = ["accountId", "email", "displayName", "planId", "groupId", "tags", "note", "status", "favorite", "sortOrder", "loginMethod", "loginUsername", "platform"];
  for (const k of allowed) {
    if (patch[k] !== undefined) acc[k] = patch[k];
  }
  acc.updatedAt = new Date().toISOString();
  storage.save();
  return toPublic(acc);
}

function setLoginSecret(id, { password } = {}) {
  const acc = findLocal(id);
  if (!acc) throw new Error("账号不存在: " + id);
  acc.passwordEnc = password ? storage.encrypt(password) : null;
  acc.updatedAt = new Date().toISOString();
  storage.save();
  return toPublic(acc);
}

function getPassword(id) {
  const acc = findLocal(id);
  if (!acc?.passwordEnc) return null;
  return storage.decrypt(acc.passwordEnc);
}

function setPlatformSecret(id, { token, apiKey, organization, project, expiresAt } = {}) {
  const acc = findLocal(id);
  if (!acc) throw new Error("账号不存在: " + id);
  if (acc.platform !== "bigmodel") throw new Error("仅智谱账号支持此凭据");
  acc.bigmodelCredentials = {
    ...(acc.bigmodelCredentials || {}),
    tokenEnc: token === undefined ? acc.bigmodelCredentials.tokenEnc ?? null : token ? storage.encrypt(token) : null,
    apiKeyEnc: apiKey === undefined ? acc.bigmodelCredentials.apiKeyEnc ?? null : apiKey ? storage.encrypt(apiKey) : null,
    organizationEnc: organization === undefined ? acc.bigmodelCredentials.organizationEnc ?? null : organization ? storage.encrypt(organization) : null,
    projectEnc: project === undefined ? acc.bigmodelCredentials.projectEnc ?? null : project ? storage.encrypt(project) : null,
  };
  acc.platformTokenExpiresAt = expiresAt ? Number(expiresAt) : null;
  acc.updatedAt = new Date().toISOString();
  storage.save();
  return toPublic(acc);
}

function getPlatformSecret(id, type) {
  const acc = findLocal(id);
  if (!acc?.bigmodelCredentials) return null;
  const field = type === "apiKey" ? "apiKeyEnc" : type === "organization" ? "organizationEnc" : type === "project" ? "projectEnc" : "tokenEnc";
  const enc = acc.bigmodelCredentials[field];
  return enc ? storage.decrypt(enc) : null;
}

function softRemove(id) {
  return update(id, { status: "archived" });
}

function reorder(ids) {
  if (!Array.isArray(ids)) throw new Error("排序参数无效");
  const wanted = ids.map(String).filter((id, index, arr) => arr.indexOf(id) === index);
  const byId = new Map(storage.get("accounts").map((a) => [a.id, a]));
  if (wanted.some((id) => !byId.has(id))) throw new Error("存在无效的账号");
  if (wanted.length !== byId.size) throw new Error("必须提交全部账号的排序");
  wanted.forEach((id, index) => { byId.get(id).sortOrder = index; });
  storage.save();
  return list();
}
function restore(id) {
  return update(id, { status: "active" });
}
function hardDelete(id) {
  storage.set("accounts", storage.get("accounts").filter((a) => a.id !== id));
  storage.save();
}

// ---- 批量导入（CSV / TSV / 记事本粘贴） ----
// 表头按中英文别名自动识别：账号ID/邮箱/名称/分组/备注/API Key。
const COLUMN_KEYS = [
  { key: "loginMethod", names: ["登录方式", "loginmethod", "auth", "authmethod"] },
  { key: "loginUsername", names: ["登录账号", "登录名", "loginusername", "username", "user"] },
  { key: "password", names: ["密码", "password", "pass"] },
  { key: "accountId", names: ["账号id", "账号", "账户id", "账户", "id", "accountid", "account_id", "account", "login", "userid", "user_id", "uid"] },
  { key: "email", names: ["邮箱", "email", "e-mail", "mail"] },
  { key: "displayName", names: ["名称", "名字", "昵称", "备注名", "别名", "name", "displayname", "display_name", "alias", "nickname"] },
  { key: "groupName", names: ["分组", "组", "group", "groupname", "group_name"] },
  { key: "note", names: ["备注", "说明", "note", "remark"] },
  { key: "apiKey", names: ["api key", "apikey", "api_key", "key", "密钥"] },
  { key: "platform", names: ["平台", "platform", "provider"] },
  { key: "bigmodelToken", names: ["智谱登录令牌", "bigmodeltoken", "token"] },
  { key: "bigmodelApiKey", names: ["智谱key", "bigmodelapikey"] },
];

function splitLine(line, delimiter) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = false;
      } else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseTable(text) {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const first = lines[0];
  let delimiter = "\t";
  for (const d of [",", ";", "\t", "|"]) {
    if (first.includes(d)) {
      delimiter = d;
      break;
    }
  }
  const cells = lines.map((l) => splitLine(l, delimiter));
  return { headers: cells[0], rows: cells.slice(1) };
}

function mapColumns(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const key = String(h || "").trim().toLowerCase().replace(/[\s_\-]+/g, "");
    for (const col of COLUMN_KEYS) {
      if (col.names.some((n) => n.replace(/[\s_\-]+/g, "").toLowerCase() === key)) {
        map[col.key] = i;
        break;
      }
    }
  });
  return map;
}

// 导入文本清单，返回 { added, merged, skipped, errors }
function importPlain(text, opts = {}) {
  const { headers, rows } = parseTable(text);
  const map = mapColumns(headers);
  const platformFirstColumn = map.platform !== undefined && map.displayName !== undefined;
  if (map.accountId === undefined && map.email === undefined && !platformFirstColumn) {
    return { added: 0, merged: 0, skipped: 0, errors: ["未识别到「账号ID」或「邮箱」列，请检查表头"], total: rows.length };
  }
  const data = storage.load();
  let added = 0;
  let merged = 0;
  let skipped = 0;
  const errors = [];
  const get = (row, key) => (map[key] !== undefined ? row[map[key]] || "" : "");

  for (const row of rows) {
    const platformRaw = (get(row, "platform") || "commandcode").trim().toLowerCase();
    const platform = /bigmodel|智谱|zhipu/i.test(platformRaw)
      ? "bigmodel"
      : /deepseek|深海|深度求索|^ds$/i.test(platformRaw)
        ? "deepseek"
        : "commandcode";
    const isBigmodelRow = platform === "bigmodel";
    const accountId = get(row, "accountId");
    const email = get(row, "email");
    const hasApiKey = Boolean(get(row, "apiKey"));
    // DeepSeek / 智谱行只需名称或 Key；CommandCode 行必须有账号ID/邮箱
    if (platform === "commandcode" && !accountId && !email) {
      skipped++;
      continue;
    }
    if (!accountId && !email && (isBigmodelRow || platform === "deepseek") && !hasApiKey && !(get(row, "bigmodelToken") || get(row, "bigmodelApiKey"))) {
      skipped++;
      continue;
    }
    const existing = data.accounts.find((a) => {
      if ((a.platform || "commandcode") !== platform) return false;
      if (accountId && a.accountId === accountId) return true;
      if (!accountId && email && a.email === email) return true;
      // 仅名称+Key 的行（如 DeepSeek）：同平台下按名称去重，避免重复导入
      if (!accountId && !email && get(row, "displayName") && a.displayName === get(row, "displayName")) return true;
      return false;
    });
    if (existing) {
      if (opts.merge) {
        let changed = false;
        if (!existing.displayName && get(row, "displayName")) {
          existing.displayName = get(row, "displayName");
          changed = true;
        }
        if (!existing.accountId && accountId) {
          existing.accountId = accountId;
          changed = true;
        }
        if (!existing.note && get(row, "note")) {
          existing.note = get(row, "note");
          changed = true;
        }
        if (!existing.groupId && get(row, "groupName")) {
          existing.groupId = ensureGroup(get(row, "groupName")).id;
          changed = true;
        }
        const method = get(row, "loginMethod");
        const username = get(row, "loginUsername");
        const password = get(row, "password");
        if (method) {
          existing.loginMethod = method;
          changed = true;
        }
        if (username) {
          existing.loginUsername = username;
          changed = true;
        }
        if (password) {
          existing.passwordEnc = storage.encrypt(password);
          changed = true;
        }
        const bmToken = get(row, "bigmodelToken");
        const bmApiKey = get(row, "bigmodelApiKey");
        if (platform === "bigmodel" && (bmToken || bmApiKey)) {
          existing.platform = {
            ...(existing.platform || {}),
            tokenEnc: bmToken ? storage.encrypt(bmToken) : existing.platform?.tokenEnc || null,
            apiKeyEnc: bmApiKey ? storage.encrypt(bmApiKey) : existing.platform?.apiKeyEnc || null,
          };
          changed = true;
        }
        if (!(existing.apiKeys || []).length && get(row, "apiKey")) {
          existing.apiKeys = [{ id: uid(), name: "default", keyEnc: storage.encrypt(get(row, "apiKey")), createdAt: new Date().toISOString() }];
          changed = true;
        }
        if (changed) {
          existing.updatedAt = new Date().toISOString();
          merged++;
        } else skipped++;
      } else skipped++;
      continue;
    }
    const platformSecrets = {
      tokenEnc: get(row, "bigmodelToken") ? storage.encrypt(get(row, "bigmodelToken")) : null,
      apiKeyEnc: get(row, "bigmodelApiKey") ? storage.encrypt(get(row, "bigmodelApiKey")) : null,
    };
    const acc = create({
      accountId: accountId || null,
      email: email || null,
      displayName: get(row, "displayName") || accountId || email || "导入账号",
      groupId: get(row, "groupName") ? ensureGroup(get(row, "groupName")).id : null,
      note: get(row, "note") || "",
      platform,
      loginMethod: get(row, "loginMethod") || null,
      loginUsername: get(row, "loginUsername") || get(row, "email") || null,
      passwordEnc: get(row, "password") ? storage.encrypt(get(row, "password")) : null,
    });
    if (platform === "bigmodel") {
      const localAccount = findLocal(acc.id);
      localAccount.platform = platform;
      if (platformSecrets.tokenEnc || platformSecrets.apiKeyEnc) {
        localAccount.bigmodelCredentials = platformSecrets;
      }
    }
    if (get(row, "apiKey") && acc.id) {
      // create 已返回脱敏对象；把 Key 写回本地记录
      const local = findLocal(acc.id);
      if (local) {
        local.apiKeys = [{ id: uid(), name: "default", keyEnc: storage.encrypt(get(row, "apiKey")), createdAt: new Date().toISOString() }];
      }
    }
    added++;
  }
  if (added || merged || errors.length) storage.save();
  return { added, merged, skipped, errors, total: rows.length };
}

// ---- 分组 ----
function listGroups() {
  return storage.get("groups");
}
function saveGroups(groups) {
  storage.set("groups", Array.isArray(groups) ? groups : []);
  storage.save();
  return storage.get("groups");
}
// 新建分组：name 去空白、查重、自动排序；返回新建的分组
function createGroup(name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("请输入分组名称");
  const groups = storage.get("groups");
  if (groups.some((g) => g.name === n && !g.archived)) throw new Error("分组已存在：" + n);
  const g = { id: uid(), name: n, sortOrder: groups.length + 1, archived: false };
  groups.push(g);
  storage.save();
  return g;
}
// 重命名分组：name 去空白、查重（排除自己）；返回更新后的分组
function renameGroup(id, name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("请输入分组名称");
  const groups = storage.get("groups");
  const g = groups.find((x) => x.id === id && !x.archived);
  if (!g) throw new Error("分组不存在");
  if (groups.some((x) => x.id !== id && x.name === n && !x.archived)) throw new Error("分组已存在：" + n);
  g.name = n;
  storage.save();
  return g;
}
// 删除分组：组内账号自动移回「未分组」，避免账号丢失
function removeGroup(id) {
  const groups = storage.get("groups");
  const idx = groups.findIndex((x) => x.id === id && !x.archived);
  if (idx === -1) throw new Error("分组不存在");
  groups.splice(idx, 1);
  for (const a of storage.get("accounts")) {
    if (a.groupId === id) a.groupId = null;
  }
  storage.save();
  return true;
}
function ensureGroup(name) {
  const groups = storage.get("groups");
  let g = groups.find((x) => x.name === name && !x.archived);
  if (!g) {
    g = { id: uid(), name, sortOrder: groups.length + 1, archived: false };
    groups.push(g);
    storage.save();
  }
  return g;
}

// ---- 会话绑定 ----
function setSession(id, sessionData) {
  const acc = findLocal(id);
  if (!acc) throw new Error("账号不存在: " + id);
  acc.session = sessionData; // {cookieEnc, expiresAt, state, updatedAt}
  acc.updatedAt = new Date().toISOString();
  storage.save();
  return toPublic(acc);
}
function setQuota(id, quotaSnapshot) {
  const acc = findLocal(id);
  if (!acc) throw new Error("账号不存在: " + id);
  acc.quota = quotaSnapshot;
  acc.quotaFetchedAt = new Date().toISOString();
  acc.updatedAt = new Date().toISOString();
  storage.save();
  return toPublic(acc);
}
function setLastUsed(id) {
  const acc = findLocal(id);
  if (acc) {
    acc.lastUsedAt = new Date().toISOString();
    storage.save();
  }
}

module.exports = {
  uid,
  planName,
  platformName,
  toPublic,
  sessionUsable,
  list,
  listAll,
  findLocal,
  findPublic,
  create,
  update,
  setLoginSecret,
  getPassword,
  setPlatformSecret,
  getPlatformSecret,
  softRemove,
  restore,
  hardDelete,
  listGroups,
  saveGroups,
  createGroup,
  ensureGroup,
  renameGroup,
  removeGroup,
  reorder,
  setSession,
  setQuota,
  setLastUsed,
  importPlain,
};


