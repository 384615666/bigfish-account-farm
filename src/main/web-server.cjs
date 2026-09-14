"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const os = require("node:os");
const accounts = require("./accounts.cjs");
const storage = require("./storage.cjs");

const SESSION_DAYS = 365;
const COOKIE_NAME = 'ccam_session';
const loginAttempts = new Map();

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 32).toString("hex");
}

function defaultSettings() {
  return {
    webAccessEnabled: false,
    webAccessPort: 8765,
    webAccessPasswordSalt: crypto.randomBytes(16).toString("hex"),
    webAccessSecret: crypto.randomBytes(32).toString("hex"),
  };
}

function settings() {
  const current = storage.getSettings();
  let changed = false;
  for (const [key, value] of Object.entries(defaultSettings())) {
    if (current[key] === undefined) {
      current[key] = value;
      changed = true;
    }
  }
  if (!current.webAccessPasswordHash) {
    current.webAccessPasswordHash = hashPassword("0258", current.webAccessPasswordSalt);
    changed = true;
  }
  if (current.webAccessPassword !== undefined) {
    const password = String(current.webAccessPassword || "");
    current.webAccessPasswordSalt = crypto.randomBytes(16).toString("hex");
    current.webAccessPasswordHash = hashPassword(password, current.webAccessPasswordSalt);
    delete current.webAccessPassword;
    changed = true;
  }
  if (changed) storage.save();
  return current;
}

function publicSnapshot() {
  const list = accounts.list()
    .filter((account) => account.status !== "archived")
    .sort((a, b) => Number(a.sortOrder ?? 999999) - Number(b.sortOrder ?? 999999))
    .map((account) => ({
      id: account.id,
      displayName: account.displayName || account.accountId || account.loginUsername || account.email || '未命名账号',
      accountId: account.accountId || account.loginUsername || account.email || null,
      platform: account.platform || "commandcode",
platformName: account.platformName,
      planName: account.planName,
      status: account.status,
      sessionState: account.sessionState,
      quotaFetchedAt: account.quotaFetchedAt,
      quota: account.quota ? {
        channel: account.quota.channel || null,
        month: account.quota.month || null,
        weekly: account.quota.weekly || null,
        fiveHour: account.quota.fiveHour || null,
        mcp: account.quota.mcp || null,
        isAvailable: account.quota.isAvailable ?? null,
        balances: account.quota.balances || null,
      } : null,
    }));
  return { accounts: list, updatedAt: new Date().toISOString() };
}

function sign(value) {
  return crypto.createHmac("sha256", String(settings().webAccessSecret)).update(value).digest("hex");
}

function parseCookies(header) {
  return Object.fromEntries(String(header || "")
    .split(";")
    .map((part) => part.trim().split("="))
    .filter((parts) => parts.length >= 2)
    .map(([key, ...rest]) => [key, decodeURIComponent(rest.join("="))]));
}

function authed(req) {
  const cookies = parseCookies(req.headers.cookie);
  const [issuedAt, signature] = String(cookies[COOKIE_NAME] || "").split(".");
  if (!issuedAt || !signature) return false;
  const expected = sign("web:" + issuedAt);
  if (Date.now() - Number(issuedAt) > SESSION_DAYS * 86400000) return false;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tooManyAttempts(key) {
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter((at) => now - at < 10 * 60000);
  loginAttempts.set(key, attempts);
  return attempts.length >= 10;
}

function recordAttempt(key) {
  const attempts = loginAttempts.get(key) || [];
  attempts.push(Date.now());
  loginAttempts.set(key, attempts);
}

function clearAttempts(key) {
  loginAttempts.delete(key);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...securityHeaders(), ...headers });
  res.end(body);
}

