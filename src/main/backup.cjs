"use strict";
// 备份与恢复：整包 safeStorage 加密（本机绑定），用于防丢数据/迁移同机。
const { app, dialog, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const storage = require("./storage.cjs");
const accounts = require("./accounts.cjs");

const AUTO_BACKUP_KEEP = 14;

function buildExport() {
  const data = {
    app: "bigfish-farm-account-manager",
    version: 1,
    exportedAt: new Date().toISOString(),
    groups: storage.get("groups"),
    settings: storage.getSettings(),
    accounts: storage.get("accounts").map((a) => ({
      ...a,
      session: a.session ? { ...a.session, cookie: storage.decrypt(a.session.cookieEnc) } : null,
      apiKeys: (a.apiKeys || []).map((k) => ({ ...k, key: storage.decrypt(k.keyEnc) })),
      password: storage.decrypt(a.passwordEnc),
      platform: a.platform || null,
      bigmodelCredentials: a.bigmodelCredentials && typeof a.bigmodelCredentials === "object" ? {
        token: a.bigmodelCredentials.tokenEnc ? storage.decrypt(a.bigmodelCredentials.tokenEnc) : null,
        apiKey: a.bigmodelCredentials.apiKeyEnc ? storage.decrypt(a.bigmodelCredentials.apiKeyEnc) : null,
      } : null,
    })),
  };
  const wrapped = safeStorage.encryptString(JSON.stringify(data)).toString("base64");
  return JSON.stringify({ wrapped: "safeStorage-v1", payload: wrapped });
}

async function exportToFile() {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "导出加密备份",
    defaultPath: "cc-accounts-backup.json",
    filters: [{ name: "加密备份", extensions: ["json"] }],
  });
  if (canceled || !filePath) return { canceled: true };
  fs.writeFileSync(filePath, buildExport(), "utf8");
  return { canceled: false, filePath };
}

async function importFromFile({ merge = false } = {}) {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "导入备份",
    filters: [{ name: "加密备份", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths[0]) return { canceled: true };
  const raw = JSON.parse(fs.readFileSync(filePaths[0], "utf8"));
  if (raw.wrapped !== "safeStorage-v1") throw new Error("不是本应用导出的备份文件");
  let data;
  try {
    data = JSON.parse(safeStorage.decryptString(Buffer.from(raw.payload, "base64")));
  } catch (e) {
    throw new Error("备份解密失败（可能来自其他电脑或文件损坏）：" + String((e && e.message) || e));
  }
  if (!data || !Array.isArray(data.accounts)) throw new Error("备份文件格式无效");
  const restored = data.accounts.map((a) => ({
    ...a,
    session: a.session ? { ...a.session, cookieEnc: a.session.cookie ? storage.encrypt(a.session.cookie) : null } : null,
    apiKeys: (a.apiKeys || []).map((k) => ({ ...k, keyEnc: k.key ? storage.encrypt(k.key) : null })),
    passwordEnc: a.password ? storage.encrypt(a.password) : null,
    platform: a.platform || null,
    bigmodelCredentials: (a.bigmodelCredentials || (typeof a.platform === "object" && a.platform?.tokenEnc ? a.platform : null)) ? {
      tokenEnc: a.bigmodelCredentials.token ? storage.encrypt(a.bigmodelCredentials.token) : null,
      apiKeyEnc: a.bigmodelCredentials.apiKey ? storage.encrypt(a.bigmodelCredentials.apiKey) : null,
    } : null,
  }));
  const accounts = storage.get("accounts");
  const groups = storage.get("groups");
  if (merge) {
    const exists = new Set(accounts.map((a) => a.id));
    storage.set("accounts", [...accounts, ...restored.filter((a) => !exists.has(a.id))]);
    const gIds = new Set(groups.map((g) => g.id));
    storage.set("groups", [...groups, ...(data.groups || []).filter((g) => !gIds.has(g.id))]);
  } else {
    storage.set("accounts", restored);
    storage.set("groups", data.groups || []);
    if (data.settings && typeof data.settings === "object") storage.set("settings", data.settings);
  }
  storage.save();
  return { canceled: false, filePath: filePaths[0], count: restored.length, merge };
}

// ---- 每日自动备份（保留最近 14 份，按天去重） ----
function backupsDir() {
  return path.join(app.getPath("userData"), "backups");
}
function backupFiles() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("cc-") && f.endsWith(".json"))
    .sort();
}
function hasBackupToday() {
  const today = new Date().toISOString().slice(0, 10);
  return backupFiles().some((f) => f.startsWith("cc-" + today));
}
function autoBackup() {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, "cc-" + stamp + ".json");
  fs.writeFileSync(file, buildExport(), "utf8");
  const files = backupFiles();
  const remove = files.length - AUTO_BACKUP_KEEP;
  for (let i = 0; i < remove; i++) {
    try {
      fs.unlinkSync(path.join(dir, files[i]));
    } catch {
      /* 清理失败忽略 */
    }
  }
  return { ok: true, filePath: file, total: Math.min(files.length, AUTO_BACKUP_KEEP) };
}

