"use strict";
// 离屏渲染 DeepSeek 余额卡片（真实 CSS + 与 App.jsx 输出一致的 DOM 结构），存 docs/images/deepseek-card.png
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.whenReady().then(async () => {
  const cssFile = fs.readdirSync(path.join(__dirname, "..", "dist-renderer", "assets")).find((name) => /^index-.*\.css$/.test(name));
  const css = fs.readFileSync(path.join(__dirname, "..", "dist-renderer", "assets", cssFile), "utf8");

  const head = (name, warn) => `
    <div class="head" style="flex-wrap:wrap">
      <button type="button" class="fav">☆</button>
      <span class="name">${warn ? "⚠️ " : ""}${name}</span>
      <span class="plan">DeepSeek</span>
      <span class="status-pill ok">已同步</span>
    </div>`;

  const balanceCard = (amounts, period, cls) => `
    <div class="card${cls ? " " + cls : ""}">
      ${head("DeepSeek 主力", cls === "warn-card")}
      <div class="metrics">
        <div class="metric">
          <span class="label">账户余额</span>
          <span class="month">
            <span class="amount">${amounts}</span>
            <span class="period">${period}</span>
          </span>
        </div>
      </div>
      <div class="card-meta" style="flex-wrap:wrap;gap:6"><span>上次刷新 14:32</span><span>额度在线</span></div>
      <div class="foot" style="gap:8">
        <button class="btn primary">用量页</button>
        <button class="btn">刷新</button>
        <button class="btn">详情</button>
      </div>
    </div>`;

  const ok = balanceCard("¥88.80", "充值 ¥80.80 · 赠金 ¥8.00", "");
  const multi = balanceCard("¥110.00　$0.50", "充值 ¥100.00 · 赠金 ¥10.00", "");
  const unavailable = balanceCard(
    '<span class="amount warn">¥0.00</span>',
    '<span class="period" style="color:var(--red)">余额不可用（可能已欠费）</span>',
    "warn-card"
  );

  const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${css}
    body{overflow:hidden}.layout{height:100vh}.content{width:100%;padding:18px}.cards{grid-template-columns:repeat(3,1fr)}
  </style></head><body><div class="layout"><div class="body"><div class="content"><div class="cards">
    ${ok}${multi}${unavailable}
  </div></div></div></div></body></html>`;

  const win = new BrowserWindow({
    width: 1240,
    height: 360,
    show: false,
    frame: false,
    backgroundColor: "#0f1115",
    webPreferences: { offscreen: true },
  });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 900));
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.join(__dirname, "..", "docs", "images"), { recursive: true });
  const out = path.join(__dirname, "..", "docs", "images", "deepseek-card.png");
  fs.writeFileSync(out, img.toPNG());
  console.log("saved " + out + " (" + img.getSize().width + "x" + img.getSize().height + ")");
  app.exit(0);
});
