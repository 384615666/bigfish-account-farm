"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.whenReady().then(async () => {
  const cssFile = fs.readdirSync(path.join(__dirname, "..", "dist-renderer", "assets")).find((name) => /^index-.*\.css$/.test(name));
  const css = fs.readFileSync(path.join(__dirname, "..", "dist-renderer", "assets", cssFile), "utf8");
  const card = (name, warn, month, monthPeriod, wPct, wReset, wColor, fPct, fReset, fColor, fetched, channel) => `
    <div class="card${warn ? " warn-card" : ""}">
      <div class="head">
        <button type="button" class="fav">☆</button>
        <span class="name">${warn ? "⚠️ " : ""}${name}</span>
        <span class="plan">未知计划</span>
        <span class="status-pill ok">已登录</span>
      </div>
      <div class="metrics">
        <div class="metric">
          <span class="label">月额度</span>
          <span class="month"><span class="amount${warn ? " warn" : ""}">${month} 剩余</span><span class="period">${monthPeriod}</span></span>
        </div>
        <div class="metric">
          <span class="label">周窗口</span>
          <div class="metric-value">
            <div class="bar"><div style="width:${wPct}%;background:${wColor}"></div></div>
            <div class="meter-side"><span class="pct${warn ? " warn" : ""}">${wPct}%</span><span class="reset">${wReset}后重置</span></div>
          </div>
        </div>
        <div class="metric">
          <span class="label">5小时窗口</span>
          <div class="metric-value">
            <div class="bar"><div style="width:${fPct}%;background:${fColor}"></div></div>
            <div class="meter-side"><span class="pct">${fPct}%</span><span class="reset">${fReset}后重置</span></div>
          </div>
        </div>
      </div>
      <div class="card-meta"><span>上次刷新 ${fetched}</span><span>${channel}</span></div>
      <div class="foot">
        <button class="btn primary">打开</button>
        <button class="btn">刷新</button>
        <button class="btn">详情</button>
      </div>
    </div>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
    body{overflow:hidden}.body{height:100vh}.content{width:100%;padding:18px}.cards{grid-template-columns:repeat(2,1fr)}
  </style></head><body><div class="layout"><div class="body"><div class="content"><div class="cards">
    ${card("LSJ-G", true, "$34.99", "12:40 更新", 100, "113小时12分", "#f0565c", 0, "13小时4分", "#34c98f", "19:30", "额度在线")}
    ${card("liushjupy", false, "$69.35", "15:43 更新", 2, "164小时14分", "#34c98f", 5, "1小时14分", "#34c98f", "19:30", "额度在线")}
  </div></div></div></div></body></html>`;

  const win = new BrowserWindow({
    width: 960,
    height: 320,
    show: false,
    frame: false,
    backgroundColor: "#0f1115",
    webPreferences: { offscreen: true },
  });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await win.capturePage();
  fs.mkdirSync(path.join(__dirname, "..", "docs", "images"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "docs", "images", "card-preview.png"), image.toPNG());
  const rects = await win.webContents.executeJavaScript(`(() => {
    const q = (s) => [...document.querySelectorAll(s)].map((n) => n.getBoundingClientRect().toJSON());
    return { cards: q('.card'), bars: q('.bar'), feet: q('.card .foot'), buttons: q('.card .foot .btn') };
  })()`);
  console.log("[visual-card] " + JSON.stringify(rects, null, 1));
  app.exit(0);
});
