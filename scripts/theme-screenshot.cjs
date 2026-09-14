"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { app, BrowserWindow } = require("electron");
const ipc = require("../src/main/ipc.cjs");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "bigfish-theme-")));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "main", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"));
  ipc.init(win);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme = 'dark'; undefined");
  await new Promise((resolve) => setTimeout(resolve, 350));
  fs.writeFileSync(path.join(__dirname, "..", "docs", "images", "theme-dark.png"), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme = 'light'; undefined");
  await new Promise((resolve) => setTimeout(resolve, 350));
  fs.writeFileSync(path.join(__dirname, "..", "docs", "images", "theme-light.png"), (await win.webContents.capturePage()).toPNG());
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
