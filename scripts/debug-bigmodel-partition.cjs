"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { app, session } = require("electron");
const bigmodel = require("../src/main/bigmodel.cjs");

app.setPath("userData", process.env.CC_DEBUG_USERDATA || app.getPath("userData"));

app.whenReady().then(async () => {
  try {
    const root = path.join(app.getPath("userData"), "Partitions");
    const dirs = fs.existsSync(root)
      ? fs.readdirSync(root).filter((name) => name.startsWith("cc-acct-bigmodel-draft-"))
      : [];
    for (const name of dirs) {
      const partition = "persist:" + name;
      const cookies = await session.fromPartition(partition).cookies.get({ url: bigmodel.BASE });
      const cookie = cookies.find((item) => item.name === "bigmodel_token_production");
      if (!cookie) continue;
      const response = await bigmodel.request("/monitor/usage/quota/limit", {
        token: decodeURIComponent(cookie.value),
      });
      console.log(JSON.stringify({
        partition,
        status: response.status,
        body: response.json,
        textPreview: response.json ? null : response.text.slice(0, 500),
      }, null, 2));
    }
  } catch (error) {
    console.error(error);
    app.exitCode = 1;
  } finally {
    app.exit(app.exitCode || 0);
  }
});
