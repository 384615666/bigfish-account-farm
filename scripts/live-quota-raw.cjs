"use strict";
const { app } = require("electron");
const path = require("node:path");

app.setPath("userData", path.join(app.getPath("appData"), "大肥鱼养殖基地"));

app.whenReady().then(async () => {
  try {
    const storage = require("../src/main/storage.cjs");
    const accounts = require("../src/main/accounts.cjs");
    const sessions = require("../src/main/sessions.cjs");
    const api = require("../src/main/api.cjs");
    const quota = require("../src/main/quota.cjs");
    storage.load();
    const account = accounts.listAll(true).find((item) => item.session?.cookieEnc);
    if (!account) throw new Error("No usable cookie account");
    const rawSession = sessions.sessionCookie(account);
    const liveResponse = await api.request("/auth/get-session", { cookie: rawSession });
    console.log("[raw-quota] get-session", JSON.stringify({
      status: liveResponse.status,
      contentType: liveResponse.headers.get("content-type"),
      topKeys: Object.keys(liveResponse.json || {}),
      bodyHead: String(liveResponse.text || "").slice(0, 180),
      sessionKeys: Object.keys(liveResponse.json?.session || {}),
      hasToken: Boolean(liveResponse.json?.session?.token),
      user: {
        login: liveResponse.json?.user?.userName,
        email: liveResponse.json?.user?.email,
        id: liveResponse.json?.user?.id,
      },
    }, null, 2));
    const result = await quota.collectByCookie(account);
    const compact = JSON.parse(JSON.stringify(result));
    for (const value of Object.values(compact.detail || {})) {
      if (value.body && typeof value.body === "object") {
        value.bodySummary = {
          keys: Object.keys(value.body),
          body: value.body,
        };
      }
    }
    console.log("[raw-quota] " + JSON.stringify(compact, null, 2));
  } catch (error) {
    console.error("[raw-quota] failed:", error);
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});
