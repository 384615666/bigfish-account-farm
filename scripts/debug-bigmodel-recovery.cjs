"use strict";
const path = require("node:path");
const { app } = require("electron");

app.setPath("userData", path.join(app.getPath("appData"), "大肥鱼养殖基地"));

app.whenReady().then(async () => {
  try {
    const recovery = require("../src/main/bigmodel-recovery.cjs");
    console.log("[debug-recovery]", JSON.stringify(await recovery.recoverDrafts({ cleanup: false }), null, 2));
  } catch (error) {
    console.error("[debug-recovery] FAILED", error);
    app.exitCode = 1;
  } finally {
    app.exit(app.exitCode || 0);
  }
});