function page() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼养殖基地 · 用量</title><style>
*{box-sizing:border-box}body{margin:0;background:#071322;color:#e9f5ff;font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:26px}.top{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:20px}
h1{margin:0;font-size:21px}.muted{color:#89a9c4;font-size:12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
.card{background:rgba(11,29,47,.92);border:1px solid rgba(125,211,252,.17);border-radius:16px;padding:17px}.name{font-weight:700;font-size:16px;display:flex;justify-content:space-between;gap:8px}
.pill{font-size:11px;border-radius:999px;padding:2px 9px;background:#12314d;color:#89a9c4;white-space:nowrap}.pill.ok{color:#34d399;background:rgba(52,211,153,.14)}.pill.bad{color:#fb7185;background:rgba(251,113,133,.14)}
.amount{font-size:22px;font-weight:800;margin:11px 0 3px}.bar{height:8px;border-radius:99px;background:#12314d;overflow:hidden;margin:5px 0 11px}.bar i{display:block;height:100%;background:#38bdf8}
.row{display:flex;justify-content:space-between;font-size:12px;color:#89a9c4}button,input{font:inherit}input{width:100%;padding:10px;border:1px solid #28455e;border-radius:10px;background:#0b1d2f;color:#e9f5ff;margin-bottom:10px}
button{padding:9px 14px;border:0;border-radius:10px;background:#38bdf8;color:#04263a;font-weight:700}.login{max-width:360px;margin:70px auto;background:rgba(11,29,47,.92);padding:24px;border-radius:18px;border:1px solid rgba(125,211,252,.17)}
.err{color:#fb7185;font-size:13px;margin:0 0 10px}@media(max-width:520px){.grid{grid-template-columns:1fr}.wrap{padding:15px}}
</style></head><body><div id="app" class="wrap">加载中…</div><script>async function refresh(){
  const r=await fetch('/api/usage',{credentials:'same-origin'});
  if(r.status===401){location.reload();return}
  if(!r.ok)throw new Error('加载失败('+r.status+')，请重试');
  const d=await r.json();
  const a=document.getElementById('app');
  const st=x=>x.platform==='bigmodel'?(x.sessionState==='ok'?'<span class="pill ok">已登录</span>':x.sessionState==='expiring'?'<span class="pill">即将到期</span>':x.sessionState==='none'?'<span class="pill">未登录</span>':'<span class="pill bad">会话失效</span>'):(x.quotaFetchedAt?'<span class="pill ok">已同步</span>':'<span class="pill">待同步</span>');
  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const pct=(u,c)=>c>0?Math.max(0,Math.min(100,u/c*100)):0;
  const cards=d.accounts.map(x=>{const q=x.quota||{};const isBig=x.platform==='bigmodel';const isDs=x.platform==='deepseek';const m=q.month||{};const w=q.weekly||{};const f=q.fiveHour||{};const mc=q.mcp||{};const bl=q.balances||[];const n=v=>Number(v||0).toFixed(2);const money=(v,cur)=>v==null?'—':(String(cur||'').toUpperCase()==='CNY'?'¥':'$')+n(v);const updated=x.quotaFetchedAt?new Date(x.quotaFetchedAt).toLocaleString():'待刷新';const due=m.periodEnd?new Date(m.periodEnd).toLocaleString():'—';
    const amount=isBig?(mc.cap?(''+n(mc.used)+' / '+n(mc.cap)):'—'):isDs?(bl.length?bl.map(b=>money(b.total,b.currency)).join(' '):(q.isAvailable===false?'⚠️ 欠费':'—')):(m.remaining==null?'—':'$'+n(m.remaining));const monthRight=isBig?'MCP 月额度':(isDs?'账户余额':due);const sub=isDs?(bl[0]?'充值 '+money(bl[0].toppedUp,bl[0].currency)+' · 赠金 '+money(bl[0].granted,bl[0].currency):(q.isAvailable===false?'余额不可用':'暂无余额数据')):'';
    return '<div class="card"><div class="name"><span>'+esc(x.displayName)+'</span>'+st(x)+'</div><div class="muted">'+esc(x.platformName+(x.planName?' · '+x.planName:''))+'</div><div class="amount">'+amount+'</div>'+(isDs?'<div class="row"><span>充值/赠金</span><span>'+esc(sub)+'</span></div>':'<div class="row"><span>'+esc(isBig?'月额度':'月额度剩余')+'</span><span>'+esc(monthRight)+'</span></div>')+'<div class="row"><span>上次刷新</span><span>'+esc(updated)+'</span></div><div class="row"><span>周窗口</span><span>'+(w.cap?''+n(w.used)+' / '+n(w.cap)+'（'+pct(w.used||0,w.cap||0).toFixed(0)+'%）':'—')+'</span></div><div class="bar"><i style="width:'+pct(w.used||0,w.cap||0)+'%"></i></div><div class="row"><span>5小时窗口</span><span>'+(f.cap?''+n(f.used)+' / '+n(f.cap)+'（'+pct(f.used||0,f.cap||0).toFixed(0)+'%）':'—')+'</span></div><div class="bar"><i style="width:'+pct(f.used||0,f.cap||0)+'%"></i></div></div>'}).join('');
  a.innerHTML='<div class="top"><div><h1>账号用量总览</h1><div class="muted">更新时间 '+new Date(d.updatedAt).toLocaleString()+'</div></div><span><button id="refreshBtn">刷新</button> <button id="logout">退出</button></span></div><div class="grid">'+(cards||'<div class="card">暂无账号</div>')+'</div>';
  document.getElementById('refreshBtn').onclick=()=>{const b=document.getElementById('refreshBtn');b.disabled=true;b.textContent='刷新中…';fetch('/api/refresh',{method:'POST'}).finally(()=>refresh()).finally(()=>{b.disabled=false;b.textContent='刷新'})};document.getElementById('logout').onclick=()=>fetch('/logout',{method:'POST'}).then(()=>location.reload());
}
refresh().catch(e=>{const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));document.getElementById('app').innerHTML='<div class="wrap"><div class="card"><p style="color:#fb7185">加载失败：'+esc(String(e&&e.message||e))+'</p><button onclick="location.reload()">重试</button></div></div>'}).then(()=>setInterval(()=>refresh().catch(()=>{}),60000));document.title='CommandCode 用量总览';
</script></body></html>`;
}

async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") return send(res, 200, "text/plain", "ok");
  if (url.pathname === "/login" && req.method === "POST") {
    let body = "";
    if (!sameOrigin(req)) return send(res, 403, "application/json", JSON.stringify({ error: "来源无效" }));
    const attemptKey = req.socket.remoteAddress || "unknown";
    if (tooManyAttempts(attemptKey)) return send(res, 429, "application/json", JSON.stringify({ error: "尝试过多，请10分钟后再试" }));
    req.on("data", (chunk) => { body += chunk; if (body.length > 1000) req.destroy(); });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        const cfg = settings();
        const expected = Buffer.from(String(cfg.webAccessPasswordHash), "hex");
        const given = String(input.password || "");
        const actual = Buffer.from(hashPassword(given, cfg.webAccessPasswordSalt), "hex");
        const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
        if (!ok) recordAttempt(attemptKey);
        if (!ok) return send(res, 401, "application/json", JSON.stringify({ error: "密码错误" }));
        const issuedAt = Date.now().toString();
        const token = issuedAt + "." + sign("web:" + issuedAt);
        clearAttempts(attemptKey);
        return send(res, 200, "application/json", JSON.stringify({ ok: true }), {
          "Set-Cookie": `ccam_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
        });
      } catch {
        return send(res, 400, "application/json", JSON.stringify({ error: "请求无效" }));
      }
    });
    return;
  }
  if (url.pathname === "/logout" && req.method === "POST") {
    if (!sameOrigin(req)) return send(res, 403, "application/json", JSON.stringify({ error: "来源无效" }));
    return send(res, 204, "text/plain", "", { "Set-Cookie": "ccam_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
  }
  if (url.pathname === "/api/usage") {
    if (!authed(req)) return send(res, 401, "application/json", JSON.stringify({ error: "未登录" }));
    return send(res, 200, "application/json", JSON.stringify(publicSnapshot()));
  }
  if (url.pathname === "/api/refresh" && req.method === "POST") {
    if (!sameOrigin(req)) return send(res, 403, "application/json", JSON.stringify({ error: "来源无效" }));
    if (!authed(req)) return send(res, 401, "application/json", JSON.stringify({ error: "未登录" }));
    const keeper = require("./keeper.cjs");
    keeper.refreshAll({ silent: true }).catch(() => {});
    return send(res, 202, "application/json", JSON.stringify({ ok: true }));
  }
  if (url.pathname === "/") {
    if (!authed(req)) return send(res, 200, "text/html; charset=utf-8", `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>大肥鱼养殖基地</title><style>body{margin:0;background:#071322;color:#e9f5ff;font:14px "Segoe UI","Microsoft YaHei",sans-serif}.login{max-width:360px;margin:70px auto;background:rgba(11,29,47,.92);padding:24px;border-radius:18px;border:1px solid rgba(125,211,252,.17)}input{width:100%;padding:10px;border:1px solid #28455e;border-radius:10px;background:#0b1d2f;color:#e9f5ff;margin-bottom:10px}button{width:100%;padding:10px;border:0;border-radius:10px;background:#38bdf8;color:#04263a;font-weight:700}.err{color:#fb7185;display:none}</style></head><body><form class="login" onsubmit="return login(event)"><h1>局域网用量查看</h1><p class="err" id="err">密码错误</p><input id="password" type="password" placeholder="访问密码" autofocus><button>登录</button></form><script>async function login(e){e.preventDefault();const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:password.value})});if(!r.ok){err.style.display='block';return}location.reload()}</script></body></html>`);
  }
  if (!authed(req)) return send(res, 302, "text/plain", "", { Location: "/" });
  return send(res, 200, "text/html; charset=utf-8", page());
}

let server = null;

function localAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((info) => info && info.family === "IPv4" && !info.internal).map((info) => info.address);
}

function listen() {
  const cfg = settings();
  if (!cfg.webAccessEnabled || server) return;
  const port = Math.min(65535, Math.max(1024, Number(cfg.webAccessPort) || 8765));
  server = http.createServer((req, res) => handler(req, res).catch((error) => {
    console.error("[web] request failed", error);
    if (!res.headersSent) send(res, 500, "application/json", JSON.stringify({ error: "服务错误" }));
  }));
  server.on("error", (error) => { console.error("[web] server error", error); server = null; });
  server.listen(port, "0.0.0.0", () => {
    console.log("[web] http://" + (localAddresses()[0] || "127.0.0.1") + ":" + port);
  });
}

async function restart() {
  if (server) {
    const old = server;
    server = null;
    await new Promise((resolve) => old.close(resolve));
  }
  listen();
}

function status() {
  const cfg = settings();
  return {
    enabled: Boolean(cfg.webAccessEnabled),
    running: Boolean(server),
    port: Math.min(65535, Math.max(1024, Number(cfg.webAccessPort) || 8765)),
    addresses: server ? ["127.0.0.1", ...localAddresses()] : [],
  };
}

module.exports = { listen, restart, status, publicSnapshot, hashPassword };
