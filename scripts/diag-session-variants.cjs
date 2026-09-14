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
    storage.load();
    const allAccounts = accounts.listAll(true).filter((item) => item.session?.cookieEnc);
    if (!allAccounts.length) throw new Error("no cookie account");
    console.log("[diag-session] accounts " + JSON.stringify(allAccounts.map((account) => ({
      id: account.id,
      accountId: account.accountId,
      email: account.email,
      updatedAt: account.session?.updatedAt || null,
    }))));

    const selectedName = process.env.DIAG_LOGIN;
    const account = allAccounts.find((item) => !selectedName || item.accountId === selectedName);
    if (!account) throw new Error("selected account not found");
    const fullCookie = sessions.sessionCookie(account);
    const pairs = String(fullCookie || "").split(";").map((item) => item.trim()).filter(Boolean);
    const findPair = (suffix) => pairs.find((pair) => new RegExp("\\." + suffix + "=", "i").test(pair));
    const tokenPair = findPair("session_token");
    const dataPair = findPair("session_data");
    console.log("[diag-session] cookiePairs " + JSON.stringify(pairs.map((pair) => ({
      name: pair.slice(0, pair.indexOf("=")),
      length: pair.length,
      encoded: /%[0-9a-f]{2}/i.test(pair),
    }))));
    if (!tokenPair) throw new Error("missing token cookie");
    const tokenValue = decodeURIComponent(tokenPair.slice(tokenPair.indexOf("=") + 1));
    const gsResponse = await api.request("/auth/get-session", { cookie: fullCookie });
    const gs = gsResponse.json;
    if (!gs && !dataPair) throw new Error("get-session failed without fallback data");
    const fallbackData = {
      session: { session: gs?.session || {}, user: gs?.user || {} },
      expiresAt: gs?.session?.expiresAt,
      signature: "ccam-browser-import",
    };
    const syntheticData = Buffer.from(JSON.stringify({
      ...fallbackData,
      expiresAt: fallbackData.expiresAt || Date.now() + 864e5,
      signature: "ccam-browser-import",
    })).toString("base64");

    const variants = [
      ["stored", fullCookie],
      ["canonical-token-only", "__Secure-commandcode_prod_.session_token=" + encodeURIComponent(tokenValue)],
      ...(dataPair ? [["real-token-real-data", tokenPair + "; " + dataPair]] : []),
      ["canonical-real-token-canonical-stored-data", "__Secure-commandcode_prod_.session_token=" + encodeURIComponent(tokenValue) +
        "; _Secure-commandcode_prod.session_data=" + syntheticData],
      ["synthetic-bookmark", "_Secure-commandcode_prod.session_token=" + encodeURIComponent(tokenValue) +
        "; _Secure-commandcode_prod.session_data=" + syntheticData + "; login=probe; email=probe@example.com"],
    ];
    for (const [name, cookie] of variants) {
      const auth = await api.request("/auth/get-session", { cookie });
      const usage = await api.request("/internal/usage", { cookie });
      console.log("[diag-session] " + JSON.stringify({
        name,
        cookieLength: cookie.length,
        authStatus: auth.status,
        contentType: auth.headers.get("content-type"),
        hasToken: Boolean(auth.json?.session?.token),
        login: auth.json?.user?.userName || null,
        usageStatus: usage.status,
        usageBodyHead: String(usage.text || "").slice(0, 220),
      }));
    }
  } catch (error) {
    console.error("[diag-session] failed:", error);
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});
