"use strict";
// 复现登录窗口渲染问题：创建同参数登录窗口加载 commandcode.ai/signin，
// 检查页面到底是正常渲染成登录表单，还是把 HTML 当纯文本显示（文字界面）。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e && e.code === "EPIPE") return;
    throw e;
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-authchk-"));
app.setPath("userData", tmp);
app.commandLine.appendSwitch("disable-features", "AutoDarkMode");

app.whenReady().then(async () => {
  const partition = "persist:cc-authchk-" + Date.now();
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    show: false,
    webPreferences: { partition, contextIsolation: true, sandbox: true },
  });
  const url = "https://commandcode.ai/signin?returnTo=" + encodeURIComponent("/settings/usage");
  let events = [];
  win.webContents.on("did-fail-load", (_e, code, desc) => events.push("fail:" + code + ":" + desc));
  win.webContents.on("did-finish-load", () => events.push("finish"));
  win.webContents.session.webRequest.onCompleted((details) => {
    if (details.resourceType === "stylesheet" || details.resourceType === "script" || details.resourceType === "xhr" || details.resourceType === "mainFrame") {
      console.log("[authchk] res " + details.statusCode + " " + details.resourceType + " " + details.url.slice(0, 120));
    }
  });
  win.webContents.session.webRequest.onErrorOccurred((details) => {
    console.log("[authchk] ERR " + details.error + " " + details.resourceType + " " + details.url.slice(0, 120));
  });
  try {
    await win.loadURL(url);
  } catch (e) {
    console.log("[authchk] loadURL error: " + String((e && e.message) || e));
  }
  await new Promise((r) => setTimeout(r, 4000));
  const info = await win.webContents
    .executeJavaScript(`(() => {
      const body = document.body;
      const text = body ? (body.innerText || "").slice(0, 400) : "";
      const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).slice(0, 8);
      return {
        contentType: document.contentType,
        title: document.title,
        hasDoctypeText: (body && (body.innerHTML || "").slice(0, 200).includes("<") && !(body.childElementCount > 0)) || false,
        childElementCount: body ? body.childElementCount : -1,
        text,
        buttons,
      };
    })()`)
    .catch((e) => ({ evalError: String(e) }));
  console.log("[authchk] url=" + win.webContents.getURL());
  console.log("[authchk] events=" + JSON.stringify(events));
  console.log("[authchk] info=" + JSON.stringify(info, null, 1));
  app.exit(0);
});
