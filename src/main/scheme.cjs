"use strict";
// URL Scheme（ccam://add?cookie=...）：从浏览器一键把已登录账号发给本软件。
// 浏览器书签小工具把 commandcode.ai 的会话 Cookie 经本机协议跳转传入，
// 主进程解码出登录名/邮箱后暂存为"待添加"，渲染层确认后落库（Cookie 加密保存）。
// 安全提示：Cookie 只在本机协议 URL 中传递，应用侧不写明文日志、不暴露给渲染进程。
const { app } = require("electron");
const sessions = require("./sessions.cjs");

const SCHEME = "ccam";
let pendingAdd = null; // { cookie, login, email, expiresAt, at }

// 从进程参数里找第一个本协议 URL（第二实例 / 冷启动都可能携带）
function findUrl(argv = []) {
  for (const a of argv) {
    if (typeof a === "string" && a.trim().toLowerCase().startsWith(SCHEME + "://")) return a.trim();
  }
  return null;
}

// 解析 ccam://add?cookie=...；非法/缺 Cookie 返回 null
function parseUrl(url) {
  try {
    if (!url || typeof url !== "string") return null;
    const u = new URL(url);
    if (u.protocol !== SCHEME + ":") return null;
    if (u.hostname !== "add" && u.pathname !== "/add") return null;
    const cookie = sessions.canonicalizeSessionCookie((u.searchParams.get("cookie") || "").trim());
    if (!cookie || !/session_token|session_data/i.test(cookie)) return null;
    return {
      cookie,
      login: (u.searchParams.get("login") || "").trim() || null,
      email: (u.searchParams.get("email") || "").trim() || null,
      expiresAt: (u.searchParams.get("expiresAt") || "").trim() || null,
    };
  } catch {
    return null;
  }
}

// 打包版注册协议处理程序；开发模式不注册（避免把 electron.exe 注册成处理程序）
function register() {
  if (!app.isPackaged) return false;
  try {
    return app.setAsDefaultProtocolClient(SCHEME);
  } catch {
    return false;
  }
}

// 由 raw Cookie 解码出可供渲染层展示的账号元信息（不含 Cookie 本体）
function describeRawCookie(cookie) {
  return {
    login: sessions.loginFromCookie(cookie) || null,
    email: sessions.emailFromCookie(cookie) || null,
    expiresAt: sessions.decodeSessionExpiry(cookie) || null,
  };
}

function setPending(parsed) {
  if (!parsed || !parsed.cookie) return null;
  const described = describeRawCookie(parsed.cookie);
  const info = {
    ...described,
    login: parsed.login || described.login,
    email: parsed.email || described.email,
    expiresAt: parsed.expiresAt || described.expiresAt,
  };
  if (!info.login && !info.email) return null; // 解不出身份，视为无效
  pendingAdd = { cookie: parsed.cookie, ...info, at: new Date().toISOString() };
  return pendingAdd;
}

function getPending() {
  return pendingAdd;
}

// 给渲染层看的公开信息（绝不包含 Cookie 明文）
function pendingInfo() {
  if (!pendingAdd) return null;
  return {
    login: pendingAdd.login,
    email: pendingAdd.email,
    expiresAt: pendingAdd.expiresAt,
    at: pendingAdd.at,
  };
}

function clearPending() {
  pendingAdd = null;
}

module.exports = { SCHEME, findUrl, parseUrl, register, describeRawCookie, setPending, getPending, pendingInfo, clearPending };
