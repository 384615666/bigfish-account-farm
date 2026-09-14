"use strict";
// DeepSeek 余额通道验证：
//  离线：喂官方样例断言 normalizeSnapshot / normalizeBalance（无需 electron，可直接 node 运行）
//  线上：设置 DS_APIKEY=sk-... 时真连 https://api.deepseek.com/user/balance 打印结果
// 运行：node scripts/debug-deepseek.cjs        （离线样例）
//       DS_APIKEY=sk-xxx node scripts/debug-deepseek.cjs   （离线 + 线上）
const path = require("node:path");
const deepseek = require(path.join(__dirname, "..", "src", "main", "deepseek.cjs"));

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  " + extra : ""));
  if (!cond) failed++;
}

// ---- 离线样例：官方文档结构 ----
{
  const r = deepseek.normalizeSnapshot({
    status: 200,
    json: {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
        { currency: "USD", total_balance: "0.50", granted_balance: "0", topped_up_balance: "0.50" },
      ],
    },
  });
  check("CNY/USD 双币种快照 ok", r.ok, JSON.stringify(r.snapshot?.primary));
  check("is_available=true", r.ok && r.snapshot.isAvailable === true);
  check("balances 长度=2", r.ok && r.snapshot.balances.length === 2);
  const cny = r.snapshot?.balances?.find((b) => b.currency === "CNY");
  check("CNY 数值化(total=110)", cny && cny.total === 110, "total=" + cny && cny.total);
  check("CNY granted=10 / toppedUp=100", cny && cny.granted === 10 && cny.toppedUp === 100);
  check("primary=CNY", r.snapshot?.primary?.currency === "CNY");
  check("channel=deepseek-key", r.snapshot?.channel === "deepseek-key");
}

// ---- 数值字符串/缺字段容错 ----
{
  const r = deepseek.normalizeSnapshot({
    status: 200,
    json: { is_available: false, balance_infos: [{ currency: "cny", total_balance: 42, granted_balance: null }] },
  });
  const b = r.snapshot?.balances?.[0];
  check("小写 cny 归一化大写", b && b.currency === "CNY");
  check("缺 topped_up → null 不 NaN", b && b.toppedUp === null && b.total === 42);
  check("is_available=false 透传", r.snapshot?.isAvailable === false);
}

// ---- 空余额数组：视为失败（接口结构异常） ----
{
  const r = deepseek.normalizeSnapshot({ status: 200, json: { is_available: true, balance_infos: [] } });
  check("空 balance_infos → ok=false request_failed", !r.ok && r.reason === "request_failed");
}

// ---- 鉴权失败 ----
{
  const r401 = deepseek.normalizeSnapshot({ status: 401, json: { error: { message: "auth" } } });
  check("401 → invalid_key", !r401.ok && r401.reason === "invalid_key");
  const r403 = deepseek.normalizeSnapshot({ status: 403, json: { error: {} } });
  check("403 → invalid_key", !r403.ok && r403.reason === "invalid_key");
}

// ---- collectByKey 空值 ----
(async () => {
  const noKey = await deepseek.collectByKey("");
  check("空 Key → no_api_key", !noKey.ok && noKey.reason === "no_api_key");

  // ---- 线上真连（可选） ----
  const apiKey = process.env.DS_APIKEY;
  if (apiKey) {
    try {
      const live = await deepseek.collectByKey(apiKey);
      console.log("\n[online] /user/balance => " + JSON.stringify({ ok: live.ok, reason: live.reason || null, snapshot: live.snapshot || null }, null, 1));
      check("线上 collectByKey ok", live.ok);
    } catch (e) {
      console.log("\n[online] 异常: " + String((e && e.message) || e));
      failed++;
    }
  } else {
    console.log("\n（未设置 DS_APIKEY，跳过线上探测；如需真连：DS_APIKEY=sk-xxx node scripts/debug-deepseek.cjs）");
  }

  console.log(failed === 0 ? "\nDEEPSEEK_DEBUG_OK" : "\nDEEPSEEK_DEBUG_FAIL (" + failed + ")");
  process.exit(failed === 0 ? 0 : 1);
})();
