"use strict";
// Electron 主入口
const { app, BrowserWindow, Menu, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const storage = require("./storage.cjs");
const accounts = require("./accounts.cjs");
const sessions = require("./sessions.cjs");
const ipc = require("./ipc.cjs");
const tray = require("./tray.cjs");
const backup = require("./backup.cjs");
const scheme = require("./scheme.cjs");
const bigmodelRecovery = require("./bigmodel-recovery.cjs");

if (process.env.CC_DEBUG_USERDATA) app.setPath("userData", process.env.CC_DEBUG_USERDATA);
else if (!app.getPath("userData").includes("大肥鱼养殖基地")) {
  app.setPath("userData", path.join(app.getPath("appData"), "大肥鱼养殖基地"));
  const legacy = path.join(app.getPath("appData"), "CC账号管家");
  if (fs.existsSync(legacy) && !fs.existsSync(app.getPath("userData"))) {
    fs.renameSync(legacy, app.getPath("userData"));
  }
}

// 终端提前关闭（如管道被断开）时 console.log 会抛 EPIPE，Electron 会弹
// "主进程未捕获异常"对话框。静默吞掉 EPIPE，其余写错误照常暴露。
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e && e.code === "EPIPE") return;
    throw e;
  });
}

const SMOKE = process.argv.includes("--smoke");
const LIVE = process.argv.includes("--livecheck");

// 产品化窗口：移除 Electron 默认应用菜单。避免用户误触 Reload / DevTools /
// View Source 等开发入口，导致登录页被打开成源码文本或整页刷新丢会话。
Menu.setApplicationMenu(null);
let mainWindow = null;
let quitting = false;

// 单实例：重复启动时聚焦已有窗口而不是再开一个进程，
// 避免两个进程同时读写 data.json 造成数据丢失/损坏。
// 自检/冒烟/线上验证模式不抢占锁（它们用独立 userData 或需要并行运行）。
const gotLock = SMOKE || LIVE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
app.on("second-instance", (_e, argv) => {
    handleSchemeUrl(argv);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 禁掉 Chromium 的 Ctrl+U 源码模式快捷键；导航层另有 view-source 自动纠正兜底。
app.on("web-contents-created", (_event, contents) => {
  contents.on("before-input-event", (inputEvent, input) => {
    if (
      input.type === "keyDown" &&
      input.control &&
      !input.alt &&
      !input.shift &&
      String(input.key || "").toLowerCase() === "u"
    ) {
      inputEvent.preventDefault();
    }
  });
});

// 收到 ccam://add?cookie=...：暂存待添加账号并通知渲染层弹确认框
function handleSchemeUrl(argv) {
  const url = scheme.findUrl(argv || []);
  if (!url) return;
  const parsed = scheme.parseUrl(url);
  if (!parsed) return;
  const pending = scheme.setPending(parsed);
  if (!pending) return;
  console.log("[scheme] pending add: login=" + (pending.login || "-") + " email=" + (pending.email || "-"));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: "大肥鱼养殖基地",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要 require
    },
  });
  // 关闭窗口时：若开启"最小化到托盘"，则隐藏而不是退出（托盘菜单可退出）
  mainWindow.on("close", (e) => {
    const s = storage.getSettings();
    if (!quitting && !SMOKE && s.closeToTray !== false) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => (mainWindow = null));

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "..", "dist-renderer", "index.html"));
  }
  return mainWindow;
}

