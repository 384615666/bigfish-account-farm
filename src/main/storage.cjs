"use strict";
// 加密 JSON 存储。敏感字段（会话Cookie、API Key）用 Electron safeStorage 加密后以 base64 存 *_enc 后缀字段。
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const FILE = () => path.join(app.getPath("userData"), "data.json");
const TMP = () => FILE() + ".tmp";

let cache = null; // { version, accounts, groups, settings }

function defaultData() {
  return { version: 1, accounts: [], groups: [], settings: {} };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE(), "utf8");
    const parsed = JSON.parse(raw);
    cache = Object.assign(defaultData(), parsed);
  } catch {
    cache = defaultData();
  }
  if (!Array.isArray(cache.accounts)) cache.accounts = [];
  if (!Array.isArray(cache.groups)) cache.groups = [];
  if (!cache.settings || typeof cache.settings !== "object") cache.settings = {};
  return cache;
}

function save() {
  const data = load();
  // 原子写：先写临时文件再重命名
  fs.writeFileSync(TMP(), JSON.stringify(data, null, 1), "utf8");
  fs.renameSync(TMP(), FILE());
}

function encrypt(plain) {
  if (plain === undefined || plain === null) return null;
  if (!safeStorage.isEncryptionAvailable()) return Buffer.from(String(plain), "utf8").toString("base64");
  return safeStorage.encryptString(String(plain)).toString("base64");
}

function decrypt(b64) {
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function get(prop) {
  return load()[prop];
}
function set(prop, value) {
  load()[prop] = value;
  save();
  return value;
}
function getSettings() {
  return load().settings;
}
function updateSettings(patch) {
  Object.assign(load().settings, patch);
  save();
  return load().settings;
}
function reset() {
  cache = defaultData();
  save();
}

module.exports = { load, save, encrypt, decrypt, get, set, getSettings, updateSettings, reset };
