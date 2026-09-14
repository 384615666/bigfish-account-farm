"use strict";
// 系统托盘：关闭窗口时驻留后台 + 托盘菜单（打开主界面 / 全部刷新 / 退出）。
const { app, Tray, Menu, nativeImage, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const keeper = require("./keeper.cjs");

let tray = null;
let getMainWindow = null;

// 托盘图标由 scripts/gen-tray-icons.py 从用户立绘派生（只裁剪 + 缩放，不重绘）。
// 100%→16 / 125%→20 / 150%→24 / 175%→28 / 200%→32，对应 Windows 的 SM_CXSMICON。
const TRAY_DIR = () => path.join(__dirname, "..", "..", "build", "tray");
const TRAY_SIZES = [16, 20, 24, 28, 32, 40, 48];
// 派生图缺失时回落到用户手绘的应用图标：宁可画质差一点，也不要托盘空白。
const FALLBACK_ICON = () => path.join(__dirname, "..", "..", "build", "icon.png");

function trayIconSize() {
  const display = screen.getPrimaryDisplay();
  const want = Math.round(16 * ((display && display.scaleFactor) || 1));
  return TRAY_SIZES.find((s) => s >= want) || TRAY_SIZES[TRAY_SIZES.length - 1];
}

function iconFor(size) {
  const derived = path.join(TRAY_DIR(), `tray-${size}.png`);
  const img = nativeImage.createFromPath(fs.existsSync(derived) ? derived : FALLBACK_ICON());
  if (img.isEmpty()) return img;
  if (img.getSize().width === size) return img;
  return img.resize({ width: size, height: size });
}

function applyTrayIcon() {
  if (!tray || tray.isDestroyed()) return;
  const img = iconFor(trayIconSize());
  if (!img.isEmpty()) tray.setImage(img);
}

function showMain() {
  const w = getMainWindow && getMainWindow();
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function refreshMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开主界面", click: () => showMain() },
    { label: "全部刷新额度", click: () => { keeper.refreshAll({ silent: true }); } },
    { type: "separator" },
    {
      label: "退出（停止后台保活）",
      click: () => {
        app.quit();
      },
    },
  ]));
}

function init(mwGetter) {
  getMainWindow = mwGetter;
  const img = iconFor(trayIconSize());
  if (img.isEmpty()) return null;
  tray = new Tray(img);
  tray.setToolTip("大肥鱼养殖基地");
  tray.on("click", () => showMain());
  refreshMenu();
  // 缩放比或显示器变化后要换成新尺寸的原生图，否则会被系统拉伸变糊。
  screen.on("display-metrics-changed", applyTrayIcon);
  screen.on("display-added", applyTrayIcon);
  screen.on("display-removed", applyTrayIcon);
  return tray;
}

function dispose() {
  screen.removeListener("display-metrics-changed", applyTrayIcon);
  screen.removeListener("display-added", applyTrayIcon);
  screen.removeListener("display-removed", applyTrayIcon);
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { init, showMain, refreshMenu, dispose, iconFor, trayIconSize };
