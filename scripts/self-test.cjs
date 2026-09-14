// 自测：electron scripts/self-test.cjs
// 用临时 userData 跑真实模块（不污染正式数据）：批量导入解析/查重/合并/API Key、托盘图标加载。
"use strict";
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 终端提前关闭（如管道被断开）时，console.log 会抛 EPIPE，静默吞掉避免弹错误框。
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e && e.code === "EPIPE") return; // 吞掉，不中断自测
    throw e; // 其他写错误照常暴露
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-selftest-"));
app.setPath("userData", tmp);

let failures = [];
function check(name, cond, detail) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  -> " + detail));
  if (!cond) failures.push(name);
}

app.whenReady().then(async () => {
  const storage = require("../src/main/storage.cjs");
  const accounts = require("../src/main/accounts.cjs");
  storage.load();

  // 1) CSV（中文表头）
  let r = accounts.importPlain("账号ID,邮箱,名称,分组\n10000001,a@b.com,主力号,生产\n777,a2@b.com,备用号,\n");
  check("CSV 中文表头新增2个", r.added === 2 && r.errors.length === 0, JSON.stringify(r));

  // 2) TSV 粘贴（Excel 复制），英文表头
  r = accounts.importPlain("account_id\temail\tname\n555\tt@t.com\t测试X\n");
  check("TSV 英文表头新增1个", r.added === 1, JSON.stringify(r));

  // 3) 重复：不合并时跳过
  r = accounts.importPlain("账号ID,名称\n10000001,重复行\n");
  check("重复行默认跳过", r.added === 0 && r.skipped === 1, JSON.stringify(r));

  // 4) 重复：合并补全备注/API Key
  r = accounts.importPlain("账号ID,备注,密钥\n10000001,这是备注,sk-test-123\n", { merge: true });
  check("重复行合并补全", r.merged === 1 && r.skipped === 0, JSON.stringify(r));
  const accA = accounts.findPublic("x") || accounts.list().find((a) => a.accountId === "10000001");
  check("合并后备注已写入", accA && accA.note === "这是备注", JSON.stringify(accA));
  check("合并后 Key 已加密保存", accA && accA.apiKeys.length === 1 && accA.apiKeys[0].hasKey === true && !("keyEnc" in accA.apiKeys[0]), JSON.stringify(accA && accA.apiKeys));

  // 5) 新增行带 API Key
  r = accounts.importPlain("账号ID,API Key\n9999,sk-new-9\n");
  const accB = accounts.list().find((a) => a.accountId === "9999");
  check("带 Key 的新增行", r.added === 1 && accB && accB.apiKeys[0].hasKey === true && !("keyEnc" in accB.apiKeys[0]), JSON.stringify(r));

  // 5b) 智谱平台导入与凭据隔离保存
  const bigmodel = require("../src/main/bigmodel.cjs");
  const limits = [
    { unit: 3, type: "TOKENS_LIMIT", currentValue: 70, limit: 100, percentage: 70, nextResetTime: "2026-08-27T12:00:00Z" },
    { unit: 6, type: "TOKENS_LIMIT", currentValue: 20, limit: 80, percentage: 25, nextResetTime: "2026-08-31T00:00:00Z" },
    { unit: 5, type: "CREDIT_LIMIT", currentValue: 9, limit: 10, percentage: 90, nextResetTime: "2026-09-30T00:00:00Z" },
  ];
  const normalized = bigmodel.normalizeSnapshot({ status: 200, json: { success: true, data: { limits, level: "GLM-Plan" } } }, {});
  check(
    "智谱额度归一化三档",
    normalized.ok && normalized.snapshot.fiveHour.used === 70 && normalized.snapshot.weekly.cap === 80 &&
      normalized.snapshot.mcp.remaining === 1 && normalized.snapshot.level === "GLM-Plan",
    JSON.stringify(normalized)
  );
  const creditLimits = [
    { unit: 3, type: "CREDIT_LIMIT", currentValue: 3446, usage: 12000, percentage: 28.7167 },
    { unit: 6, type: "CREDIT_LIMIT", currentValue: 3446, usage: 60000, percentage: 5.7433 },
  ];
  const creditNormalized = bigmodel.normalizeSnapshot({ status: 200, json: { success: true, data: { limits: creditLimits, version: "V3" } } }, {});
  check(
    "智谱 V3 积分额度归一化",
    creditNormalized.snapshot.fiveHour.used === 3446 && creditNormalized.snapshot.fiveHour.cap === 12000 &&
      creditNormalized.snapshot.weekly.used === 3446 && creditNormalized.snapshot.weekly.cap === 60000,
    JSON.stringify(creditNormalized.snapshot)
  );
  const invalid = bigmodel.normalizeSnapshot({ status: 401, json: null }, {});
  check("智谱令牌失效识别", !invalid.ok && invalid.reason === "invalid_token", JSON.stringify(invalid));
  r = accounts.importPlain([
    "名称,平台,登录方式,登录账号,密码,智谱登录令牌,智谱API Key",
    "智谱主力,bigmodel,email,zhipu@test.com,secret-pass,bm-token,bm-key"
  ].join("\n"));
  const importedAccounts = accounts.list().map((a) => ({ id: a.id, name: a.displayName, platform: a.platform }));
  const bmAcc = importedAccounts.find((a) => a.platform === "bigmodel");
  const bmPublic = accounts.findPublic(bmAcc.id);
  const bmLocal = accounts.findLocal(bmAcc.id);
  check(
    "智谱 CSV 新增并隐藏凭据",
    r.added === 1 && bmPublic && bmPublic.hasPassword === true && !("passwordEnc" in bmPublic) &&
      storage.decrypt(bmLocal.bigmodelCredentials.tokenEnc) === "bm-token",
    JSON.stringify({ result: r, public: bmPublic, allAccounts: importedAccounts })
  );

  // 5c) DeepSeek 平台导入（无账号ID/邮箱，仅名称+Key）与余额归一化
  const deepseek = require("../src/main/deepseek.cjs");
  const dsNormalized = deepseek.normalizeSnapshot({
    status: 200,
    json: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "88.80", granted_balance: "8", topped_up_balance: "80.80" }] },
  });
  check(
    "DeepSeek 余额归一化",
    dsNormalized.ok && dsNormalized.snapshot.primary.currency === "CNY" && dsNormalized.snapshot.primary.total === 88.8 &&
      dsNormalized.snapshot.isAvailable === true && dsNormalized.snapshot.platform === "deepseek",
    JSON.stringify(dsNormalized.snapshot && dsNormalized.snapshot.primary)
  );
  const dsInvalid = deepseek.normalizeSnapshot({ status: 401, json: { error: {} } });
  check("DeepSeek 401 → invalid_key", !dsInvalid.ok && dsInvalid.reason === "invalid_key", JSON.stringify(dsInvalid));
  r = accounts.importPlain(["名称,平台,API Key", "DeepSeek 主力,deepseek,sk-ds-test-1"].join("\n"));
  const dsAcc = accounts.list().find((a) => a.platform === "deepseek");
  check(
    "DeepSeek CSV 新增并加密 Key",
    r.added === 1 && dsAcc && dsAcc.displayName === "DeepSeek 主力" && dsAcc.apiKeys[0].hasKey === true &&
      !("keyEnc" in dsAcc.apiKeys[0]) && !("passwordEnc" in dsAcc),
    JSON.stringify({ result: r, public: dsAcc })
  );
  // 同平台同名行不重复导入
  r = accounts.importPlain(["名称,平台,API Key", "DeepSeek 主力,deepseek,sk-ds-test-2"].join("\n"));
  check("DeepSeek 同名去重跳过", r.added === 0 && r.skipped === 1, JSON.stringify(r));

  // 6) 坏表头
  r = accounts.importPlain("foo,bar\n1,2\n");
  check("坏表头报错", r.errors.length === 1 && String(r.errors[0]).includes("账号ID"), JSON.stringify(r));

  // 7) 半角分号/无表头容错
  r = accounts.importPlain("姓名,邮箱\n张三,abc@x.com\n");
  check("邮箱列也能导入", r.added === 1, JSON.stringify(r));

  // 7b) 文本文件编码识别：GBK / UTF-8 BOM / UTF-16（中文 Excel 导出的常见编码）
  const { decodeText } = require("../src/main/encoding.cjs");
  // 「账号ID,名称」+ ID +「,主力号」的静态 GBK 字节（Python gbk 编码实测）
  const gbkBuf = Buffer.from(
    "d5cbbac549442cc3fbb3c60a31303030303030312cd6f7c1a6bac50a",
    "hex"
  );
  check("GBK 文件解码不乱码", decodeText(gbkBuf).includes("主力号") && decodeText(gbkBuf).includes("账号ID"), decodeText(gbkBuf));
  const utf8BomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("账号ID,邮箱\n7,a@b.com\n", "utf8")]);
  const bomText = decodeText(utf8BomBuf);
  check("UTF-8 BOM 解码并去 BOM", bomText.startsWith("账号ID"), JSON.stringify(bomText.slice(0, 10)));
  const utf16Buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("账号ID,名称\n8,双字节号\n", "utf16le")]);
  const utf16Text = decodeText(utf16Buf);
  check("UTF-16LE 解码", utf16Text.includes("双字节号"), JSON.stringify(utf16Text.slice(0, 30)));
  check("普通 UTF-8 直接解码", decodeText(Buffer.from("账号ID\n9\n", "utf8")).includes("账号ID"), "utf8 plain");

  // 8) 托盘图标可加载（文件存在且非空、可 resize）
  const { iconFor, trayIconSize } = require("../src/main/tray.cjs");
  const img = iconFor(32);
  check("托盘图标加载", !img.isEmpty() && img.getSize().width === 32, JSON.stringify(img.getSize()));
  const dpiSize = trayIconSize();
  check("托盘按缩放比取原生尺寸", [16, 20, 24, 28, 32, 40, 48].includes(dpiSize), "size=" + dpiSize);
  check("托盘原生尺寸图按目标尺寸加载", iconFor(dpiSize).getSize().width === dpiSize, "size=" + dpiSize);

  // 9) 主进程全部模块语法/依赖可用（preload 仅在渲染进程加载，由 smoke 覆盖）
  for (const m of ["ipc", "keeper", "browser", "quota", "sessions", "backup", "api", "deepseek"]) {
    try {
      require("../src/main/" + m + ".cjs");
      check("模块可加载 " + m, true);
    } catch (e) {
      check("模块可加载 " + m, false, String(e && e.message));
    }
  }

  // 10) 备份与 CSV 导出
  const backup = require("../src/main/backup.cjs");
  const csv = backup.buildCsv();
  const csvHead = csv.split("\r\n")[0];
  check("CSV 表头齐全", csvHead.includes("账号ID") && csvHead.includes("月剩余") && csvHead.includes("5h上限"));
  check("CSV 含导入账号", csv.includes("10000001"));
  check("CSV 不含明文密钥", !csv.includes("sk-test-123"), "发现泄露?");
  check("CSV 含平台表头与智谱账号", csvHead.includes("平台") && csv.includes("智谱 BigModel"), csv.split("\r\n").find((line) => line.includes("bigmodel") || line.includes("智谱")) || csvHead);
  check("CSV 含 DeepSeek 平台账号名", csv.includes("DeepSeek 主力") && csv.includes("DeepSeek"), csv.split("\r\n").find((line) => line.includes("DeepSeek 主力")) || csvHead);
  check("普通 CSV 不含 DeepSeek Key 明文", !csv.includes("sk-ds-test-1"), "leak found");
  const ab = backup.autoBackup();
  check("自动备份生成", ab.ok && fs.existsSync(ab.filePath), JSON.stringify(ab));
  check("今日已有备份判定", backup.hasBackupToday() === true);

  // 11) 会话重签辅助函数
  const sessions = require("../src/main/sessions.cjs");
  const h2 = sessions.applySetCookie("a=1; b=2", ["b=9; Path=/", "c=3; Path=/"]);
  check("applySetCookie 替换+新增", h2.includes("b=9") && h2.includes("c=3") && h2.includes("a=1"), h2);
  const fake = "x=1; _Secure-commandcode_prod.session_data=" + Buffer.from(JSON.stringify({ expiresAt: 1787745377929 })).toString("base64");
  const iso = sessions.decodeSessionExpiry(fake);
  check("decodeSessionExpiry 解析", iso === new Date(1787745377929).toISOString(), iso);
  check("decodeCookieValue 还原转义", sessions.decodeCookieValue("abc%2Bdef%3D%2F") === "abc+def=/", sessions.decodeCookieValue("abc%2Bdef%3D%2F"));
  const legacyCookie =
    "x=1; _Secure-commandcode_prod.session_token=abc%3D; _Secure-commandcode_prod.session_data=def";
  const canonicalCookie = sessions.canonicalizeSessionCookie(legacyCookie);
  check(
    "旧书签 Cookie 名迁移",
    canonicalCookie.includes("__Secure-commandcode_prod_.session_token=abc%3D") &&
      canonicalCookie.includes("__Secure-commandcode_prod_.session_data=def"),
    canonicalCookie
  );
  const credAcc = accounts.create({ accountId: "cred-test", email: "cred@test.com", loginMethod: "email", loginUsername: "cred@test.com" });
  accounts.setLoginSecret(credAcc.id, { password: "secret-password" });
  const credPublic = accounts.findPublic(credAcc.id);
  check("登录凭据公开字段不泄露密码", credPublic.loginMethod === "email" && credPublic.loginUsername === "cred@test.com" && credPublic.hasPassword === true && !JSON.stringify(credPublic).includes("secret-password"), JSON.stringify(credPublic));
  check("密码加密解密", accounts.getPassword(credAcc.id) === "secret-password", Boolean(accounts.getPassword(credAcc.id)));
  const csvText = [
    "账号ID,邮箱,登录方式,登录账号,密码",
    "import-cred,import-cred@test.com,GitHub,github-user,import-pass",
  ].join("\n");
  const credImport = accounts.importPlain(csvText, { merge: false });
  const credImported = accounts.listAll(true).find((item) => item.accountId === "import-cred");
  check("批量导入登录凭据并加密", credImport.added === 1 && credImported.loginMethod === "GitHub" && credImported.loginUsername === "github-user" && accounts.getPassword(credImported.id) === "import-pass", JSON.stringify(credImport));
  const credentialCsv = backup.buildCredentialCsv();
  check(
    "凭据 CSV 包含密码和 Key",
    credentialCsv.includes("secret-password") && credentialCsv.includes("sk-test-123") && credentialCsv.includes("登录方式"),
    Boolean(credentialCsv)
  );
  check("普通 CSV 不含敏感凭据", !csv.includes("secret-password") && !csv.includes("sk-test-123"), "leak found");

  // 12) 真实响应形状（阶段0实测）→ 统一快照
  const quota = require("../src/main/quota.cjs");
  const snap = quota.toSnapshot({
    creditsObj: quota.normalizeCreditsObject(
      { monthlyCredits: 34.9928106601, purchasedCredits: 0, freeCredits: 0, belowThreshold: false },
      {
        limited: true,
        exceeded: "weekly",
        fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
        weekly: { used: 35.0071893399, cap: 35, exceeded: true, resetAt: 1788237885173 },
      }
    ),
    subscriptionData: { planId: "individual-goat", status: "active", currentPeriodEnd: "2026-09-25T04:40:33.000Z" },
    summaryObj: { totalCost: 35.0123006185 },
    planId: null,
  });
  check("真实形状→月剩余", Math.abs(snap.month.remaining - 34.9928106601) < 1e-6, JSON.stringify(snap.month));
  check("真实形状→5h窗口", snap.fiveHour && snap.fiveHour.used === 0 && snap.fiveHour.cap === 14, JSON.stringify(snap.fiveHour));
  check("真实形状→周窗口超限", snap.weekly && snap.weekly.used > 35 && snap.weekly.cap === 35 && snap.weekly.exceeded === true, JSON.stringify(snap.weekly));
  check("真实形状→套餐与周期", snap.month.planId === "individual-goat" && snap.month.periodEnd === "2026-09-25T04:40:33.000Z" && snap.month.totalSpent > 35, JSON.stringify(snap.month));

  // 13) 账号 ID 修正（真实响应形状：user.id 是 UUID，user.userName 才是登录名）
  const gsReal = {
    session: {},
    user: { id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", name: "10000001", userName: "10000001", email: "10000001@example.com" },
  };
  check("登录名提取", sessions.loginFromSession(gsReal) === "10000001", sessions.loginFromSession(gsReal));
  check(
    "UUID 形状识别",
    sessions.looksLikeUuid("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d") === true && sessions.looksLikeUuid("10000001") === false,
    "looksLikeUuid 判定错误"
  );
  const wrongAcc = { id: "x", accountId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", email: null };
  const p1 = sessions.identityPatch(wrongAcc, gsReal);
  check("identityPatch 纠正 UUID 账号ID", p1 && p1.accountId === "10000001" && p1.email === "10000001@example.com", JSON.stringify(p1));
  const okAcc = { id: "y", accountId: "10000001", email: "10000001@example.com" };
  check("identityPatch 正常账号不写回", sessions.identityPatch(okAcc, gsReal) === null, JSON.stringify(sessions.identityPatch(okAcc, gsReal)));
  check("accountIdLooksWrong 判定", sessions.accountIdLooksWrong(wrongAcc) === true && sessions.accountIdLooksWrong(okAcc) === false, "accountIdLooksWrong 判定错误");

  // 13b) 从 session_data Cookie 离线解码登录名（修复存量 UUID 账号 ID 的另一条路）
  const cookieReal =
    "__stripe_mid=x; _Secure-commandcode_prod.session_token=abc; _Secure-commandcode_prod.session_data=" +
    Buffer.from(JSON.stringify({ session: {}, user: { id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", name: "10000001", userName: "10000001", email: "10000001@example.com" }, expiresAt: 1787745377929 })).toString("base64");
  check("loginFromCookie 解码登录名", sessions.loginFromCookie(cookieReal) === "10000001", sessions.loginFromCookie(cookieReal));
  // 真实结构：user 嵌在 session.user 下
  const cookieRealShape =
    "_Secure-commandcode_prod.session_data=" +
    Buffer.from(JSON.stringify({ session: { session: {}, user: { userName: "10000001" } }, expiresAt: 1787745377929 })).toString("base64");
  check("loginFromCookie 兼容 session.user 嵌套", sessions.loginFromCookie(cookieRealShape) === "10000001", sessions.loginFromCookie(cookieRealShape));
  check("loginFromCookie 无效值返回 null", sessions.loginFromCookie("a=1; b=2") === null, String(sessions.loginFromCookie("a=1; b=2")));
  // 离线修复路径：只调用 heal 的"离线段"（get-session 会失败，但离线段先行修复）
  const offlineAcc = accounts.create({ accountId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", email: null, displayName: "离线号" });
  const offlineLocal = accounts.findLocal(offlineAcc.id);
  offlineLocal.session = { cookieEnc: storage.encrypt(cookieReal), expiresAt: null, userId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", email: null, state: "ok", updatedAt: new Date().toISOString() };
  storage.save();
  const healOffline = await sessions.healAccountIdentity(accounts.findLocal(offlineAcc.id), { onlyIfWrong: true });
  check("healAccountIdentity 离线修复 UUID 账号ID", healOffline && healOffline.accountId === "10000001", JSON.stringify(healOffline));

  // 13c) usage 链接：UUID 账号也能借 Cookie 解码出正确 URL（核心逻辑在 browser.usageUrl 内）
  const uuidAcc = accounts.findLocal(offlineAcc.id);
  const urlViaSession = sessions.loginFromCookie(sessions.sessionCookie(uuidAcc)) || null;
  check("usageUrl 候选登录名来自 Cookie", urlViaSession === "10000001", String(urlViaSession));
  check("UUID 不再被当作 usage URL 登录名", sessions.looksLikeUuid(urlViaSession || "10000001") === false, String(urlViaSession));

  // 14) 会话可用性：本地密钥轮换 → 存量 Cookie 解不开 → 标记 broken（需重新登录）
  const reloginAcc = accounts.create({ accountId: null, email: "relogin@test.com" });
  const brokenLocal = accounts.findLocal(reloginAcc.id);
  brokenLocal.session = { cookieEnc: "djEwAAAAAAAAAAAAAAAAAAAAAAAAgarbage", state: "ok", userId: "u-1111", expiresAt: null };
  storage.save();
  const pubBroken = accounts.findPublic(reloginAcc.id);
  check("不可解密会话标记 broken", pubBroken && pubBroken.sessionState === "broken" && pubBroken.hasSession === false, JSON.stringify(pubBroken && { s: pubBroken.sessionState, h: pubBroken.hasSession }));
  brokenLocal.session = { cookieEnc: storage.encrypt("cmd=abc123"), state: "ok", userId: "u-1111", expiresAt: null };
  storage.save();
  const pubOk = accounts.findPublic(reloginAcc.id);
  check("可解密会话状态保持 ok", pubOk && pubOk.sessionState === "ok" && pubOk.hasSession === true, JSON.stringify(pubOk && { s: pubOk.sessionState, h: pubOk.hasSession }));
  check("sessions.sessionUsable", sessions.sessionUsable(accounts.findLocal(reloginAcc.id)) === true, "sessionUsable false");
  // 重新登录命中：accountId 是 UUID 的存量账号也能按 session.userId 复用，不重复建号
  const browserMod = require("../src/main/browser.cjs");
  // login 给一个没人占用的值，确保命中路径是 session.userId 而不是登录名
  const reusable = browserMod.findReusableAccount({ login: "unused-login-xyz", email: null, userId: "u-1111" });
  check("按 session.userId 复用存量账号", reusable && reusable.id === reloginAcc.id, JSON.stringify(reusable && { id: reusable.id, accountId: reusable.accountId }));

  // 15) URL Scheme 浏览器一键添加：解析 / 离线解码 / 暂存去明文
  const schemeMod = require("../src/main/scheme.cjs");
  const browserMod2 = require("../src/main/browser.cjs");
  check("view-source 剥离真实 URL", browserMod2.stripViewSource("view-source:https://commandcode.ai/signin") === "https://commandcode.ai/signin", String(browserMod2.stripViewSource("view-source:https://commandcode.ai/signin")));
  check("普通导航不被误改", browserMod2.stripViewSource("https://github.com/login") === "https://github.com/login", "changed normal url");
  check(
    "登录页文字源码退化可识别",
    browserMod2.looksLikeRawAuthDocument({ contentType: "text/html", bodyText: 'Sign In(function(){try{if(window.location.pathname==="/change-password")' }) === true,
    "raw marker not detected"
  );
  check(
    "正常 HTML 登录页不误判",
    browserMod2.looksLikeRawAuthDocument({ contentType: "text/html", bodyText: "GitHub\nOr sign in with email\nEmail address" }) === false,
    "healthy page misdetected"
  );
  const b64 = Buffer.from(JSON.stringify({ session: { user: { userName: "10000001", email: "10000001@example.com" } }, expiresAt: Date.now() + 24 * 3600e3 })).toString("base64");
  const fakeCookie = "x=1; _Secure-commandcode_prod.session_data=" + b64 + "; _Secure-commandcode_prod.session_token=abc.def%3D";
  check("emailFromCookie 离线解码邮箱", sessions.emailFromCookie(fakeCookie) === "10000001@example.com", String(sessions.emailFromCookie(fakeCookie)));
  const goodUrl = "ccam://add?cookie=" + encodeURIComponent(fakeCookie);
  const parsed = schemeMod.parseUrl(goodUrl);
  check(
    "scheme.parseUrl 有效 URL",
    parsed && parsed.cookie === sessions.canonicalizeSessionCookie(fakeCookie),
    JSON.stringify(parsed)
  );
  check("scheme.parseUrl 非添加接口返回 null", schemeMod.parseUrl("ccam://ping") === null, "expected null");
  check("scheme.parseUrl 缺会话 Cookie 返回 null", schemeMod.parseUrl("ccam://add?x=1") === null, "expected null");
  check("scheme.findUrl 从 argv 提取", schemeMod.findUrl(["a.exe", "--flag", goodUrl]) === goodUrl, String(schemeMod.findUrl(["a.exe", "--flag", goodUrl])));
  const pending = schemeMod.setPending(parsed);
  check("scheme.setPending 暂存并解码身份", pending && pending.login === "10000001" && pending.email === "10000001@example.com", JSON.stringify(pending));
  check("scheme.pendingInfo 不含 Cookie 明文", schemeMod.pendingInfo() && !JSON.stringify(schemeMod.pendingInfo()).includes("session_token"), JSON.stringify(schemeMod.pendingInfo()));
  check("scheme.setPending 拒绝无效 Cookie", schemeMod.setPending({ cookie: "no-session-here" }) === null, "expected null");
  schemeMod.clearPending();
  check("scheme.clearPending 清空暂存", schemeMod.getPending() === null, "not null");

  console.log(failures.length ? "SELFTEST_FAIL: " + failures.join(", ") : "SELFTEST_OK");
  app.exit(failures.length ? 1 : 0);
});
