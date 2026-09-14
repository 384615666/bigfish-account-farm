"use strict";
// 后台任务中心：
//  1) 会话保活（临近过期自动续期）
//  2) 额度自动刷新（可配置间隔）
//  3) 预警通知（月额度/周窗口/5小时窗口阈值）
//  4) 套餐变化检测
//  5) 用量历史记录（每个账号最多保留 500 条快照）
const { Notification } = require("electron");
const accounts = require("./accounts.cjs");
const sessions = require("./sessions.cjs");
const quota = require("./quota.cjs");
const storage = require("./storage.cjs");

let timers = { keeper: null, autoRefresh: null };
let onEvent = null;

function settings() {
  const s = storage.getSettings();
  return {
    keeperEnabled: s.keeperEnabled !== false,
    keeperIntervalMin: Math.max(1, Number(s.keeperIntervalMin) || 60),
    renewThresholdMin: Math.min(10080, Math.max(3, Number(s.renewThresholdMin) || 1440)),
    autoRefreshEnabled: s.autoRefreshEnabled !== false,
    autoRefreshMin: Math.max(1, Number(s.autoRefreshMin) || 15),
    alertPctWeek: Math.min(100, Math.max(1, Number(s.alertPctWeek) || 75)),
    alertPctFiveH: Math.min(100, Math.max(1, Number(s.alertPctFiveH) || 75)),
    alertMonthDollar: Math.max(0, Number(s.alertMonthDollar) || 2),
    renewAlertDays: Math.min(30, Math.max(1, Number(s.renewAlertDays) || 7)),
    notify: s.notify !== false,
  };
}
const emit = (payload) => {
  if (onEvent) onEvent(payload);
};
function systemNotify(title, body) {
  try {
    if (settings().notify) new Notification({ title, body }).show();
  } catch {
    /* 通知失败忽略 */
  }
}

function msUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t - Date.now();
}

// ---------- 1) 会话健康巡检 ----------
// 阶段0实测：会话本体约 8 天有效且服务器端不可远程续期（update-session 400 / POST
// get-session 405），因此巡检目标是"及时发现失效 + 到期前提醒重登"，而非高频续签。
async function checkSessions() {
  const out = { ok: 0, renewed: 0, invalid: 0 };
  const thresholdMs = settings().renewThresholdMin * 60000;
  for (const acc of accounts.listAll(true)) {
    if (acc.status !== "active" || !acc.session) continue;
    // 本地加密密钥轮换会导致存量 Cookie 解不开：明确标记「需重新登录」，不再当健康会话处理
    if (acc.session.cookieEnc && !sessions.sessionUsable(acc)) {
      if (acc.session.state !== "broken") {
        accounts.setSession(acc.id, { ...acc.session, state: "broken", updatedAt: new Date().toISOString() });
      }
      out.invalid++;
      continue;
    }
    // 存量错误账号 ID（UUID 当登录名）自动纠正
    if (sessions.accountIdLooksWrong(acc)) {
      try {
        await sessions.healAccountIdentity(acc, { onlyIfWrong: true });
        const live = accounts.findLocal(acc.id);
        if (live && live.accountId !== acc.accountId) {
          acc.accountId = live.accountId;
          acc.email = live.email;
        }
      } catch {
        /* 修复失败留到下一轮 */
      }
    }
    const remaining = msUntil(acc.session.expiresAt);
    if (remaining === null) {
      out.ok++;
      continue;
    }
    if (remaining < 0) {
      accounts.setSession(acc.id, { ...acc.session, state: "invalid", updatedAt: new Date().toISOString() });
      out.invalid++;
    } else if (remaining < thresholdMs) {
      try {
        const renew = await sessions.tryRenew(acc);
        if (renew.state === "ok") {
          out.renewed++;
          // 会话无法远程续期：即使续签成功，到期时间也不会变，标记"即将到期"提醒重登
          const fresh = accounts.findLocal(acc.id);
          if (fresh && msUntil(fresh.session?.expiresAt) < thresholdMs) {
            accounts.setSession(acc.id, { ...fresh.session, state: "expiring", updatedAt: new Date().toISOString() });
            systemNotify("会话即将到期 · " + (acc.displayName || acc.accountId), "请近期在应用内重新登录一次，保持账号可用。");
          }
        } else {
          accounts.setSession(acc.id, { ...acc.session, state: renew.state, updatedAt: new Date().toISOString() });
          out.invalid++;
        }
      } catch {
        out.invalid++;
      }
    } else {
      out.ok++;
    }
  }
  emit({ type: "keeper:health", ...out, at: new Date().toISOString() });
  return out;
}

