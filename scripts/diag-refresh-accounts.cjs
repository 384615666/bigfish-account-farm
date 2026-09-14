"use strict";
// 临时诊断：逐个调用真实刷新链路，打印失败原因
const { app } = require("electron");
const path = require("node:path");

app.setPath("userData", path.join(app.getPath("appData"), "大肥鱼养殖基地"));

app.whenReady().then(async () => {
  try {
    const storage = require("../src/main/storage.cjs");
    const accounts = require("../src/main/accounts.cjs");
    const quota = require("../src/main/quota.cjs");
    storage.load();
    const results = [];
    for (const acc of accounts.listAll(true)) {
      if (acc.status !== "active") continue;
      const r = await quota.refreshAccount(acc);
      results.push({
        name: acc.displayName,
        platform: acc.platform,
        hasKey: Boolean(acc.apiKeys?.find((k) => k.keyEnc)),
        hasSession: Boolean(acc.session?.cookieEnc),
        ok: r.ok,
        reason: r.reason,
        status: r.status || null,
      });
    }
    console.log("[diag-refresh] " + JSON.stringify(results, null, 2));
  } catch (error) {
    console.error("[diag-refresh] failed:", error);
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});
