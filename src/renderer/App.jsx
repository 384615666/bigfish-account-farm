import React, { useEffect, useMemo, useRef, useState } from "react";
import brandIcon from "./assets/brand.png";

const cc = () => window.cc;

// ---------- 工具 ----------
function pct(used, cap) {
  if (cap === null || cap === undefined || cap <= 0) return null;
  return Math.min(100, Math.max(0, (used / cap) * 100));
}
function fmtDollar(v) {
  if (v === null || v === undefined) return "-";
  return `$${Number(v).toFixed(2)}`;
}
// 金额按币种显示：CNY → ¥，其余 → $（DeepSeek 余额可能返回多币种）
function fmtMoney(v, currency) {
  if (v === null || v === undefined) return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  const sym = String(currency || "").toUpperCase() === "CNY" ? "¥" : "$";
  return sym + n.toFixed(2);
}
// 主进程额度刷新失败 reason → 中文（DeepSeek/智谱/CommandCode 共用）
const REASON_TEXT = {
  invalid_key: "API Key 无效或已过期",
  invalid_token: "登录令牌已失效，请重新登录",
  network_error: "网络连接失败（超时/断网）",
  no_api_key: "尚未保存 API Key",
  no_credentials: "尚未保存平台凭据",
  no_session: "无可用会话",
  request_failed: "接口返回异常",
  key_failed: "API Key 通道获取失败",
};
function fmtReset(ms) {
  if (!ms) return null;
  const d = ms - Date.now();
  if (d <= 0) return "进行中";
  const h = Math.floor(d / 3600000);
  const m = Math.floor((d % 3600000) / 60000);
  return h > 0 ? `${h}小时${m}分` : `${m}分`;
}
function barColor(p) {
  if (p === null) return "#3a4150";
  if (p >= 90) return "#f0565c";
  if (p >= 70) return "#f5a623";
  return "#34c98f";
}
function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtExpiry(iso) {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  const left = target - Date.now();
  if (left <= 0) return "已到期";
  const days = Math.floor(left / 86400000);
  const hours = Math.floor((left % 86400000) / 3600000);
  const minutes = Math.floor((left % 3600000) / 60000);
  if (days > 0) return `${days}天${hours}小时后到期`;
  if (hours > 0) return `${hours}小时${minutes}分后到期`;
  return `${minutes}分钟后到期`;
}

// 会话状态显示：broken = 本地 Cookie 无法解密，需要重新登录
function sessionLabel(state) {
  if (state === "ok") return "已登录";
  if (state === "expiring") return "即将到期";
  if (state === "broken") return "需要重新登录";
  if (state === "invalid") return "会话失效";
  return "未登录";
}
function sessionPill(state) {
  return state === "ok" || state === "expiring" ? "ok" : state === "broken" || state === "invalid" || state === "no_session" ? "invalid" : "none";
}

function sessionTip(state) {
  if (state === "ok") return "已登录，会话有效";
  if (state === "expiring") return "会话即将到期，刷新后可延长";
  if (state === "broken") return "本地会话数据无法解密，请点击“打开”重新登录";
  if (state === "invalid") return "服务端会话已失效，请点击“打开”重新登录";
  return "本账号未保存会话或已失效，请点击“打开”登录";
}


// 额度同步状态（CommandCode 手动 Key 模式）：有最近刷新 = 已同步，否则待同步
function syncLabel(acc) {
  return acc.quotaFetchedAt ? "已同步" : "待同步";
}
function syncPill(acc) {
  return acc.quotaFetchedAt ? "ok" : "none";
}
function syncTip(acc) {
  return acc.quotaFetchedAt
    ? "额度已同步（" + new Date(acc.quotaFetchedAt).toLocaleString() + "）"
    : "尚未同步额度，请在详情页添加 API Key 后点刷新";
}

// ---------- Toast ----------
function useToast() {
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  const show = (text) => {
    setMsg(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 3600);
  };
  const node = msg ? <div className="toast">{msg}</div> : null;
  return { show, node };
}

