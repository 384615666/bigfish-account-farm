"use strict";
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error && error.code === "EPIPE") return;
    throw error;
  });
}

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "cc-turnstile-")));
app.commandLine.appendSwitch(
  "host-resolver-rules",
  "MAP brunhild.challenges.cloudflare.com 104.18.95.41"
);

app.whenReady().then(async () => {
  const partition = "persist:cc-turnstile-" + Date.now();
  const authSession = session.fromPartition(partition);
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
  const proxyUrl = process.argv.includes("--proxy")
    ? (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)
    : "";
  if (authSession) {
    if (proxyUrl) {
      const rules = proxyUrl.replace(/^https?:\/\//, "");
      await authSession.setProxy({ mode: "fixed_servers", proxyRules: "http=" + rules + ";https=" + rules });
      console.log("[turnstile-check] proxy", proxyUrl);
    } else {
      await authSession.setProxy({ mode: "direct" });
      console.log("[turnstile-check] network direct");
    }
    authSession.setUserAgent(userAgent);
  }
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    show: false,
    webPreferences: { partition, contextIsolation: true, sandbox: true },
  });
  const contents = win.webContents;

  contents.on("console-message", (_event, level, message, line, source) => {
    if (/cloudflare|turnstile|challenge|error|warning/i.test(message + source)) {
      console.log("[turnstile-check] console", JSON.stringify({ level, source, line, message }));
    }
  });
  contents.on("did-fail-load", (_event, code, description) => {
    console.log("[turnstile-check] navigation-fail", JSON.stringify({ code, description }));
  });
  contents.session.webRequest.onCompleted((details) => {
    if (/challenges\.cloudflare\.com|commandcode\.ai/.test(details.url)) {
      console.log("[turnstile-check] request", JSON.stringify({
        status: details.statusCode,
        type: details.resourceType,
        url: details.url.slice(0, 180),
      }));
    }
  });
  contents.session.webRequest.onErrorOccurred((details) => {
    if (/challenges\.cloudflare\.com|commandcode\.ai/.test(details.url)) {
      console.log("[turnstile-check] request-error", JSON.stringify({
        error: details.error,
        type: details.resourceType,
        url: details.url.slice(0, 180),
      }));
    }
  });

  try {
    await win.loadURL("https://commandcode.ai/signin?returnTo=" + encodeURIComponent("/settings/usage"));
  } catch (error) {
    console.log("[turnstile-check] load-error", String(error?.message || error));
  }

  await new Promise((resolve) => setTimeout(resolve, 12000));
  const state = await contents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll('div[id^="cf-chl"], iframe[src*="challenges.cloudflare.com"]')];
    return {
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      languages: navigator.languages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      title: document.title,
      hasTurnstileApi: Boolean(window.turnstile),
      nodes: nodes.map((node) => ({
        tag: node.tagName,
        id: node.id || null,
        src: node.src || null,
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
      })),
      text: document.body?.innerText?.slice(0, 600) || "",
    };
  })()`).catch((error) => ({ evaluationError: String(error?.message || error) }));
  console.log("[turnstile-check] state", JSON.stringify(state, null, 1));
  app.exit(0);
});
