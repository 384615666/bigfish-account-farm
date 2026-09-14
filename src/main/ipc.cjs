"use strict";
// 渲染进程 <-> 主进程 IPC。渲染进程只能调用白名单 channel。
const { ipcMain } = require("electron");
const { dialog, app, clipboard, shell } = require("electron");
const fs = require("node:fs");
const accounts = require("./accounts.cjs");
const storage = require("./storage.cjs");
const sessions = require("./sessions.cjs");
const quota = require("./quota.cjs");
const keeper = require("./keeper.cjs");
const browser = require("./browser.cjs");
const backup = require("./backup.cjs");
const bigmodel = require("./bigmodel.cjs");
const bigmodelAuth = require("./bigmodel-auth.cjs");
const api = require("./api.cjs");
const webServer = require("./web-server.cjs");
const crypto = require("node:crypto");
const { decodeText } = require("./encoding.cjs");

let mainWindow = null;

function init(mw) {
  mainWindow = mw;
  bigmodelAuth.setMainWindow(mw);
  browser.setEventHandler((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("cc:event", payload);
  });
  keeper.start((payload) => send(payload));

  function send(payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("cc:event", payload);
  }

  const wrap = (fn) => async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  };

  const h = (channel, fn) => ipcMain.handle(channel, wrap(fn));

  h("commandcode:testKey", async (apiKey) => {
    if (!apiKey) throw new Error("请填写 API Key");
    const quota = require("./quota.cjs");
    const result = await quota.collectByKey(String(apiKey).trim());
    if (!result.ok) {
      const reasonMap = {
        invalid_key: "API Key 无效或已过期",
        whoami_failed: "无法连接 CommandCode 接口（网络/服务异常）",
        no_account_id: "该 Key 未关联账号信息",
      };
      throw new Error(reasonMap[result.reason] || "Key 校验失败");
    }
    return { ok: true, snapshot: result.snapshot, account: result.snapshot.account || {} };
  });

  h("deepseek:testKey", async (apiKey) => {
    if (!apiKey) throw new Error("请填写 API Key");
    const deepseek = require("./deepseek.cjs");
    const result = await deepseek.collectByKey(String(apiKey).trim());
    if (!result.ok) {
      const reasonMap = {
        no_api_key: "请填写 API Key",
        invalid_key: "API Key 无效或已过期",
        request_failed: "DeepSeek 接口异常（请稍后重试）",
        network_error: "无法连接 DeepSeek 接口（网络/超时）",
      };
      throw new Error(reasonMap[result.reason] || "Key 校验失败");
    }
    return { ok: true, snapshot: result.snapshot };
  });

  h("accounts:list", () => accounts.list());
  h("accounts:create", async (input) => {
    const account = accounts.create(input);
    if ((input.platform || "commandcode") === "bigmodel" && input.bigmodelToken) {
      return accounts.setPlatformSecret(account.id, { token: input.bigmodelToken, apiKey: input.bigmodelApiKey });
    }
    if (input.apiKey) {
      const keys = [...(account.apiKeys || [])];
      keys.push({ id: crypto.randomUUID(), name: "默认", keyEnc: storage.encrypt(String(input.apiKey).trim()), createdAt: new Date().toISOString() });
      const acc = accounts.findLocal(account.id);
      acc.apiKeys = keys;
      storage.save();
    }
    return accounts.findPublic(account.id);
  });
  h("accounts:update", (id, patch) => accounts.update(id, patch));
  h("accounts:reorder", (ids) => accounts.reorder(ids));
  h("accounts:getPassword", (id) => accounts.getPassword(id));
  h("accounts:setLoginSecret", (id, input) => accounts.setLoginSecret(id, input || {}));
  h("accounts:copyPassword", (id) => {
    const password = accounts.getPassword(id);
    if (!password) throw new Error("未保存密码");
    clipboard.writeText(password);
    return true;
  });
  h("accounts:softRemove", (id) => accounts.softRemove(id));
 h("accounts:restore", (id) => accounts.restore(id));
  h("accounts:hardDelete", (id) => {
    browser.disposeAccount(id);
    accounts.hardDelete(id);
    return true;
  });
  h("accounts:importPlain", (text, opts) => accounts.importPlain(String(text || ""), opts || {}));
  h("accounts:setPlatformSecret", (id, secrets) => accounts.setPlatformSecret(id, secrets || {}));
  h("accounts:getPlatformSecret", (id, type) => accounts.getPlatformSecret(id, type));
  h("bigmodel:test", async (id, input = {}) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    const token = input.token || accounts.getPlatformSecret(id, "token");
    const apiKey = input.apiKey || accounts.getPlatformSecret(id, "apiKey");
    if (!token && !apiKey) throw new Error("请先填写登录令牌或 API Key");
    const organization = accounts.getPlatformSecret(id, "organization");
    const project = accounts.getPlatformSecret(id, "project");
    const response = await bigmodel.request("/monitor/usage/quota/limit", { token, apiKey, organization, project });
    const result = bigmodel.normalizeSnapshot(response, acc);
    if (result.ok) {
      try {
        accounts.setQuota(id, result.snapshot);
      } catch {
        /* 测试凭据仍返回结果，保存快照失败不阻塞 */
      }
    }
    return { ...result, status: response.status };
  });
  h("bigmodel:testCredentials", async ({ token, apiKey } = {}) => {
    if (!token && !apiKey) throw new Error("请先填写登录令牌或 API Key");
    const response = await bigmodel.request("/monitor/usage/quota/limit", { token, apiKey });
    const result = bigmodel.normalizeSnapshot(response, {});
    return { ...result, status: response.status };
  });
  h("bigmodel:startLogin", (options) => bigmodelAuth.startLogin(options || {}));
  h("bigmodel:finalizeLogin", (input) => bigmodelAuth.finalizeLogin(input || {}));
  h("bigmodel:closeLogin", () => bigmodelAuth.closeLoginWindow());
  h("bigmodel:discardToken", () => bigmodelAuth.discardToken());
  h("accounts:importCsvFile", async (opts) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: "选择账号清单文件",
      filters: [
        { name: "清单文件", extensions: ["csv", "txt", "tsv"] },
      ],
      properties: ["openFile"],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    const text = decodeText(fs.readFileSync(filePaths[0]));
    return { canceled: false, filePath: filePaths[0], ...accounts.importPlain(text, opts || {}) };
  });
  h("groups:list", () => accounts.listGroups());
  h("groups:save", (groups) => accounts.saveGroups(groups));
  h("groups:create", (name) => accounts.createGroup(name));
  h("groups:rename", (id, name) => accounts.renameGroup(id, name));
  h("groups:remove", (id) => accounts.removeGroup(id));
  h("settings:get", () => {
    const settings = { ...storage.getSettings() };
    delete settings.webAccessPassword;
    delete settings.webAccessPasswordHash;
    delete settings.webAccessPasswordSalt;
    delete settings.webAccessSecret;
    return settings;
  });
  h("settings:update", (patch) => {
    const incoming = patch || {};
    delete incoming.webAccessPasswordHash;
    delete incoming.webAccessPasswordSalt;
    delete incoming.webAccessSecret;
    if (incoming.webAccessPassword) {
      incoming.webAccessPasswordSalt = crypto.randomBytes(16).toString("hex");
      incoming.webAccessPasswordHash = webServer.hashPassword(incoming.webAccessPassword, incoming.webAccessPasswordSalt);
      delete incoming.webAccessPassword;
      incoming.webAccessSecret = crypto.randomBytes(32).toString("hex");
    }
    const saved = storage.updateSettings(incoming);
    const passwordChanged = Boolean(patch?.webAccessPassword);
    if (incoming.webAccessEnabled !== undefined || incoming.webAccessPort !== undefined || passwordChanged) {
      webServer.restart().catch((e) => console.error("[web] restart failed", e));
    }
    // 开机自启立即生效（仅 Windows）
    if (process.platform === "win32" && patch && patch.autoLaunch !== undefined) {
      app.setLoginItemSettings({ openAtLogin: Boolean(patch.autoLaunch) });
    }
    // 保活/自动刷新间隔等设置立即生效：按新值重启定时器（stopTimers 会先清理旧定时器）
    keeper.start((payload) => send(payload));
    return saved;
  });
  h("keeper:runNow", () => keeper.checkSessions());



  h("browser:open", (id) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    // 只返回轻量结果；BrowserWindow 实例无法跨 IPC 序列化
    browser.openAccountWindow(acc).catch((e) => {
      /* 打开失败已由 browser 内部 emit 事件，不阻塞调用方 */
      console.error("browser:open failed", e);
    });
    return { opened: true };
  });
  h("browser:openExternal", (id) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    browser.openExternal(acc);
    return true;
  });
  h("browser:usageUrl", (id) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    return browser.usageUrl(acc);
  });
  h("browser:openBigmodelUsage", async (id) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    await shell.openExternal("https://www.bigmodel.cn/coding-plan/personal/usage");
    return true;
  });
  h("browser:openDeepseekUsage", async () => {
    // DeepSeek 用量页需要网页登录；本应用只用 API Key，故跳系统浏览器打开官网
    await shell.openExternal("https://platform.deepseek.com/usage");
    return true;
  });
  h("clipboard:write", (text) => {
    clipboard.writeText(String(text == null ? "" : text));
    return true;
  });

  h("sessions:health", (id) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    return sessions.checkHealth(acc, { refresh: true });
  });

  h("quota:refresh", (id) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    return quota.refreshAccount(acc);
  });
  h("quota:refreshAll", () => keeper.refreshAll({ silent: false }));
  h("web:status", () => webServer.status());
  webServer.listen();

  h("apiKeys:set", (id, { name, key }) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    const keys = Array.isArray(acc.apiKeys) ? acc.apiKeys : [];
    const entry = { id: accounts.uid(), name: name || "default", keyEnc: storage.encrypt(key), createdAt: new Date().toISOString() };
    keys.push(entry);
    acc.apiKeys = keys;
    storage.save();
    return keys.map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt }));
  });
  h("apiKeys:list", (id) => {
    const acc = accounts.findLocal(id);
    if (!acc) return [];
    return (acc.apiKeys || []).map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, hasKey: Boolean(k.keyEnc) }));
  });
  h("backup:export", () => backup.exportToFile());
  h("backup:import", (merge) => backup.importFromFile({ merge }));
  h("backup:exportCsv", () => backup.exportCsvToFile());
  h("backup:exportCredentialsCsv", () => backup.exportCredentialsCsvToFile());

  h("apiKeys:remove", (id, keyId) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    acc.apiKeys = (acc.apiKeys || []).filter((k) => k.id !== keyId);
    storage.save();
    return true;
  });
  h("apiKeys:copy", (id, keyId) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    const k = (acc.apiKeys || []).find((x) => x.id === keyId);
    if (!k || !k.keyEnc) throw new Error("Key 不存在");
    const plain = storage.decrypt(k.keyEnc);
    if (!plain) throw new Error("Key 无法解密");
    clipboard.writeText(plain);
    return true;
  });
  h("apiKeys:get", (id, keyId) => {
    const acc = accounts.findLocal(id);
    if (!acc) throw new Error("账号不存在");
    const k = (acc.apiKeys || []).find((x) => x.id === keyId);
    if (!k || !k.keyEnc) throw new Error("Key 不存在");
    const plain = storage.decrypt(k.keyEnc);
    if (!plain) throw new Error("Key 无法解密");
    return plain;
  });
}

module.exports = { init };