// ---------- 账号卡片 ----------
function AccountCard({ acc, archived, onOpen, onRefresh, onDetail, onRestore, onPurge, onToggleFav, alerts, onReorder }) {
  const q = acc.quota || {};
  const isBigmodel = acc.platform === "bigmodel";
  const isDeepseek = acc.platform === "deepseek";
  const month = q.month || {};
  const fh = q.fiveHour || {};
  const wk = q.weekly || {};
  const fPct = pct(fh.used, fh.cap);
  const wPct = pct(wk.used, wk.cap);
  const a = alerts || {};
  const monthWarn = q.channel && month.remaining != null && month.remaining < Number(a.alertMonthDollar || 0);
  const wWarn = wPct != null && wPct >= Number(a.alertPctWeek || 101);
  const fWarn = fPct != null && fPct >= Number(a.alertPctFiveH || 101);
  const mcpPct = pct(q.mcp?.used, q.mcp?.cap);
  const mcpWarn = isBigmodel && mcpPct != null && mcpPct >= Number(a.alertPctWeek || 101);
  // DeepSeek：余额不可调用（is_available=false，通常为欠费）时整卡标红
  const dsUnavailable = isDeepseek && q.isAvailable === false;
  const hasWarn = !archived && (wWarn || fWarn || mcpWarn || dsUnavailable || (!isBigmodel && !isDeepseek && monthWarn));
  const st = acc.sessionState || "none";
  const sess = isBigmodel ? sessionPill(st) : syncPill(acc);
  const statusState = isBigmodel ? st : (acc.quotaFetchedAt ? "ok" : "none");
  const copyAccount = async () => {
    const value = acc.accountId || acc.loginUsername || acc.email || "";
    if (!value) return;
    await cc().invoke("clipboard:write", value);
  };

  const onDragStart = (event) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/account-id", acc.id);
  };
  const onDragOver = (event) => {
    if (archived || !onReorder) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };
  const onDrop = (event) => {
    if (archived || !onReorder) return;
    event.preventDefault();
    event.stopPropagation();
    onReorder(String(event.dataTransfer.getData("text/account-id") || ""), acc.id);
  };

  return (
    <div
      className={"card" + (sess === "invalid" ? " invalid" : "") + (hasWarn ? " warn-card" : "")}
      onClick={() => onDetail(acc)}
      style={{ cursor: "pointer" }}
      draggable={!archived && Boolean(onReorder)}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="head" style={{ flexWrap: "wrap" }}>
        <button
          type="button"
          className={"fav" + (acc.favorite ? " on" : "")}
          title={acc.favorite ? "取消收藏" : "收藏（置顶）"}
          onClick={(e) => { e.stopPropagation(); if (onToggleFav) onToggleFav(acc); }}
        >{acc.favorite ? "★" : "☆"}</button>
        <span className="name" title={acc.note || acc.displayName}>{hasWarn ? "⚠️ " : ""}{acc.displayName}</span>
        <span className="plan" title={acc.planName || ""}>{acc.platformName}{acc.planName ? " · " + acc.planName : ""}</span>
        {archived ? <span className="status-pill none">已归档</span> : isBigmodel ? <span className={"status-pill " + sess} title={sessionTip(statusState)}>{sessionLabel(statusState)}</span> : <span className={"status-pill " + sess} title={syncTip(acc)}>{syncLabel(acc)}</span>}
      </div>
      <div className="metrics">
        <div className="metric">
          <span className="label">{isDeepseek ? "账户余额" : "月额度"}</span>
          {isBigmodel ? (
            <div className="metric-value">
              <div className="bar"><div style={{ width: (mcpPct ?? 0) + "%", background: barColor(mcpPct) }} /></div>
              <div className="meter-side">
                <span>{q.mcp && q.mcp.used != null ? `${q.mcp.used} / ${q.mcp.cap ?? "?"}` : "—"}</span>
                <span className="reset">{q.mcp?.resetAt ? `${fmtReset(q.mcp.resetAt)}后重置` : "暂无到期信息"}</span>
              </div>
            </div>
          ) : isDeepseek ? (
            <span className="month">
              <span className={"amount " + (dsUnavailable ? "warn" : "")}>
                {(q.balances || []).length ? q.balances.map((b) => fmtMoney(b.total, b.currency)).join("　") : (q.channel ? fmtMoney(null) : "—")}
              </span>
              <span className="period" title={(q.balances || []).map((b) => `${b.currency} 充值 ${fmtMoney(b.toppedUp, b.currency)} · 赠金 ${fmtMoney(b.granted, b.currency)}`).join("\n")}>
                {q.isAvailable === false ? "余额不可用（可能已欠费）" : (q.balances || [])[0] ? `充值 ${fmtMoney(q.balances[0].toppedUp, q.balances[0].currency)} · 赠金 ${fmtMoney(q.balances[0].granted, q.balances[0].currency)}` : "暂无余额数据"}
              </span>
            </span>
          ) : (
            <span className="month">
              <span className={"amount " + (monthWarn ? "warn" : "")}>
                {q.channel ? fmtDollar(month.remaining) + " 剩余" : "—"}
              </span>
              <span className="period" title={month.periodEnd ? new Date(month.periodEnd).toLocaleString() : ""}>
                {q.channel && month.periodEnd ? fmtExpiry(month.periodEnd) : "暂无到期信息"}
              </span>
            </span>
          )}
        </div>
        {!isDeepseek && (
          <>
            <div className="metric">
              <span className="label">周窗口</span>
              <div className="metric-value">
                <div className="bar"><div style={{ width: (wPct ?? 0) + "%", background: barColor(wPct) }} /></div>
                <div className="meter-side">
                  <span className={"pct " + (wWarn ? "warn" : "")}>{wPct === null ? "-" : wPct.toFixed(0) + "%"}</span>
                  <span className="reset">{wk.resetAt ? `${fmtReset(wk.resetAt)}后重置` : "—"}</span>
                </div>
              </div>
            </div>
            <div className="metric">
              <span className="label">5小时窗口</span>
              <div className="metric-value">
                <div className="bar"><div style={{ width: (fPct ?? 0) + "%", background: barColor(fPct) }} /></div>
                <div className="meter-side">
                  <span className={"pct " + (fWarn ? "warn" : "")}>{fPct === null ? "-" : fPct.toFixed(0) + "%"}</span>
                  <span className="reset">{fh.resetAt ? `${fmtReset(fh.resetAt)}后重置` : "—"}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="card-meta" style={{ flexWrap: "wrap", gap: 6 }}>
        <span>上次刷新 {acc.quotaFetchedAt ? fmtTime(acc.quotaFetchedAt) : "—"}</span>
        <span>{q.channel || isBigmodel ? "额度在线" : "待同步"}</span>
      </div>
      <div className="foot" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
        {archived ? (
          <>
            <button className="btn primary" onClick={onRestore}>恢复</button>
            <button className="btn danger" onClick={onPurge}>彻底删除</button>
          </>
        ) : (
          <>
            <button
              className="btn primary"
              onClick={() => {
                if (isBigmodel) cc().invoke("browser:openBigmodelUsage", acc.id);
                else if (isDeepseek) cc().invoke("browser:openDeepseekUsage");
                else cc().invoke("browser:openExternal", acc.id);
              }}
            >用量页</button>
            <button className="btn" onClick={() => onRefresh(acc)}>刷新</button>
            <button className="btn" onClick={copyAccount} disabled={!acc.accountId && !acc.loginUsername && !acc.email} title="复制登录账号（ID / 用户名 / 邮箱）">复制账号</button>
            <button className="btn" onClick={() => onDetail(acc)}>详情</button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- 账号表格视图（大量账号时更紧凑） ----------
function AccountTable({ accounts, groups, archived, onOpen, onRefresh, onDetail, onRestore, onPurge, onToggleFav, alerts, onReorder }) {
  const groupName = (id) => {
    const g = (groups || []).find((x) => x.id === id);
    return g ? g.name : "未分组";
  };
  const a = alerts || {};
  return (
    <table className="acc-table">
      <thead>
        <tr>
              <th style={{ width: 34 }} />
              <th>名称</th>
              <th>分组</th>
              <th>余额/月剩余</th>
              <th>周窗口</th>
              <th>5小时</th>
              <th>会话</th>
              <th style={{ width: 210 }}>操作</th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((acc) => {
          const q = acc.quota || {};
          const isBigmodel = acc.platform === "bigmodel";
          const isDeepseek = acc.platform === "deepseek";
          const fh = q.fiveHour || {};
          const wk = q.weekly || {};
          const fPct = pct(fh.used, fh.cap);
          const wPct = pct(wk.used, wk.cap);
          const monthWarn = q.channel && q.month?.remaining != null && q.month.remaining < Number(a.alertMonthDollar || 0);
          const dsUnavailable = isDeepseek && q.isAvailable === false;
          const wWarn = wPct != null && wPct >= Number(a.alertPctWeek || 101);
          const fWarn = fPct != null && fPct >= Number(a.alertPctFiveH || 101);
          const hasWarn = !archived && (monthWarn || wWarn || fWarn || dsUnavailable);
          const st = acc.sessionState || "none";
          const sess = acc.platform === "bigmodel" ? sessionPill(st) : syncPill(acc);
          const onDragStart = (event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/account-id", acc.id);
          };
          const onDragOver = (event) => {
            if (archived || !onReorder) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          };
          const onDrop = (event) => {
            if (archived || !onReorder) return;
            event.preventDefault();
            event.stopPropagation();
            onReorder(String(event.dataTransfer.getData("text/account-id") || ""), acc.id);
          };
          return (
            <tr
              key={acc.id}
              className={(sess === "invalid" ? "invalid-row " : "") + (hasWarn ? "warn-row" : "")}
              onClick={() => onDetail(acc)}
              style={{ cursor: "pointer" }}
              draggable={!archived && Boolean(onReorder)}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
            >
              <td onClick={(e) => e.stopPropagation()}>
                <button type="button" className={"fav" + (acc.favorite ? " on" : "")} title={acc.favorite ? "取消收藏" : "收藏（置顶）"} onClick={() => onToggleFav(acc)}>{acc.favorite ? "★" : "☆"}</button>
              </td>
              <td>
                <div className="name">{hasWarn ? "⚠️ " : ""}{acc.displayName}</div>
                <div className="muted" style={{ fontSize: 11 }}>{acc.accountId || acc.email}</div>
              </td>
              <td><span className="muted">{groupName(acc.groupId)}</span></td>
              <td className={monthWarn || dsUnavailable ? "warn" : ""}>
                {isBigmodel
                  ? (q.mcp && q.mcp.used != null ? `${q.mcp.used}/${q.mcp.cap ?? "?"}` : "—")
                  : isDeepseek
                    ? (q.balances || []).length
                      ? (q.isAvailable === false ? "⚠️ " : "") + q.balances.map((b) => fmtMoney(b.total, b.currency)).join(" ")
                      : "—"
                    : (q.channel ? fmtDollar(q.month?.remaining) + " 剩余" : "—")}
              </td>
              <td>{isDeepseek ? <span className="muted">—</span> : <span className={"pct " + (wWarn ? "warn" : "")}>{wPct === null ? "-" : wPct.toFixed(0) + "%"}</span>}</td>
              <td>{isDeepseek ? <span className="muted">—</span> : <span className={"pct " + (fWarn ? "warn" : "")}>{fPct === null ? "-" : fPct.toFixed(0) + "%"}</span>}</td>
              <td>{isBigmodel ? <span className={"status-pill " + sess} title={sessionTip(st)}>{sessionLabel(st)}</span> : <span className={"status-pill " + sess} title={syncTip(acc)}>{syncLabel(acc)}</span>}</td>
              <td onClick={(e) => e.stopPropagation()}>
                {archived ? (
                  <>
                    <button className="btn small primary" onClick={() => onRestore(acc)}>恢复</button>
                    <button className="btn small danger" onClick={() => onPurge(acc)}>彻底删除</button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn small primary"
                      onClick={() => {
                        if (isBigmodel) cc().invoke("browser:openBigmodelUsage", acc.id);
                        else if (isDeepseek) cc().invoke("browser:openDeepseekUsage");
                        else onOpen(acc);
                      }}
                    >{isBigmodel || isDeepseek ? "用量页" : "打开"}</button>
                    <button className="btn small" onClick={() => onRefresh(acc)}>刷新</button>
                    <button className="btn small" onClick={() => onDetail(acc)}>详情</button>
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------- 新建分组（内联小表单；Electron 渲染进程不支持 window.prompt） ----------
function GroupCreateRow({ onCreated, placeholder }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    const r = await cc().invoke("groups:create", n);
    setBusy(false);
    if (!r.ok) {
      alert("新建分组失败：" + r.error);
      return;
    }
    setName("");
    setOpen(false);
    if (onCreated) onCreated(r.data);
  };
  if (!open) {
    return (
      <button type="button" className="link-add" onClick={() => setOpen(true)}>＋ 新建分组</button>
    );
  }
  return (
    <div className="group-create-row">
      <input
        autoFocus
        value={name}
        placeholder={placeholder || "分组名称"}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") create();
          if (e.key === "Escape") { setOpen(false); setName(""); }
        }}
      />
      <button type="button" className="btn small primary" onClick={create} disabled={busy || !name.trim()}>
        {busy ? "创建中…" : "确定"}
      </button>
      <button type="button" className="btn small" onClick={() => { setOpen(false); setName(""); }}>取消</button>
    </div>
  );
}

// ---------- 添加账号 ----------
function AddModal({ onClose, onDone, toast }) {
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [note, setNote] = useState("");
  const [groups, setGroups] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loginMethod, setLoginMethod] = useState("");
  const [loginUsername, setLoginUsername] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [platform, setPlatform] = useState("commandcode");
  const [bigToken, setBigToken] = useState("");
  const [bigApiKey, setBigApiKey] = useState("");
  const [testingBig, setTestingBig] = useState(false);
  const [bigCaptured, setBigCaptured] = useState(false);
  const [bigLoginHint, setBigLoginHint] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [testingKey, setTestingKey] = useState(false);
  const isBigmodel = platform === "bigmodel";
  const isDeepseek = platform === "deepseek";
  // Key 末 4 位用于测试成功后自动命名（DeepSeek 无用户名可回填）
  const keyTail = (k) => {
    const t = String(k || "").trim();
    return t.length >= 4 ? t.slice(-4).toUpperCase() : t;
  };

  useEffect(() => {
    cc().invoke("groups:list").then((r) => r.ok && setGroups(r.data || []));
    const off = cc().on("cc:event", (ev) => {
      if (ev.type === "bigmodel:auth:success") {
        setPlatform("bigmodel");
        setBigCaptured(true);
        setBigLoginHint("");
        const account = ev.account || {};
        setName((prev) => prev || account.name || account.username || account.email || "");
        setLoginUsername((prev) => prev || account.username || account.email || "");
      }

      if (ev.type === "bigmodel:auth:error") {
        setBigCaptured(true);
        setBigLoginHint("账号捕获成功，但保存失败：" + (ev.error || "未知错误"));
      }
    });
    return off;
  }, []);

  const handleClose = () => {
    if (isBigmodel && !bigCaptured) cc().invoke("bigmodel:closeLogin");
    if (isBigmodel && bigCaptured) cc().invoke("bigmodel:discardToken");
    onClose();
  };

  const startBigmodelLogin = async () => {
    setBigLoginHint("");
    const r = await cc().invoke("bigmodel:startLogin", {
      displayName: name || null,
      groupId: groupId || null,
      note,
      loginMethod,
      loginUsername,
      apiKey: bigApiKey.trim() || null,
    });
    if (!r.ok) alert("打开智谱登录窗口失败：" + r.error);
  };

  const finish = async () => {
    setBusy(true);
    const common = {
      displayName: name.trim() || (isDeepseek && apiKeyInput.trim() ? "DeepSeek · " + keyTail(apiKeyInput) : null) || null,
      groupId: groupId || null,
      note,
    };
    const r = isBigmodel && bigCaptured
      ? await cc().invoke("bigmodel:finalizeLogin", {
          ...common,
          loginMethod,
          loginUsername,
          apiKey: bigApiKey.trim() || null,
        })
      : await cc().invoke("accounts:create", {
          ...common,
          platform,
          loginMethod,
          loginUsername,
          // DeepSeek 走下方 apiKeys:set 单次写入，避免与 create 内联写入重复
          apiKey: isBigmodel || isDeepseek ? undefined : apiKeyInput.trim() || undefined,
          bigmodelToken: bigToken.trim() || undefined,
          bigmodelApiKey: bigApiKey.trim() || undefined,
        });
    setBusy(false);
    if (!r.ok) {
      alert("保存失败：" + r.error);
      return;
    }
    const accountId = r.data && r.data.id;
    if (accountId && passwordInput.trim()) {
      await cc().invoke("accounts:setLoginSecret", accountId, { password: passwordInput.trim() });
    }
    if (accountId && isBigmodel && (bigToken.trim() || bigApiKey.trim())) {
      await cc().invoke("accounts:setPlatformSecret", accountId, { token: bigToken.trim() || null, apiKey: bigApiKey.trim() || null });
      await cc().invoke("quota:refresh", accountId);
    }
    if (accountId && !isBigmodel && apiKeyInput.trim()) {
      await cc().invoke("apiKeys:set", accountId, { name: "默认", key: apiKeyInput.trim() });
      await cc().invoke("quota:refresh", accountId);
    }
    onDone();
  };

  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="modal">
        <h2>添加账号</h2>
        <div className="field">
          <label>平台</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="commandcode">CommandCode</option>
            <option value="bigmodel">智谱 BigModel</option>
            <option value="deepseek">DeepSeek</option>
          </select>
        </div>
        {isBigmodel ? (
          <>
              <p className="muted" style={{ lineHeight: 1.7 }}>
                推荐点「弹出智谱登录窗口」，保存成功后自动捕获登录令牌并刷新余量。官方用户 API Key 可记录备查，但不能调用该用量接口。
              </p>
            <div className="actions">
              <button className="btn primary" onClick={startBigmodelLogin}>弹出智谱登录窗口</button>
            </div>
            {bigCaptured ? <p className="ok">✅ 已捕获智谱登录令牌（不会明文显示），请确认资料后保存。</p> : null}
            {bigLoginHint ? <p className="muted">⚠️ {bigLoginHint}</p> : null}
            <div className="field">
              <label>显示名称（留空自动命名）</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：智谱主力号" />
            </div>
            <div className="field">
              <label>分组</label>
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">未分组</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <GroupCreateRow placeholder="如：主力号" onCreated={(g) => { setGroups((prev) => [...prev, g]); setGroupId(g.id); }} />
            </div>
            <div className="field">
              <label>登录方式（可选）</label>
              <select value={loginMethod} onChange={(e) => setLoginMethod(e.target.value)}>
                <option value="">未记录</option>
                <option value="email">邮箱密码</option>
                <option value="github">GitHub OAuth</option>
              </select>
            </div>
            <div className="field">
              <label>登录账号（可选）</label>
              <input value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} placeholder="手机号 / 邮箱 / 用户名" />
            </div>
            <div className="field">
              <label>账号密码（可选，保存后本机加密）</label>
              <input type="password" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} placeholder="输入密码" />
            </div>
            {!bigCaptured ? (
              <div className="field">
                <label>智谱登录令牌 / Authorization</label>
                <input type="password" value={bigToken} onChange={(e) => setBigToken(e.target.value)} placeholder="从登录请求 Authorization 头粘贴" />
              </div>
            ) : null}
            <div className="field">
              <label>智谱 API Key（可选）</label>
              <input type="password" value={bigApiKey} onChange={(e) => setBigApiKey(e.target.value)} placeholder="可记录 user_...；当前无法用它读取套餐" />
            </div>
            <div className="actions">
              <button className="btn" onClick={() => setPlatform("commandcode")}>上一步</button>
              <button
                className="btn"
                disabled={!bigToken.trim() && !bigApiKey.trim()}
                onClick={async () => {
                  setTestingBig(true);
                  const r = await cc().invoke("bigmodel:testCredentials", { token: bigToken.trim() || null, apiKey: bigApiKey.trim() || null });
                  setTestingBig(false);
                  toast.show(r.ok && r.data.ok ? "✅ 智谱凭据有效，已识别额度接口" : "❌ 接口未认可：请更新登录令牌");
                }}
              >{testingBig ? "测试中…" : "测试凭据"}</button>
            </div>
            <div className="actions">
              <button className="btn" onClick={handleClose}>取消</button>
              <button className="btn primary" onClick={finish} disabled={busy || (!name.trim() && !(bigCaptured || bigToken.trim() || bigApiKey.trim()))}>
                {busy ? "保存中…" : "保存账号"}
              </button>
            </div>
          </>
        ) : isDeepseek ? (
          <>
            <p className="muted" style={{ lineHeight: 1.7, marginTop: 0 }}>
              添加 DeepSeek 账号：只需官方 API Key（platform.deepseek.com 创建），即可读取账户余额（充值/赠金）。不采集今日消费与 Token 用量——官方无仅凭 Key 的用量接口，详情页可跳官网用量页查看。
            </p>
            <div className="field">
              <label>显示名称（可选，留空自动用 Key 末4位）</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：DeepSeek 主力" />
            </div>
            <div className="field">
              <label>分组（可选）</label>
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">未分组</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <GroupCreateRow placeholder="如：主力号" onCreated={(g) => { setGroups((prev) => [...prev, g]); setGroupId(g.id); }} />
            </div>
            <div className="field">
              <label>DeepSeek API Key（用于读取余额）</label>
              <input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="粘贴 sk-... API Key" />
            </div>
            <div className="actions">
              <button className="btn" onClick={handleClose}>取消</button>
              <button
                className="btn"
                disabled={!apiKeyInput.trim() || testingKey}
                onClick={async () => {
                  setTestingKey(true);
                  const r = await cc().invoke("deepseek:testKey", apiKeyInput.trim());
                  setTestingKey(false);
                  if (r.ok) {
                    const bal = (r.data.snapshot && (r.data.snapshot.primary || {})) || {};
                    toast.show("✅ Key 有效：余额 " + fmtMoney(bal.total, bal.currency));
                    if (!name.trim()) setName("DeepSeek · " + keyTail(apiKeyInput));
                  } else {
                    toast.show("❌ " + r.error);
                  }
                }}
              >{testingKey ? "测试中…" : "测试 Key"}</button>
            </div>
            <div className="actions">
              <button className="btn" onClick={handleClose}>取消</button>
              <button className="btn primary" onClick={finish} disabled={busy || (!apiKeyInput.trim() && !name.trim())}>
                {busy ? "保存中…" : "保存账号"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted" style={{ lineHeight: 1.7, marginTop: 0 }}>
              手动添加 CommandCode 账号：填写账号信息与 API Key（用于同步额度），无需浏览器登录。
            </p>
            <div className="field">
              <label>显示名称（可选，留空自动用账号）</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：Go-主力号" />
            </div>
            <div className="field">
              <label>登录账号（可选）</label>
              <input value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} placeholder="邮箱 / GitHub 用户名 / 手机号" />
            </div>
            <div className="field">
              <label>账号密码（可选，保存后本机加密）</label>
              <input type="password" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} placeholder="输入密码（仅本机保存）" />
            </div>
            <div className="field">
              <label>CommandCode API Key（用于同步额度）</label>
              <input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="粘贴 sk-... API Key" />
            </div>
            <div className="actions">
              <button className="btn" onClick={handleClose}>取消</button>
              <button
                className="btn"
                disabled={!apiKeyInput.trim() || testingKey}
                onClick={async () => {
                  setTestingKey(true);
                  const r = await cc().invoke("commandcode:testKey", apiKeyInput.trim());
                  setTestingKey(false);
                  if (r.ok) {
                    const acct = r.data.account || {};
                    toast.show("✅ Key 有效：账号 " + (acct.userName || acct.login || "未知"));
                    if (!name.trim() && (acct.userName || acct.login)) setName(acct.userName || acct.login || "");
                    if (!loginUsername.trim() && acct.userName) setLoginUsername(acct.userName);
                  } else {
                    toast.show("❌ " + r.error);
                  }
                }}
              >{testingKey ? "测试中…" : "测试 Key"}</button>
            </div>
            <div className="actions">
              <button className="btn" onClick={handleClose}>取消</button>
              <button className="btn primary" onClick={finish} disabled={busy || (!name.trim() && !loginUsername.trim())}>
                {busy ? "保存中…" : "保存账号"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- 批量导入 ----------
function ImportModal({ onClose, onDone, toast }) {
  const [text, setText] = useState("");
  const [merge, setMerge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const handle = (r) => {
    if (!r.ok) {
      toast.show("导入失败：" + r.error);
      return;
    }
    const d = r.data || {};
    if (d.canceled) return;
    setResult(d);
    toast.show(`导入完成：新增 ${d.added} · 合并 ${d.merged} · 跳过 ${d.skipped}`);
    onDone();
  };
  const doPaste = async () => {
    if (!text.trim()) {
      toast.show("请先粘贴清单内容");
      return;
    }
    setBusy(true);
    const r = await cc().invoke("accounts:importPlain", text, { merge });
    setBusy(false);
    handle(r);
  };
  const doFile = async () => {
    setBusy(true);
    const r = await cc().invoke("accounts:importCsvFile", { merge });
    setBusy(false);
    handle(r);
  };
  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>批量导入账号</h2>
        <p className="muted" style={{ marginBottom: 10 }}>
          支持 CSV / TSV / 记事本粘贴。CommandCode 需含「账号ID」或「邮箱」；智谱需含「名称」。可选列：平台 / 密码 / 登录方式 / API Key / 智谱登录令牌 / 智谱API Key。
        </p>
        <div className="field">
          <label>粘贴清单内容</label>
          <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={"例如：\n账号ID,邮箱,名称,分组\n10000001,a@b.com,主力号,生产"} />
        </div>
        <div className="field">
          <label style={{ display: "inline" }}>已存在账号： </label>
          <select value={merge ? "1" : "0"} onChange={(e) => setMerge(e.target.value === "1")}>
            <option value="0">跳过（不重复添加）</option>
            <option value="1">合并（补全缺失字段）</option>
          </select>
        </div>
        {result ? (
          <div className="field">
            <label>导入结果</label>
            <div className="muted">新增 {result.added} · 合并 {result.merged} · 跳过 {result.skipped}（识别行数 {result.total}）</div>
          </div>
        ) : null}
        <div className="actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn" onClick={doFile} disabled={busy}>选择 CSV/TXT 文件</button>
          <button className="btn primary" onClick={doPaste} disabled={busy}>{busy ? "导入中…" : "解析并导入"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- 用量趋势迷你图（周 / 5小时窗口占用百分比） ----------
function TrendChart({ data }) {
  const W = 340, H = 116, PAD = 6, TOP_PAD = 16;
  const pts = Array.isArray(data) ? data : [];
  if (pts.length === 0) return null;
  const pct = (t, key) => {
    const used = key === "weekly" ? t.weeklyUsed : t.fiveHourUsed;
    const cap = key === "weekly" ? t.weeklyCap : t.fiveHourCap;
    if (used == null || !cap || cap <= 0) return null;
    return Math.max(0, Math.min(100, (used / cap) * 100));
  };
  const xFor = (i) => PAD + ((W - PAD * 2) * i) / Math.max(1, pts.length - 1);
  const yFor = (v) => H - 14 - ((H - 14 - TOP_PAD) * v) / 100;
  const series = [
    { key: "weekly", color: "#4f8cff", label: "周用量" },
    { key: "fiveHour", color: "#ffab2e", label: "5小时用量" },
  ];
  const lineFor = (key) => {
    let d = "", prev = null;
    pts.forEach((t, i) => {
      const v = pct(t, key);
      if (v == null) { prev = null; return; }
      const x = xFor(i).toFixed(1), y = yFor(v).toFixed(1);
      d += prev === null ? "M" + x + " " + y : "L" + x + " " + y;
      prev = i;
    });
    return d;
  };
  const areaFor = (key) => {
    const d = lineFor(key);
    return d ? d + "L" + xFor(pts.length - 1).toFixed(1) + " " + yFor(0).toFixed(1) +
      "L" + xFor(0).toFixed(1) + " " + yFor(0).toFixed(1) + "Z" : "";
  };
  const lastDot = (key) => {
    let out = null;
    pts.forEach((t, i) => {
      const v = pct(t, key);
      if (v != null) out = { x: xFor(i), y: yFor(v), v };
    });
    return out;
  };
  const fmtShort = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    const hm = p(d.getHours()) + ":" + p(d.getMinutes());
    return d.toDateString() === new Date().toDateString() ? hm : d.getMonth() + 1 + "-" + d.getDate() + " " + hm;
  };
  return (
    <div className="trend-chart">
      <svg viewBox={"0 0 " + W + " " + H} style={{ width: "100%", height: "auto", display: "block" }}>
        {[0, 50, 100].map((g) => (
          <g key={g}>
            <line x1={PAD} x2={W - PAD} y1={yFor(g)} y2={yFor(g)} stroke="rgba(139,147,163,0.22)" strokeWidth="1" />
            <text x={W - PAD - 2} y={yFor(g) + 3} fontSize="8" fill="#8b93a3" textAnchor="end">{g}%</text>
          </g>
        ))}
        <path d={areaFor("weekly")} fill="rgba(79,140,255,0.10)" stroke="none" />
        {series.map((s) => {
          const dot = lastDot(s.key);
          return (
            <g key={s.key}>
              <path d={lineFor(s.key)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {dot ? <circle cx={dot.x} cy={dot.y} r="3" fill={s.color} stroke="#fff" strokeWidth="1" /> : null}
            </g>
          );
        })}
        {series.map((s, si) => {
          const dot = lastDot(s.key);
          return (
            <g key={s.key + "-legend"}>
              <circle cx={PAD + si * 80} cy={10} r="2.5" fill={s.color} />
              <text x={PAD + si * 80 + 6} y={13} fontSize="9" fill="#8b93a3">
                {s.label}{dot ? " " + Math.round(dot.v) + "%" : " 无数据"}
              </text>
            </g>
          );
        })}
        <text x={PAD} y={H - 2} fontSize="8" fill="#8b93a3">{fmtShort(pts[0].at)}</text>
        {pts.length > 1 ? <text x={W - PAD} y={H - 2} fontSize="8" fill="#8b93a3" textAnchor="end">{fmtShort(pts[pts.length - 1].at)}</text> : null}
      </svg>
    </div>
  );
}

// ---------- 详情/编辑 ----------
function DetailModal({ acc, archived, onClose, onChanged, onRelogin, toast }) {
  const [form, setForm] = useState({
    displayName: acc.displayName,
    note: acc.note || "",
    groupId: acc.groupId || "",
    tags: (acc.tags || []).join(", "),
    loginMethod: acc.loginMethod || "",
    loginUsername: acc.loginUsername || "",
  });
  const [groups, setGroups] = useState([]);
  const [health, setHealth] = useState(null);
  const [keys, setKeys] = useState([]);
  const [revealedKeys, setRevealedKeys] = useState({});
  const [newKey, setNewKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordRevealed, setPasswordRevealed] = useState(false);
  const [password, setPassword] = useState(null);
  const [bigToken, setBigToken] = useState("");
  const [bigTokenVisible, setBigTokenVisible] = useState(false);
  const [savedBigToken, setSavedBigToken] = useState(null);
  const [bigApiKey, setBigApiKey] = useState("");
  const [bigApiKeyVisible, setBigApiKeyVisible] = useState(false);
  const [savedBigApiKey, setSavedBigApiKey] = useState(null);
  const isBigmodel = acc.platform === "bigmodel";
  const isDeepseek = acc.platform === "deepseek";

  useEffect(() => {
    cc().invoke("groups:list").then((r) => r.ok && setGroups(r.data || []));
    cc().invoke("apiKeys:list", acc.id).then((r) => r.ok && setKeys(r.data || []));
  }, [acc.id]);

  const copySavedPassword = async () => {
    const r = await cc().invoke("accounts:copyPassword", acc.id);
    toast.show(r.ok ? "已复制密码" : "复制失败：" + r.error);
  };

  const revealSavedPassword = async () => {
    if (passwordRevealed) {
      setPasswordRevealed(false);
      setPassword(null);
      return;
    }
    const saved = await cc().invoke("accounts:getPassword", acc.id);
    if (saved.ok) {
      setPassword(saved.data);
      setPasswordRevealed(true);
    } else {
      toast.show("读取失败：" + saved.error);
    }
  };

  const saveLoginSecret = async () => {
    const raw = passwordInput.trim();
    const r = await cc().invoke("accounts:setLoginSecret", acc.id, { password: raw || null });
    if (r.ok) {
      setPasswordInput("");
      setPasswordRevealed(false);
      setPassword(null);
      toast.show(raw ? "密码已保存（加密）" : "密码已清除");
      onChanged();
    } else {
      toast.show("保存失败：" + r.error);
    }
  };

  const revealPlatformSecret = async (type) => {
    if (type === "token") {
      if (bigTokenVisible) { setBigTokenVisible(false); setSavedBigToken(null); return; }
      const saved = await cc().invoke("accounts:getPlatformSecret", acc.id, "token");
      if (saved.ok) { setSavedBigToken(saved.data); setBigTokenVisible(true); } else toast.show("读取失败：" + saved.error);
    } else {
      if (bigApiKeyVisible) { setBigApiKeyVisible(false); setSavedBigApiKey(null); return; }
      const saved = await cc().invoke("accounts:getPlatformSecret", acc.id, "apiKey");
      if (saved.ok) { setSavedBigApiKey(saved.data); setBigApiKeyVisible(true); } else toast.show("读取失败：" + saved.error);
    }
  };
  const copyPlatformSecret = async (type) => {
    const saved = await cc().invoke("accounts:getPlatformSecret", acc.id, type);
    if (!saved.ok || !saved.data) { toast.show("未保存该凭据"); return; }
    const copied = await cc().invoke("clipboard:write", saved.data);
    toast.show(copied.ok ? (type === "token" ? "已复制登录令牌" : "已复制 API Key") : "复制失败：" + copied.error);
  };
  const savePlatformSecrets = async () => {
    const token = bigToken.trim();
    const apiKey = bigApiKey.trim();
    if (!token && !apiKey) return;
    const currentToken = await cc().invoke("accounts:getPlatformSecret", acc.id, "token");
    const currentKey = await cc().invoke("accounts:getPlatformSecret", acc.id, "apiKey");
    const r = await cc().invoke("accounts:setPlatformSecret", acc.id, {
      token: token || (currentToken.ok ? currentToken.data : null),
      apiKey: apiKey || (currentKey.ok ? currentKey.data : null),
    });
    if (r.ok) {
      setBigToken(""); setBigApiKey(""); setBigTokenVisible(false); setBigApiKeyVisible(false);
      setSavedBigToken(null); setSavedBigApiKey(null);
      toast.show("智谱凭据已保存（加密）");
      onChanged();
    } else toast.show("保存失败：" + r.error);
  };

  const save = async () => {
    const p = {
      ...form,
      // 标签输入框用逗号/空格分隔，保存时转回数组并去重
      tags: Array.from(
        new Set(
          String(form.tags || "")
            .split(/[,，、\s]+/)
            .map((t) => t.trim())
            .filter(Boolean)
        )
      ),
    };
    const r = await cc().invoke("accounts:update", acc.id, p);
    if (r.ok) { toast.show("已保存"); onChanged(); } else toast.show("保存失败：" + r.error);
  };
  const check = async () => {
    const r = await cc().invoke("sessions:health", acc.id);
    setHealth(r.ok ? r.data : { state: "err" });
  };
  const addKey = async () => {
    const raw = newKey.trim();
    if (!raw) return;
    setKeyBusy(true);
    const r = await cc().invoke("apiKeys:set", acc.id, { name: "default", key: raw.trim() });
    setKeyBusy(false);
    if (r.ok) { toast.show("API Key 已保存（加密）"); setNewKey(""); cc().invoke("apiKeys:list", acc.id).then((x) => x.ok && setKeys(x.data)); }
    else toast.show("失败：" + r.error);
  };
  const delKey = async (keyId) => {
    await cc().invoke("apiKeys:remove", acc.id, keyId);
    cc().invoke("apiKeys:list", acc.id).then((x) => x.ok && setKeys(x.data));
  };
  const softDelete = async () => {
    if (!confirm(`确认把「${acc.displayName}」移到回收站？可恢复。`)) return;
    const r = await cc().invoke("accounts:softRemove", acc.id);
    if (r.ok) { onClose(); onChanged(); }
  };
  const hardDelete = async () => {
    if (!confirm(`⚠️ 彻底删除「${acc.displayName}」？会话与数据不可恢复！`)) return;
    const r = await cc().invoke("accounts:hardDelete", acc.id);
    if (r.ok) { toast.show("已彻底删除"); onClose(); onChanged(); }
  };
  const openExternal = async () => {
    const r = await cc().invoke("browser:openExternal", acc.id);
    if (r.ok) toast.show("已在系统浏览器打开 usage 页");
  };
  const copyText = async (text, label) => {
    const r = await cc().invoke("clipboard:write", text);
    toast.show(r.ok ? `已复制：${label}` : "复制失败：" + r.error);
  };
  const copyUsageUrl = async () => {
    const r = await cc().invoke("browser:usageUrl", acc.id);
    if (!r.ok) { toast.show("获取链接失败：" + r.error); return; }
    copyText(r.data, "usage 链接");
  };
  const copyKey = async (keyId) => {
    const r = await cc().invoke("apiKeys:copy", acc.id, keyId);
    toast.show(r.ok ? "已复制 API Key" : "复制失败：" + r.error);
  };

  const revealKey = async (keyId) => {
    if (revealedKeys[keyId]) {
      setRevealedKeys((prev) => ({ ...prev, [keyId]: false }));
      return;
    }
    const r = await cc().invoke("apiKeys:get", acc.id, keyId);
    if (r.ok) setRevealedKeys((prev) => ({ ...prev, [keyId]: r.data }));
    else toast.show("读取失败：" + r.error);
  };

  const q = acc.quota || {};
  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>账号详情 · {acc.displayName}</h2>
        <div className="field">
          <label>显示名称</label>
          <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </div>
        <div className="field">
          <label>登录方式</label>
          <select value={form.loginMethod || ""} onChange={(e) => setForm({ ...form, loginMethod: e.target.value })}>
            <option value="">未记录</option>
            <option value="email">邮箱密码</option>
            <option value="github">GitHub OAuth</option>
          </select>
        </div>
        <div className="field">
          <label>登录账号（可另存用户名）</label>
          <input value={form.loginUsername || ""} onChange={(e) => setForm({ ...form, loginUsername: e.target.value })} placeholder="如 GitHub 用户名 / 邮箱" />
        </div>
        {!isBigmodel && !isDeepseek && (
          <>
            <div className="field">
              <label>账号ID（commandcode.ai login）</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input value={acc.accountId || ""} readOnly />
                <button className="btn" onClick={() => acc.accountId && copyText(acc.accountId, "账号ID")} disabled={!acc.accountId}>复制</button>
              </div>
            </div>
            <div className="field">
              <label>邮箱</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input value={acc.email || ""} readOnly />
                <button className="btn" onClick={() => acc.email && copyText(acc.email, "邮箱")} disabled={!acc.email}>复制</button>
              </div>
            </div>
            <div className="field">
              <label>账号密码（Windows 本机加密）</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input type={passwordRevealed ? "text" : "password"} value={passwordRevealed ? (password || "") : passwordInput} readOnly={passwordRevealed} onChange={(e) => setPasswordInput(e.target.value)} placeholder={acc.hasPassword ? "已保存密码" : "输入密码"} />
                <button className="btn" onClick={revealSavedPassword} disabled={!acc.hasPassword}>显示</button>
                <button className="btn" onClick={copySavedPassword} disabled={!acc.hasPassword}>复制</button>
                <button className="btn" onClick={saveLoginSecret} disabled={!passwordInput.trim() && !acc.hasPassword}>{passwordInput.trim() ? "保存密码" : "清除密码"}</button>
              </div>
            </div>
            <div className="field">
              <label>usage 链接</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input value={acc.accountId ? `https://commandcode.ai/${acc.accountId}/settings/usage` : "登录名缺失，打开后将自动修复"} readOnly />
                <button className="btn" onClick={copyUsageUrl} disabled={!acc.accountId}>复制</button>
              </div>
            </div>
          </>
        )}
        <div className="field">
          <label>分组</label>
          <select value={form.groupId} onChange={(e) => setForm({ ...form, groupId: e.target.value })}>
            <option value="">未分组</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <GroupCreateRow
            placeholder="如：主力号"
            onCreated={(g) => {
              setGroups((prev) => [...prev, g]);
              setForm((f) => ({ ...f, groupId: g.id }));
            }}
          />
        </div>
        <div className="field">
          <label>备注</label>
          <textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </div>
        <div className="field">
          <label>标签（逗号分隔，用于搜索/筛选）</label>
          <input value={form.tags} placeholder="如：主力号, 生产, 待续费" onChange={(e) => setForm({ ...form, tags: e.target.value })} />
        </div>
        {isBigmodel && (
          <div className="field">
            <label>智谱凭据（Windows 本机加密）</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input type={bigTokenVisible ? "text" : "password"} value={bigTokenVisible ? (savedBigToken || "") : bigToken} onChange={(e) => setBigToken(e.target.value)} placeholder="登录令牌 / Authorization" />
              <button className="btn small" onClick={() => revealPlatformSecret("token")}>{bigTokenVisible ? "隐藏" : "显示"}</button>
              <button className="btn small" onClick={() => copyPlatformSecret("token")}>复制</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <input type={bigApiKeyVisible ? "text" : "password"} value={bigApiKeyVisible ? (savedBigApiKey || "") : bigApiKey} onChange={(e) => setBigApiKey(e.target.value)} placeholder="API Key（user_...）" />
              <button className="btn small" onClick={() => revealPlatformSecret("apiKey")}>{bigApiKeyVisible ? "隐藏" : "显示"}</button>
              <button className="btn small" onClick={() => copyPlatformSecret("apiKey")}>复制</button>
            </div>
            <div className="actions" style={{ marginTop: 8 }}>
              <button
                className="btn"
                onClick={async () => {
                  let token = bigToken.trim();
                  let apiKey = bigApiKey.trim();
                  if (!token) { const saved = await cc().invoke("accounts:getPlatformSecret", acc.id, "token"); token = saved.ok ? saved.data : ""; }
                  if (!apiKey) { const saved = await cc().invoke("accounts:getPlatformSecret", acc.id, "apiKey"); apiKey = saved.ok ? saved.data : ""; }
                  const r = await cc().invoke("bigmodel:testCredentials", { token: token || null, apiKey: apiKey || null });
                  toast.show(r.ok && r.data.ok ? "✅ 智谱凭据有效" : "❌ 智谱凭据无效或接口不认可该通道");
                }}
              >测试凭据</button>
              <button className="btn primary" onClick={savePlatformSecrets} disabled={!bigToken.trim() && !bigApiKey.trim()}>保存新凭据</button>
            </div>
          </div>
        )}
        {isBigmodel && (
          <div className="field">
            <label>最近套餐余量（{acc.quotaFetchedAt ? new Date(acc.quotaFetchedAt).toLocaleString() : "-"}）</label>
            <div className="muted" style={{ lineHeight: 1.9 }}>
              {acc.platformTokenExpiresAt ? (
                <>
                  登录令牌预计 {new Date(acc.platformTokenExpiresAt).toLocaleString()} 过期
                  {fmtExpiry(acc.platformTokenExpiresAt) ? ` · ${fmtExpiry(acc.platformTokenExpiresAt)}` : ""}
                  <br />
                </>
              ) : null}
              5小时 {q.fiveHour?.used != null ? `${q.fiveHour.used} / ${q.fiveHour.cap ?? "?"}${fmtReset(q.fiveHour.resetAt) ? " · " + fmtReset(q.fiveHour.resetAt) + "后重置" : ""}` : "-"}
              <br />周额度 {q.weekly?.used != null ? `${q.weekly.used} / ${q.weekly.cap ?? "?"}${fmtReset(q.weekly.resetAt) ? " · " + fmtReset(q.weekly.resetAt) + "后重置" : ""}` : "-"}
              <br />MCP月额度 {q.mcp?.used != null ? `${q.mcp.used} / ${q.mcp.cap ?? "?"}${fmtReset(q.mcp.resetAt) ? " · " + fmtReset(q.mcp.resetAt) + "后重置" : ""}` : "-"}
            </div>
          </div>
        )}
        {!isBigmodel ? (
          <div className="field" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="muted">额度同步：</span>
          <span className={"status-pill " + syncPill(acc)} title={syncTip(acc)}>{syncLabel(acc)}</span>
          <button className="btn" onClick={async () => { const r = await cc().invoke("quota:refresh", acc.id); toast.show(r.ok ? "额度已刷新" : "刷新失败：" + ((r.data && r.data.reason && (REASON_TEXT[r.data.reason] || r.data.reason)) || r.error || "")); if (r.ok) onChanged(); }}>刷新</button>
          {!keys.length ? (
            <button className="btn primary" onClick={() => { const el = document.querySelector(".key-add-row input"); if (el) el.focus(); toast.show("请粘贴 API Key 后点保存，即可同步额度"); }}>设置 API Key</button>
          ) : null}
          <button className="btn" onClick={() => isDeepseek ? cc().invoke("browser:openDeepseekUsage") : openExternal()}>
            {isDeepseek ? "打开官网用量页" : "系统浏览器打开"}
          </button>
          {health ? <span className="muted">{health.state === "ok" ? "✅ Key 通道可用" : "⚠️ " + health.state}</span> : null}
        </div>
        ) : null}
        {isDeepseek && (
          <div className="field">
            <label>DeepSeek 余额（{acc.quotaFetchedAt ? new Date(acc.quotaFetchedAt).toLocaleString() : "-"}）</label>
            {(q.balances || []).length === 0 ? (
              <div className="muted">尚未同步余额，点击上方「刷新」。余额数据来自官方 GET /user/balance（仅凭 API Key）。</div>
            ) : (
              <div style={{ lineHeight: 1.9 }}>
                {(q.balances || []).map((b) => (
                  <div key={b.currency}>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{fmtMoney(b.total, b.currency)}</span>
                    <span className="muted">
                      {" "}（{b.currency}）充值 {fmtMoney(b.toppedUp, b.currency)} · 赠金 {fmtMoney(b.granted, b.currency)}
                    </span>
                  </div>
                ))}
                <div className={q.isAvailable === false ? "warn" : "muted"}>
                  {q.isAvailable === false
                    ? "⚠️ 余额不可用：账户欠费或余额不足，API 可能无法调用"
                    : q.isAvailable
                      ? "✅ 账户可正常调用 API"
                      : "可用状态未知"}
                </div>
              </div>
            )}
            <p className="muted" style={{ marginBottom: 0 }}>
              今日消费与 Token 用量官方未提供仅凭 API Key 的查询接口，请点击上方「打开官网用量页」（需网页登录）在 platform.deepseek.com/usage 查看。
            </p>
          </div>
        )}
        {q.channel && !isDeepseek ? (
          <div className="field">
            <label>最近额度（{q.channel === "internal-cookie" ? "Cookie通道" : "API Key通道"} · {acc.quotaFetchedAt ? new Date(acc.quotaFetchedAt).toLocaleString() : "-"}）</label>
            <div className="muted" style={{ lineHeight: 1.8 }}>
              月剩余 {fmtDollar(q.month?.remaining)} · 周 {q.weekly ? fmtDollar(q.weekly.used) + " / " + fmtDollar(q.weekly.cap) : "-"} ·
              5h {q.fiveHour ? fmtDollar(q.fiveHour.used) + " / " + fmtDollar(q.fiveHour.cap) : "-"}
              <br />
              套餐到期 {q.month?.periodEnd ? new Date(q.month.periodEnd).toLocaleString() : "-"}
              {q.month?.periodEnd ? ` · ${fmtExpiry(q.month.periodEnd)}` : ""}
            </div>
          </div>
        ) : null}
        {!isDeepseek && acc.trend && acc.trend.length > 0 ? (
          <div className="field">
            <label>用量趋势（最近 {acc.trend.length} 次刷新）</label>
            <TrendChart data={acc.trend} />
            <div style={{ maxHeight: 110, overflowY: "auto", fontSize: 12, lineHeight: 1.9 }}>
              {[...acc.trend].reverse().map((t, idx) => (
                <div key={idx} className="muted">
                  {fmtTime(t.at)} · 月剩 {fmtDollar(t.monthRemaining)} · 5h{" "}
                  {t.fiveHourUsed != null && t.fiveHourCap ? Math.round((t.fiveHourUsed / t.fiveHourCap) * 100) + "%" : "-"} · 周{" "}
                  {t.weeklyUsed != null && t.weeklyCap ? Math.round((t.weeklyUsed / t.weeklyCap) * 100) + "%" : "-"}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {!isBigmodel && (
          <div className="field">
          <label>API Keys（加密保存）</label>
        {keys.length === 0 ? <div className="muted">尚未保存 API Key</div> : keys.map((k) => (
            <div key={k.id} style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{k.name} <span className="muted">({new Date(k.createdAt).toLocaleDateString()})</span></span>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <input readOnly value={revealedKeys[k.id] || "•".repeat(28)} />
                <button className="btn small" onClick={() => revealKey(k.id)}>{revealedKeys[k.id] ? "隐藏" : "显示"}</button>
                <button className="btn small" onClick={() => copyKey(k.id)}>复制</button>
                <button className="btn small danger" onClick={() => delKey(k.id)}>删除</button>
              </div>
            </div>
          ))}
          <div className="key-add-row">
            <input
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder={isDeepseek ? "粘贴 DeepSeek API Key（platform.deepseek.com 创建）" : "粘贴 API Key（commandcode.ai/settings/keys 生成）"}
              onKeyDown={(e) => { if (e.key === "Enter") addKey(); }}
            />
            <button className="btn" onClick={addKey} disabled={keyBusy || !newKey.trim()}>{keyBusy ? "保存中…" : "保存"}</button>
          </div>
        </div>
        )}
        <div className="actions">
          {archived
            ? <button className="btn danger" onClick={hardDelete}>彻底删除</button>
            : <button className="btn danger" onClick={softDelete}>移到回收站</button>}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>关闭</button>
          <button className="btn primary" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}

// ---------- 设置 ----------
function SettingsModal({ webStatus, onClose, toast, onWebStatus }) {
  const [settings, setSettings] = useState({
    keeperEnabled: true,
    keeperIntervalMin: 60,
    autoRefreshEnabled: true,
    autoRefreshMin: 15,
    alertPctWeek: 75,
    alertPctFiveH: 75,
    alertMonthDollar: 2,
    renewAlertDays: 7,
    closeToTray: true,
    autoLaunch: false,
    notify: true,
    webAccessEnabled: false,
    webAccessPort: 8765,
    webAccessPassword: "",
  });
  const [saving, setSaving] = useState(false);
  const [busyBackup, setBusyBackup] = useState(false);
  useEffect(() => {
    cc().invoke("settings:get").then((r) => r.ok && setSettings({ ...settings, ...r.data }));
  }, []);
  const save = async () => {
    setSaving(true);
    const payload = { ...settings };
    if (!payload.webAccessPassword) delete payload.webAccessPassword;
    const r = await cc().invoke("settings:update", payload);
    setSaving(false);
    if (r.ok) {
      const status = await cc().invoke("web:status");
      if (status.ok && onWebStatus) onWebStatus(status.data);
      toast.show("设置已保存");
      onClose();
    }
    else toast.show("失败：" + r.error);
  };
  const doExport = async () => {
    setBusyBackup(true);
    const r = await cc().invoke("backup:export");
    setBusyBackup(false);
    if (r.ok && !r.data.canceled) toast.show("备份已导出：" + r.data.filePath);
  };
  const doExportCsv = async () => {
    setBusyBackup(true);
    const r = await cc().invoke("backup:exportCsv");
    setBusyBackup(false);
    if (r.ok && !r.data.canceled) toast.show("清单已导出：" + r.data.filePath);
  };
  const doExportCredentialsCsv = async () => {
    setBusyBackup(true);
    const r = await cc().invoke("backup:exportCredentialsCsv");
    setBusyBackup(false);
    if (r.ok && !r.data.canceled) toast.show("凭据 CSV 已导出：" + r.data.filePath);
  };
  const doImport = async (merge) => {
    setBusyBackup(true);
    const r = await cc().invoke("backup:import", merge);
    setBusyBackup(false);
    if (r.ok) {
      if (r.data.canceled) return;
      toast.show(`导入完成：${r.data.count} 个账号（${merge ? "合并" : "替换"}）`);
      onClose();
    } else toast.show("导入失败：" + r.error);
  };
  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>设置</h2>
        <div className="field">
          <label>会话自动保活（减少重新登录）</label>
          <select value={settings.keeperEnabled ? "1" : "0"} onChange={(e) => setSettings({ ...settings, keeperEnabled: e.target.value === "1" })}>
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
        </div>
        <div className="field">
          <label>会话健康检查间隔（分钟。最小 1，默认 60。会话约 8 天有效，检查用于及时发现失效并在到期前提醒重登）</label>
          <input type="number" min={1} value={settings.keeperIntervalMin} onChange={(e) => setSettings({ ...settings, keeperIntervalMin: Number(e.target.value) || 60 })} />
        </div>
        <div className="field">
          <label>自动刷新额度（按间隔后台采集月/周/5小时数据）</label>
          <select value={settings.autoRefreshEnabled ? "1" : "0"} onChange={(e) => setSettings({ ...settings, autoRefreshEnabled: e.target.value === "1" })}>
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
        </div>
        <div className="field">
          <label>自动刷新间隔（分钟。最小 1，默认 15；过频可能触发站点限流）</label>
          <input type="number" min={1} value={settings.autoRefreshMin} onChange={(e) => setSettings({ ...settings, autoRefreshMin: Number(e.target.value) || 15 })} />
        </div>
        <div className="field">
          <label>月额度预警阈值（剩余低于 $N 时系统通知。默认 $2）</label>
          <input type="number" min={0} step={0.1} value={settings.alertMonthDollar} onChange={(e) => setSettings({ ...settings, alertMonthDollar: Number(e.target.value) || 0 })} />
        </div>
        <div className="field">
          <label>周窗口预警阈值（已用 ≥ N% 时通知。默认 75%）</label>
          <input type="number" min={1} max={100} value={settings.alertPctWeek} onChange={(e) => setSettings({ ...settings, alertPctWeek: Number(e.target.value) || 75 })} />
        </div>
        <div className="field">
          <label>5小时窗口预警阈值（已用 ≥ N% 时通知。默认 75%）</label>
          <input type="number" min={1} max={100} value={settings.alertPctFiveH} onChange={(e) => setSettings({ ...settings, alertPctFiveH: Number(e.target.value) || 75 })} />
        </div>
        <div className="field">
          <label>系统通知（额度预警 / 套餐变化 / 会话到期提醒）</label>
          <select value={settings.notify ? "1" : "0"} onChange={(e) => setSettings({ ...settings, notify: e.target.value === "1" })}>
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
        </div>
        <div className="field">
          <label>续费提醒提前天数（当前周期结束前 N 天提醒）</label>
          <input type="number" min={1} max={30} value={settings.renewAlertDays} onChange={(e) => setSettings({ ...settings, renewAlertDays: Number(e.target.value) || 7 })} />
        </div>
        <div className="field">
          <label>关闭窗口时最小化到托盘（后台继续保活/刷新）</label>
          <select value={settings.closeToTray === false ? "0" : "1"} onChange={(e) => setSettings({ ...settings, closeToTray: e.target.value === "1" })}>
            <option value="1">开启</option>
            <option value="0">关闭（直接退出）</option>
          </select>
        </div>
        <div className="field">
          <label>局域网用量查看（只读页面；默认密码 0258）</label>
          <select value={settings.webAccessEnabled ? "1" : "0"} onChange={(e) => setSettings({ ...settings, webAccessEnabled: e.target.value === "1" })}>
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
          <input
            type="password"
            placeholder="留空表示不修改访问密码"
            value={settings.webAccessPassword}
            onChange={(e) => setSettings({ ...settings, webAccessPassword: e.target.value })}
          />
          <input
            type="number"
            min="1024"
            max="65535"
            placeholder="端口（默认 8765）"
            value={settings.webAccessPort}
            onChange={(e) => setSettings({ ...settings, webAccessPort: Number(e.target.value) || 8765 })}
          />
          {webStatus.running ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              访问地址：{webStatus.addresses.map((address) => `http://${address}:${webStatus.port}`).join("  ")}
            </p>
          ) : (
            <p className="muted" style={{ marginBottom: 0 }}>保存并开启后显示局域网访问地址。</p>
          )}
        </div>
        <div className="field">
          <label>开机自动启动（登录 Windows 后驻留托盘）</label>
          <select value={settings.autoLaunch ? "1" : "0"} onChange={(e) => setSettings({ ...settings, autoLaunch: e.target.value === "1" })}>
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
        </div>
        <div className="field">
          <label>备份（整包加密，仅本机可还原；含会话、API Key、账号密码）</label>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn" onClick={doExport} disabled={busyBackup}>导出加密备份</button>
            <button className="btn" onClick={doExportCsv} disabled={busyBackup}>导出清单 CSV</button>
            <button className="btn danger" onClick={doExportCredentialsCsv} disabled={busyBackup}>导出凭据 CSV</button>
            <button className="btn" onClick={() => doImport(false)} disabled={busyBackup}>导入（替换）</button>
            <button className="btn" onClick={() => doImport(true)} disabled={busyBackup}>导入（合并）</button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>建议定期导出备份到网盘/其他磁盘，防止误删或数据丢失。普通 CSV 导出不含密码和密钥。</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={onClose}>关闭</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? "保存中…" : "保存设置"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- 主应用 ----------
export default function App() {
  const [accounts, setAccounts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [query, setQuery] = useState("");
  const [filterGroup, setFilterGroup] = useState("__all");
  const [viewMode, setViewMode] = useState("active"); // active | archived
  const [sortKey, setSortKey] = useState(() => localStorage.getItem("cc-sort") || "manual");
  const [view, setView] = useState("card"); // card | table
  const [addOpen, setAddOpen] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [alertCfg, setAlertCfg] = useState({ alertMonthDollar: 2, alertPctWeek: 75, alertPctFiveH: 75 });
  const [addNewGroupOpen, setAddNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [renameGroupId, setRenameGroupId] = useState(null);
  const [renameGroupName, setRenameGroupName] = useState("");
  const [webStatus, setWebStatus] = useState({ enabled: false, running: false, addresses: [] });
  const [theme, setTheme] = useState(() => localStorage.getItem("cc-theme") || "dark");
  const toast = useToast();
  const refreshingRef = useRef(false);

  const reload = async () => {
    const [a, g] = await Promise.all([cc().invoke("accounts:list"), cc().invoke("groups:list")]);
    if (a.ok) setAccounts(a.data);
    if (g.ok) setGroups(g.data);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cc-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("cc-sort", sortKey);
  }, [sortKey]);

  useEffect(() => {
    cc().invoke("web:status").then((r) => {
      if (r.ok) setWebStatus(r.data);
    });
  }, [settingsOpen]);

  useEffect(() => {
    reload();
    cc().invoke("settings:get").then((r) => {
      if (r.ok && r.data) setAlertCfg((prev) => ({ ...prev, ...r.data }));
    });
    const off = cc().on("cc:event", (ev) => {
      if (
        ev.type === "browser:opened" ||
        ev.type === "keeper:health" ||
        ev.type === "browser:session-invalid" ||
        ev.type === "vitals:refreshed" ||
        ev.type === "accounts:changed"
      ) reload();
      if (ev.type === "browser:session-invalid") {
        toast.show("会话已失效，请在该账号窗口内或「详情→重新登录」重新登录");
      }
    });
    return off;
  }, []);

  const open = async (acc) => {
    const r = await cc().invoke("browser:open", acc.id);
    if (!r.ok) toast.show("打开失败：" + r.error);
  };
  const refreshOne = async (acc) => {
    toast.show("刷新 " + acc.displayName + " …");
    const r = await cc().invoke("quota:refresh", acc.id);
    if (r.ok && r.data.ok) toast.show("✅ " + acc.displayName + " 额度已更新");
    else toast.show(r.ok ? "额度刷新失败：" + (REASON_TEXT[r.data.reason] || r.data.reason) : "刷新失败：" + r.error);
    reload();
  };
  const refreshAll = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    toast.show("正在批量刷新…");
    const r = await cc().invoke("quota:refreshAll");
    refreshingRef.current = false;
    setRefreshing(false);
    const okN = ((r.data || []).filter((x) => x.ok)).length;
    toast.show(`批量刷新完成：成功 ${okN}/${(r.data || []).length}`);
    reload();
  };
  const restore = async (acc) => {
    const r = await cc().invoke("accounts:restore", acc.id);
    if (r.ok) toast.show("已恢复：" + acc.displayName); else toast.show("恢复失败：" + r.error);
    reload();
  };
  const purge = async (acc) => {
    if (!confirm(`⚠️ 彻底删除「${acc.displayName}」？不可恢复！`)) return;
    const r = await cc().invoke("accounts:hardDelete", acc.id);
    if (r.ok) toast.show("已彻底删除"); else toast.show("删除失败：" + r.error);
    reload();
  };
  const doCreateGroup = async () => {
    const r = await cc().invoke("groups:create", newGroupName);
    if (!r.ok) { toast.show("新建分组失败：" + r.error); return; }
    setNewGroupName("");
    setAddNewGroupOpen(false);
    reload();
  };
  const doRenameGroup = async (g) => {
    const n = renameGroupName.trim();
    if (!n) { setRenameGroupId(null); return; }
    const r = await cc().invoke("groups:rename", g.id, n);
    if (!r.ok) { toast.show("重命名失败：" + r.error); return; }
    setRenameGroupId(null);
    setRenameGroupName("");
    reload();
  };
  const doRemoveGroup = async (g) => {
    if (!confirm(`删除分组「${g.name}」？组内账号会移到「未分组」，账号本身不会删除。`)) return;
    const r = await cc().invoke("groups:remove", g.id);
    if (!r.ok) { toast.show("删除失败：" + r.error); return; }
    toast.show("分组已删除，账号已移到未分组");
    reload();
  };
  const toggleFav = async (acc) => {
    const r = await cc().invoke("accounts:update", acc.id, { favorite: acc.favorite ? 0 : 1 });
    if (!r.ok) toast.show("操作失败：" + r.error);
    reload();
  };

  const openAll = async () => {
    const ids = visible.map((a) => a.id);
    if (!ids.length) return;
    if (ids.length > 6 && !confirm(`将打开 ${ids.length} 个账号（DeepSeek 会打开官网用量页）。继续？`)) return;
    let okN = 0;
    for (const acc of visible) {
      // DeepSeek 无内置账号窗口：改用系统浏览器打开官网用量页
      if (acc.platform === "deepseek") {
        const r = await cc().invoke("browser:openDeepseekUsage");
        if (r.ok) okN++;
        continue;
      }
      const r = await cc().invoke("browser:open", acc.id);
      if (r.ok) okN++;
    }
    toast.show(`已打开/聚焦 ${okN}/${visible.length} 个账号窗口`);
  };

  const activeCount = accounts.filter((a) => a.status !== "archived").length;
  const archivedCount = accounts.filter((a) => a.status === "archived").length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = accounts.filter((a) => {
      const isArchived = a.status === "archived";
      if (viewMode === "active" && isArchived) return false;
      if (viewMode === "archived" && !isArchived) return false;
      if (filterGroup !== "__all" && a.groupId !== filterGroup) return false;
      if (q) {
        const hay = [a.displayName, a.accountId, a.email, (a.planName || ""), (a.tags || []).join(" ")].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const num = (v) => (typeof v === "number" && !Number.isNaN(v) ? v : null);
    // 余额排序：DeepSeek 用余额快照 primary.total，其余用月剩余
    const balanceOf = (x) => {
      if (x.quota?.primary?.total != null) return num(x.quota.primary.total);
      return num(x.quota?.month?.remaining);
    };
    list.sort((a, b) => {
      if (sortKey === "manual") return Number(a.sortOrder ?? 999999) - Number(b.sortOrder ?? 999999);
      if (sortKey === "name") return String(a.displayName || "").localeCompare(String(b.displayName || ""), "zh");
      if (sortKey === "balance") return (balanceOf(b) ?? -1) - (balanceOf(a) ?? -1);
      if (sortKey === "created") return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      // 默认「最近使用」：收藏优先置顶，其余按最近使用倒序
      const fav = (x) => (x.favorite ? 1 : 0);
      return (fav(b) - fav(a)) || String(b.lastUsedAt || "").localeCompare(String(a.lastUsedAt || ""));
    });
    return list;
  }, [accounts, query, filterGroup, viewMode, sortKey]);

  const reorderAccounts = async (sourceId, targetId) => {
    if (!sourceId || sourceId === targetId) return;
    // 拖动排序只针对「手动排序」生效；其他排序方式下提示切回手动排序
    if (sortKey !== "manual") {
      toast.show("请先切换为「手动排序」再进行拖动调整");
      return;
    }
    // 以持久化的手动顺序为准（不能使用当前界面的顺序）
    const ids = [...accounts].sort((a, b) => Number(a.sortOrder ?? 999999) - Number(b.sortOrder ?? 999999)).map((account) => account.id);
    const from = ids.indexOf(sourceId);
    let to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    // 向下拖动时，目标下标需要 -1（因为被拖动的卡片会先离开原位置）
    if (from < to) to -= 1;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    const previous = accounts;
    const order = new Map(ids.map((id, index) => [id, index]));
    setAccounts((list) => [...list].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)));
    const r = await cc().invoke("accounts:reorder", ids);
    if (!r.ok) {
      setAccounts(previous);
      toast.show("排序保存失败：" + r.error);
      return;
    }
    setAccounts(r.data);
    setSortKey("manual");
    toast.show("顺序已同步");
  };

  const switchView = (mode) => {
    setViewMode(mode);
    setFilterGroup("__all");
  };

  return (
    <div className="layout">
        <div className="topbar">
        <div className="brand">
          <img src={brandIcon} alt="" />
          <div>
            <h1>大肥鱼养殖基地</h1>
            <span>Multi-Account Aquarium</span>
          </div>
        </div>
        <div className="search"><input placeholder="搜索名称 / ID / 邮箱 / 标签…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <select className="btn" style={{ marginLeft: 8 }} value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
          <option value="manual">手动排序</option>
          <option value="recent">最近使用</option>
          <option value="balance">余额从高到低</option>
          <option value="name">按名称</option>
          <option value="created">创建时间</option>
        </select>
        <div className="view-toggle">
          <button className={"btn" + (view === "card" ? " on" : "")} onClick={() => setView("card")}>卡片</button>
          <button className={"btn" + (view === "table" ? " on" : "")} onClick={() => setView("table")}>表格</button>
        </div>
        <div className="spacer" />
        <button className="btn icon" title={theme === "dark" ? "切换浅色模式" : "切换深色模式"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        {viewMode === "active" ? <button className="btn" onClick={refreshAll} disabled={refreshing}>{refreshing ? "刷新中…" : "全部刷新"}</button> : null}
        {viewMode === "active" && visible.length > 0 ? <button className="btn" onClick={openAll}>打开全部</button> : null}
        <button className="btn" onClick={() => setSettingsOpen(true)}>设置</button>
        {viewMode === "active" ? <button className="btn" onClick={() => setImportOpen(true)}>导入</button> : null}
        {viewMode === "active" ? <button className="btn primary" onClick={() => setAddOpen(true)}>+ 添加账号</button> : null}
      </div>
      <div className="body">
        <div className="sidebar">
          <div className={"group" + (viewMode === "active" && filterGroup === "__all" ? " active" : "")} onClick={() => switchView("active")}>
            <span>全部账号</span><span className="muted">{activeCount}</span>
          </div>
          {groups.filter((g) => !g.archived).map((g) => (
            <div key={g.id}>
              {renameGroupId === g.id ? (
                <div className="group-rename-row">
                  <input
                    autoFocus
                    value={renameGroupName}
                    onChange={(e) => setRenameGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") doRenameGroup(g);
                      if (e.key === "Escape") { setRenameGroupId(null); setRenameGroupName(""); }
                    }}
                  />
                  <button className="btn small primary" onClick={() => doRenameGroup(g)}>确定</button>
                  <button className="btn small" onClick={() => { setRenameGroupId(null); setRenameGroupName(""); }}>取消</button>
                </div>
              ) : (
                <div className={"group" + (viewMode === "active" && filterGroup === g.id ? " active" : "")} onClick={() => { setViewMode("active"); setFilterGroup(g.id); }}>
                  <span>{g.name}</span>
                  <span className="muted">{accounts.filter((a) => a.groupId === g.id && a.status !== "archived").length}</span>
                  <span className="group-ops" onClick={(e) => e.stopPropagation()}>
                    <button className="btn small" title="重命名" onClick={() => { setRenameGroupId(g.id); setRenameGroupName(g.name); }}>✎</button>
                    <button className="btn small danger" title="删除分组" onClick={() => doRemoveGroup(g)}>🗑</button>
                  </span>
                </div>
              )}
            </div>
          ))}
          <button className="new-group" onClick={() => setAddNewGroupOpen(true)}>+ 新建分组</button>
          {addNewGroupOpen ? (
            <div className="new-group-form">
              <input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="分组名称"
                onKeyDown={(e) => {
                  if (e.key === "Enter") doCreateGroup();
                  if (e.key === "Escape") { setAddNewGroupOpen(false); setNewGroupName(""); }
                }}
              />
              <div className="new-group-btns">
                <button className="btn small primary" onClick={doCreateGroup} disabled={!newGroupName.trim()}>确定</button>
                <button className="btn small" onClick={() => { setAddNewGroupOpen(false); setNewGroupName(""); }}>取消</button>
              </div>
            </div>
          ) : null}
          <div style={{ marginTop: 14 }} />
          <div className={"group" + (viewMode === "archived" ? " active" : "")} onClick={() => switchView("archived")} style={{ color: "var(--muted)" }}>
            <span>回收站</span><span className="muted">{archivedCount}</span>
          </div>
        </div>
        <div className="content">
          {visible.length === 0 ? (
            <div className="empty">
              <div className="big">{viewMode === "archived" ? "🗑️" : "🗂️"}</div>
              <p>{viewMode === "archived" ? "回收站为空" : "还没有账号。点右上角「添加账号」登录第一个账号。"}</p>
            </div>
          ) : view === "table" ? (
            <div className="table-wrap">
              <AccountTable
                accounts={visible}
                groups={groups}
                archived={viewMode === "archived"}
                alerts={alertCfg}
                onOpen={open}
                onRefresh={refreshOne}
                onDetail={setDetail}
                onToggleFav={toggleFav}
                onReorder={reorderAccounts}
                onRestore={(acc) => restore(acc)}
                onPurge={(acc) => purge(acc)}
              />
            </div>
          ) : (
            <div className="cards">
              {visible.map((acc) => (
                <AccountCard
                  key={acc.id}
                  acc={acc}
                  archived={viewMode === "archived"}
                  onOpen={open}
                  onRefresh={refreshOne}
                  onDetail={setDetail}
                  onToggleFav={toggleFav}
                  alerts={alertCfg}
                  onReorder={reorderAccounts}
                  onRestore={() => restore(acc)}
                  onPurge={() => purge(acc)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {addOpen ? (
        <AddModal
          toast={toast}
          onClose={() => setAddOpen(false)}
          onDone={() => { setAddOpen(false); reload(); }}
        />
      ) : null}
      {importOpen ? <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); reload(); }} toast={toast} /> : null}
      {detail ? <DetailModal acc={detail} archived={viewMode === "archived"} onClose={() => setDetail(null)} onChanged={() => { reload(); setDetail(null); }} onRelogin={() => { setDetail(null); setAddOpen(true); }} toast={toast} /> : null}
      {settingsOpen ? <SettingsModal webStatus={webStatus} onWebStatus={setWebStatus} onClose={() => setSettingsOpen(false)} toast={toast} /> : null}
      {toast.node}
    </div>
  );
}