app.whenReady().then(() => {
  if (!gotLock) return; // 已有实例在运行，本就应退出
  storage.load(); // 预热数据
  sessions.repairStoredCookieNames();
  scheme.register(); // 注册 ccam:// 协议（打包版），浏览器书签可直接唤起
  // 隐藏自检：electron . --livecheck —— 用应用本体（同一可执行文件身份）解密本地会话，
  // 调 get-session 验证会话可用、登录名与本地 accountId 一致、存量 UUID 修复链路
  if (LIVE) {
    (async () => {
      const sessions = require("./sessions.cjs");
      const accounts = require("./accounts.cjs");
      const quota = require("./quota.cjs");
      const scratch = "persist:cc-livecheck";
      const results = [];
      for (const acc of accounts.listAll(true)) {
        if (!acc.session || !acc.session.cookieEnc) continue;
        if (!sessions.sessionUsable(acc)) {
          results.push({ id: acc.id, accountId: acc.accountId, name: acc.displayName, usable: false });
          continue;
        }
        const raw = sessions.sessionCookie(acc);
        const offlineLogin = sessions.loginFromCookie(raw);
        try {
          await session.fromPartition(scratch).clearStorageData();
          await sessions.injectCookies(scratch, raw);
          const cap = await sessions.captureSession(scratch, { timeoutMs: 15000 });
          // 用同一会话走真实额度采集链路（/internal/ 接口组），验证月/周/5h 数据可拉取
          let quotaResult = null;
          if (cap.ok) {
            try {
              const mock = { ...acc, session: { ...acc.session, cookieEnc: storage.encrypt(cap.cookieHeader) } };
              const col = await quota.collectByCookie(mock);
              quotaResult = col.ok
                ? {
                    ok: true,
                    month: col.snapshot?.month?.remaining ?? null,
                    week: col.snapshot?.weekly ? { used: col.snapshot.weekly.used, cap: col.snapshot.weekly.cap } : null,
                    fiveHour: col.snapshot?.fiveHour ? { used: col.snapshot.fiveHour.used, cap: col.snapshot.fiveHour.cap } : null,
                  }
                : { ok: false, reason: col.reason || null };
            } catch (e) {
              quotaResult = { ok: false, error: String(e) };
            }
          }
          results.push({
            id: acc.id,
            accountId: acc.accountId,
            name: acc.displayName,
            usable: true,
            ok: cap.ok,
            reason: cap.reason || null,
            username: cap.username || null,
            userId: cap.userId || null,
            email: cap.email || null,
            offlineLogin,
            accountIdMatches: cap.ok ? cap.username === acc.accountId : null,
            quota: quotaResult,
          });
        } catch (e) {
          results.push({ id: acc.id, accountId: acc.accountId, name: acc.displayName, usable: true, error: String(e) });
        }
      }
      console.log("[livecheck] " + JSON.stringify(results, null, 1));
      app.exit(0);
    })();
    return;
  }
  createMainWindow();
  // 启动后异步修复存量错误账号 ID（早期版本把用户 UUID 当登录名存，
  // 导致 usage 链接 404）。只处理"明显错误"的账号，避免无关网络请求。
  (async () => {
    if (!SMOKE) {
      try {
        const recovered = await bigmodelRecovery.recoverDrafts();
        if (recovered.recovered > 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("cc:event", { type: "accounts:changed" });
        }
      } catch {
        /* 恢复失败不影响主界面 */
      }
    }
    try {
      for (const acc of accounts.listAll(true)) {
        if (!acc.session || !acc.session.cookieEnc) continue;
        if (!sessions.sessionUsable(acc)) {
          // 本地密钥轮换：存量 Cookie 无法解密 → 标记「需重新登录」，重登后自动修复 ID
          if (acc.session.state !== "broken") {
            accounts.setSession(acc.id, { ...acc.session, state: "broken", updatedAt: new Date().toISOString() });
          }
          continue;
        }
        await sessions.healAccountIdentity(acc, { onlyIfWrong: true });
      }
    } catch {
      /* 修复失败不影响启动 */
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cc:event", { type: "accounts:changed" });
    }
  })();
  if (!SMOKE) {
    tray.init(() => mainWindow);
    // 每日自动备份（启动时检查 + 每 6 小时补查）
    const autoBackupOnce = () => {
      try {
        if (!backup.hasBackupToday()) backup.autoBackup();
      } catch {
        /* 备份失败不影响启动 */
      }
    };
    autoBackupOnce();
    setInterval(autoBackupOnce, 6 * 3600 * 1000);
    // 开机自启（若设置开启）
    if (process.platform === "win32" && storage.getSettings().autoLaunch) {
      app.setLoginItemSettings({ openAtLogin: true });
    }
  }
  ipc.init(mainWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  if (SMOKE) {
    console.log("[smoke] main process started");
    mainWindow.webContents.once("did-finish-load", () => {
      console.log("[smoke] renderer loaded");
      setTimeout(async () => {
        try {
          const n = await mainWindow.webContents.executeJavaScript(
            "document.getElementById('root').childElementCount"
          );
          console.log("[smoke] react mounted, root children = " + n);
          if (n >= 1) {
            console.log("[smoke] SMOKE_OK");
            app.exit(0);
          } else {
            console.log("[smoke] SMOKE_FAIL: root is empty");
            app.exit(1);
          }
        } catch (e) {
          console.log("[smoke] SMOKE_FAIL: " + String(e));
          app.exit(1);
        }
      }, 1800);
    });
    setTimeout(() => {
      console.log("[smoke] renderer load timeout");
      app.exit(1);
    }, 30000);
  }
  // 冷启动即携带 ccam:// URL（浏览器在软件未运行时点击书签）
  handleSchemeUrl(process.argv);
});

app.on("window-all-closed", () => {
  // 设置「关闭=直接退出」时，点 X 关掉最后一个窗口应真正退出；
  // 否则经过 before-quit（托盘退出）也应退出。macOS 惯例保留 Dock 驻留。
  if (process.platform !== "darwin" && (quitting || storage.getSettings().closeToTray === false)) app.quit();
});

app.on("before-quit", () => {
  quitting = true;
});