// ---- 清单 CSV 导出（Excel 可直接打开；不含敏感密钥） ----
function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function buildCsv() {
  const groupName = (id) => {
    const g = storage.get("groups").find((x) => x.id === id);
    return g ? g.name : "";
  };
  const head = ["平台", "名称", "账号ID", "邮箱", "登录方式", "登录账号", "分组", "套餐", "月剩余", "月周期结束", "周已用", "周上限", "5h已用", "5h上限", "会话", "最近刷新", "备注"];
  const rows = storage.get("accounts").map((a) => {
    const q = a.quota || {};
    const m = q.month || {};
    const wk = q.weekly || {};
    const fh = q.fiveHour || {};
    return [
      accounts.platformName(a.platform || "commandcode"),
      a.displayName,
      a.accountId || "",
      a.email || "",
      a.loginMethod || "",
      a.loginUsername || "",
      groupName(a.groupId),
      a.planId || "",
      m.remaining != null ? m.remaining : "",
      m.periodEnd || "",
      wk.used != null ? wk.used : "",
      wk.cap != null ? wk.cap : "",
      fh.used != null ? fh.used : "",
      fh.cap != null ? fh.cap : "",
      a.session ? a.session.state || "ok" : "none",
      a.quotaFetchedAt || "",
      a.note || "",
    ];
  });
  return [head, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}
async function exportCsvToFile() {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "导出账号清单（CSV）",
    defaultPath: "cc-accounts.csv",
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (canceled || !filePath) return { canceled: true };
  fs.writeFileSync(filePath, "\ufeff" + buildCsv(), "utf8"); // BOM 便于 Excel 识别中文
  return { canceled: false, filePath };
}

function buildCredentialCsv() {
  const groupName = (id) => {
    const g = storage.get("groups").find((x) => x.id === id);
    return g ? g.name : "";
  };
  const head = ["平台", "名称", "账号ID", "邮箱", "登录方式", "登录账号", "密码", "API Key", "智谱登录令牌", "智谱API Key", "分组", "备注"];
  const rows = storage.get("accounts").map((a) => [
    accounts.platformName(a.platform || "commandcode"),
    a.displayName,
    a.accountId || "",
    a.email || "",
    a.loginMethod || "",
    a.loginUsername || "",
    storage.decrypt(a.passwordEnc) || "",
    storage.decrypt((a.apiKeys || [])[0]?.keyEnc) || "",
    a.bigmodelCredentials?.tokenEnc ? storage.decrypt(a.bigmodelCredentials.tokenEnc) || "" : "",
    a.bigmodelCredentials?.apiKeyEnc ? storage.decrypt(a.bigmodelCredentials.apiKeyEnc) || "" : "",
    groupName(a.groupId),
    a.note || "",
  ]);
  return [head, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

async function exportCredentialsCsvToFile() {
  const { response, filePath } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["继续导出", "取消"],
    defaultId: 0,
    cancelId: 1,
    message: "导出包含账号密码和 API Key 的凭据 CSV？",
    detail: "文件将是明文，请勿发给他人；建议保存在本机加密磁盘或移动后立即删除。",
  });
  if (response !== 0) return { canceled: true };
  const target = await dialog.showSaveDialog({
    title: "导出凭据 CSV",
    defaultPath: "cc-account-credentials.csv",
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (target.canceled || !target.filePath) return { canceled: true };
  fs.writeFileSync(target.filePath, "\ufeff" + buildCredentialCsv(), "utf8");
  return { canceled: false, filePath: target.filePath };
}

module.exports = { exportToFile, importFromFile, autoBackup, hasBackupToday, buildCsv, exportCsvToFile, buildCredentialCsv, exportCredentialsCsvToFile };