// ---------- 历史 / 套餐变化 / 预警 ----------
function pushHistory(acc, snapshot) {
  const h = Array.isArray(acc.quotaHistory) ? acc.quotaHistory : [];
  h.push({
    at: new Date().toISOString(),
    month: snapshot.month || null,
    fiveHour: snapshot.fiveHour || null,
    weekly: snapshot.weekly || null,
  });
  if (h.length > 500) h.splice(0, h.length - 500);
  acc.quotaHistory = h;
}

function checkPlanChange(acc, snapshot) {
  const newPlan = snapshot?.month?.planId;
  if (!newPlan) return;
  if (acc.planId && acc.planId !== newPlan) {
    systemNotify("套餐变化 · " + (acc.displayName || acc.accountId), `${acc.planId} → ${newPlan}`);
  }
  acc.planId = newPlan;
}

function checkAlerts(acc, snapshot) {
  const cfg = settings();
  const alerts = [];
  const name = acc.displayName || acc.accountId;
  const month = snapshot?.month || {};
  const fh = snapshot?.fiveHour || {};
  const wk = snapshot?.weekly || {};
  if (month.remaining !== null && month.remaining < cfg.alertMonthDollar) {
    alerts.push(`月额度剩 $${Number(month.remaining).toFixed(2)}（阈值 $${cfg.alertMonthDollar}）`);
  }
  if (fh.cap > 0 && fh.used / fh.cap >= cfg.alertPctFiveH / 100) {
    alerts.push(`5小时窗口已用 ${((fh.used / fh.cap) * 100).toFixed(0)}%`);
  }
  if (wk.cap > 0 && wk.used / wk.cap >= cfg.alertPctWeek / 100) {
    alerts.push(`周窗口已用 ${((wk.used / wk.cap) * 100).toFixed(0)}%`);
  }
  if (alerts.length) systemNotify("额度预警 · " + name, alerts.join("；"));
}

// 订阅续费提醒：当前账单周期结束前 N 天提醒（同一周期只提醒一次）
function checkRenewal(acc, snapshot) {
  const periodEnd = snapshot?.month?.periodEnd;
  if (!periodEnd) return;
  const t = new Date(periodEnd).getTime();
  if (Number.isNaN(t)) return;
  const msLeft = t - Date.now();
  if (msLeft > 0 && msLeft <= settings().renewAlertDays * 86400000 && acc.renewAlertSentFor !== periodEnd) {
    systemNotify(
      "订阅即将续费 · " + (acc.displayName || acc.accountId),
      "当前账单周期将于 " + new Date(periodEnd).toLocaleString() + " 结束，请留意续费。"
    );
    acc.renewAlertSentFor = periodEnd;
  }
}

// ---------- 2/3/4/5）额度批量刷新 ----------
async function refreshAll({ silent = false } = {}) {
  const out = [];
  for (const acc of accounts.listAll(true)) {
    if (acc.status !== "active") continue;
    try {
      const r = await quota.refreshAccount(acc);
      if (r.ok) {
        const fresh = accounts.findLocal(acc.id);
        if (fresh) {
          pushHistory(fresh, r.snapshot);
          checkPlanChange(fresh, r.snapshot);
          checkAlerts(fresh, r.snapshot);
          checkRenewal(fresh, r.snapshot);
        }
        storage.save();
        out.push({ id: acc.id, ok: true });
      } else {
        out.push({ id: acc.id, ok: false, reason: r.reason });
      }
    } catch (e) {
      out.push({ id: acc.id, ok: false, reason: String((e && e.message) || e) });
    }
  }
  emit({
    type: "vitals:refreshed",
    ok: out.filter((x) => x.ok).length,
    total: out.length,
    silent: Boolean(silent),
    at: new Date().toISOString(),
  });
  return out;
}

// ---------- 调度 ----------
function stopTimers() {
  if (timers.keeper) clearInterval(timers.keeper);
  if (timers.autoRefresh) clearInterval(timers.autoRefresh);
  timers = { keeper: null, autoRefresh: null };
}

function start(handler) {
  onEvent = handler;
  stopTimers();
  const cfg = settings();
  if (cfg.keeperEnabled) {
    setTimeout(() => checkSessions().catch(() => {}), 20000);
    timers.keeper = setInterval(() => checkSessions().catch(() => {}), cfg.keeperIntervalMin * 60 * 1000);
  }
  if (cfg.autoRefreshEnabled) {
    setTimeout(() => refreshAll({ silent: true }).catch(() => {}), 120000);
    timers.autoRefresh = setInterval(
      () => refreshAll({ silent: true }).catch(() => {}),
      cfg.autoRefreshMin * 60 * 1000
    );
  }
}

function stop() {
  stopTimers();
}

module.exports = { start, stop, checkSessions, refreshAll };
