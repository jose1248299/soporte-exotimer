const crypto = require("node:crypto");

const CURSOR_ID = "time-corrections";
const TIME_ACTIONS = [
  "EXOTIMER_CREATE_RESULT_CORRECTION_CASE",
  "EXOTIMER_EDIT_RESULT_TIME",
  "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION",
];

function isTimeCorrection(classification = {}) {
  if (TIME_ACTIONS.slice(1).includes(classification.action)) return true;
  if (/INSCRIPTION|PAYMENT|COMPETITION_SETUP/.test(classification.action || "")) return false;
  const input = classification.actionInput || {};
  const text = [classification.intent, classification.summary, input.targetField,
    input.caseType, input.requestedCorrection].filter(Boolean).join(" ")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[_-]/g, " ").toLowerCase();
  return /(?:correg|correcc|correct|incorrect|error|revis|review|missing|falt|no aparece|sin tiempo)/.test(text) &&
    /(?:tiempo|cronometraje|timing|hora (?:meta|salida)|official.?time|\btime\b)/.test(text);
}

function actionObservation(action) {
  if (!TIME_ACTIONS.includes(action.name)) return null;
  const verification = action.output?.verification;
  if (action.name === "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION" &&
      verification?.verified === true &&
      (action.status === "EXECUTED" || (action.status === "SKIPPED" && action.output?.idempotentReplay))) {
    return { code: "VERIFIED", label: "Corrección de tiempo verificada por lectura posterior." };
  }
  if (verification?.verified === false) {
    return { code: "MISMATCH", label: "La lectura posterior no confirma la corrección; requiere revisión." };
  }
  if (action.status === "FAILED") return { code: "FAILED", label: "La acción falló; corrección pendiente de revisión." };
  if (action.status === "PROPOSED") return { code: "PROPOSED", label: "Acción propuesta, pendiente de confirmación humana." };
  if (action.status === "SKIPPED") return { code: "SKIPPED", label: "Acción omitida; no se confirma una corrección." };
  if (action.name === TIME_ACTIONS[0] && action.status === "EXECUTED") {
    return { code: "REGISTERED", label: "Solicitud registrada; esto no confirma que el tiempo haya cambiado." };
  }
  if (action.status === "EXECUTED") {
    return { code: "UNVERIFIED", label: "Acción ejecutada sin comprobación concluyente del tiempo." };
  }
  return null;
}

function validateSettings(settings = {}) {
  if (!settings.enabled) return false;
  try {
    const webhook = new URL(settings.webhookUrl);
    const base = new URL(settings.caseBaseUrl);
    return webhook.protocol === "https:" && webhook.hostname === "hooks.slack.com" && !webhook.port &&
      !webhook.username && !webhook.password && !webhook.search && !webhook.hash &&
      /^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(webhook.pathname) &&
      (base.protocol === "https:" || (base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) &&
      !base.username && !base.password && !base.search && !base.hash;
  } catch { return false; }
}

function caseUrl(settings, watch) {
  const url = new URL(settings.caseBaseUrl);
  url.searchParams.set("conversation", watch.conversationId);
  if (watch.supportCaseId) url.searchParams.set("case", watch.supportCaseId);
  return url.toString();
}

function notificationPayload(settings, watch, status, reply) {
  return {
    identifier: watch.supportCaseId ? `Caso #${watch.supportCaseId}` : `Solicitud de conversación #${watch.conversationId}`,
    url: caseUrl(settings, watch),
    status,
    ...(settings.includeReply && reply ? { reply: String(reply).slice(0, 2500) } : {}),
  };
}

function renderPayload(payload, includeReply = false) {
  const blocks = [
    { type: "section", text: { type: "plain_text", text: `${payload.identifier}\n${payload.status}`, emoji: false } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Abrir caso en soporte" }, url: payload.url }] },
  ];
  if (includeReply && payload.reply) blocks.push({ type: "section", text: {
    type: "plain_text", text: `Respuesta automática guardada (no implica entrega):\n${payload.reply}`, emoji: false,
  } });
  return { text: `${payload.identifier}: ${payload.status}`, blocks, unfurl_links: false, unfurl_media: false };
}

// The transport has no access to Exotimer, OpenAI or WhatsApp and never follows redirects.
async function postWebhook(url, payload) {
  const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { status: response.status, body: await response.text(), retryAfter: response.headers.get("retry-after") };
}

function createSlackCorrections({ db, settings, send = postWebhook, now = () => new Date() }) {
  let busy = false;

  async function initialize() {
    const existing = await db.slackCorrectionCursor.findUnique({ where: { id: CURSOR_ID } });
    if (existing) return existing;
    return db.slackCorrectionCursor.upsert({ where: { id: CURSOR_ID }, update: {}, create: {
      id: CURSOR_ID, startedAt: now(), nextSendAt: now(),
    } });
  }

  async function queue(tx, watch, key, kind, status, reply) {
    await tx.slackCorrectionNotification.upsert({ where: { eventKey: key }, update: {}, create: {
      eventKey: key, watchId: watch.id, kind, payload: notificationPayload(settings, watch, status, reply), nextSendAt: now(),
    } });
  }

  async function observeReply(message) {
    const classification = message.aiMetadata?.classification;
    const hash = crypto.createHash("sha256").update(message.content || "").digest("hex");
    const provisionalKey = `conversation:${message.conversationId}`;
    const key = message.supportCaseId ? `case:${message.supportCaseId}` : provisionalKey;
    await db.$transaction(async tx => {
      // A per-message ledger handles transactions committing out of ID order and restarts.
      if (await tx.slackCorrectionObservedReply.findUnique({ where: { messageId: message.id } })) return;
      if (!classification || !isTimeCorrection(classification)) {
        await tx.slackCorrectionObservedReply.create({ data: { messageId: message.id } });
        return;
      }
      let watch = await tx.slackCorrectionWatch.findUnique({ where: { key } });
      if (!watch && message.supportCaseId) {
        watch = await tx.slackCorrectionWatch.findUnique({ where: { key: provisionalKey } });
        if (watch) watch = await tx.slackCorrectionWatch.update({ where: { id: watch.id }, data: {
          key, supportCaseId: message.supportCaseId,
        } });
      }
      if (!watch) {
        watch = await tx.slackCorrectionWatch.create({ data: {
          key, conversationId: message.conversationId, supportCaseId: message.supportCaseId || null,
          lastReplyId: message.id, lastReplyHash: hash,
        } });
        await queue(tx, watch, `watch:${watch.id}:reply:${hash}`, "REQUEST",
          "Nueva solicitud de corrección de tiempo. Respuesta automática guardada; resultado pendiente de verificación.", message.content);
      } else {
        if (settings.includeReply && watch.lastReplyHash !== hash) {
          await queue(tx, watch, `watch:${watch.id}:reply:${hash}`, "REPLY",
            "Nueva respuesta automática guardada; consultar la evidencia de la corrección en el panel.", message.content);
        }
        await tx.slackCorrectionWatch.update({ where: { id: watch.id }, data: { lastReplyId: message.id, lastReplyHash: hash } });
      }
      await tx.slackCorrectionObservedReply.create({ data: { messageId: message.id } });
    });
  }

  async function observe(cursor) {
    const messages = await db.message.findMany({ where: { direction: "OUTBOUND", createdAt: { gte: cursor.startedAt }, slackObservation: { is: null } },
      orderBy: { id: "asc" }, take: 50,
      select: { id: true, conversationId: true, supportCaseId: true, content: true, aiMetadata: true } });
    for (const message of messages) await observeReply(message);

    // Page watches so older unresolved requests continue to be observed, including human executions.
    const watches = await db.slackCorrectionWatch.findMany({ where: { id: { gt: cursor.lastWatchId } }, orderBy: { id: "asc" }, take: 20 });
    for (const watch of watches) {
      const actions = await db.supportAction.findMany({ where: {
        ...(watch.supportCaseId ? { supportCaseId: watch.supportCaseId } : { conversationId: watch.conversationId, supportCaseId: null }),
        name: { in: TIME_ACTIONS }, updatedAt: { gte: cursor.startedAt },
      }, orderBy: { id: "asc" } });
      for (const action of actions) {
        const observation = actionObservation(action);
        const canonicalId = action.output?.idempotentReplay && action.output?.reusedFromActionId || action.id;
        if (observation) await queue(db, watch, `watch:${watch.id}:action:${canonicalId}:${observation.code}`,
          "ACTION", observation.label);
      }
    }
    await db.slackCorrectionCursor.updateMany({ where: { id: CURSOR_ID, lastWatchId: cursor.lastWatchId },
      data: { lastWatchId: watches.length ? watches.at(-1).id : 0 } });
  }

  async function deliver(event) {
    if (!validateSettings(settings)) return;
    const claimed = await db.slackCorrectionNotification.updateMany({ where: {
      id: event.id, state: "PENDING", nextSendAt: { lte: now() },
    }, data: { state: "SENDING", attempts: { increment: 1 }, attemptedAt: now(), lastError: null } });
    if (!claimed.count) return;
    let response;
    try { response = await send(settings.webhookUrl, renderPayload(event.payload, settings.includeReply)); }
    catch {
      // Timeout/network errors can happen after Slack accepted the message: never resend blindly.
      await db.slackCorrectionNotification.update({ where: { id: event.id }, data: {
        state: "UNCERTAIN", lastError: "DELIVERY_UNCERTAIN",
      } });
      return;
    }
    if (response.status === 200 && response.body?.trim() === "ok") {
      // A DB error leaves SENDING; recovery marks it UNCERTAIN, preventing duplicate POSTs.
      await db.slackCorrectionNotification.update({ where: { id: event.id }, data: { state: "SENT", sentAt: now(), lastError: null } });
    } else if (response.status === 429) {
      const delay = Math.min(86400, Math.max(1, Number(response.retryAfter) || 60));
      await db.slackCorrectionNotification.update({ where: { id: event.id }, data: {
        state: event.attempts >= 4 ? "FAILED" : "PENDING", nextSendAt: new Date(now().getTime() + delay * 1000), lastError: "RATE_LIMITED",
      } });
    } else {
      await db.slackCorrectionNotification.update({ where: { id: event.id }, data: {
        state: response.status >= 500 || response.status === 200 ? "UNCERTAIN" : "FAILED",
        lastError: `SLACK_HTTP_${Number(response.status) || 0}`,
      } });
    }
  }

  async function tick() {
    if (busy || !validateSettings(settings)) return;
    busy = true;
    try {
      const cursor = await initialize();
      await observe(cursor);
      await db.slackCorrectionNotification.updateMany({ where: { state: "SENDING", attemptedAt: { lt: new Date(now().getTime() - 30000) } },
        data: { state: "UNCERTAIN", lastError: "DELIVERY_UNCERTAIN" } });
      const event = await db.slackCorrectionNotification.findFirst({ where: { state: "PENDING", nextSendAt: { lte: now() } }, orderBy: { id: "asc" } });
      if (!event) return;
      // Shared reservation also respects the one-message/second limit with several server instances.
      const slot = await db.slackCorrectionCursor.updateMany({ where: { id: CURSOR_ID, nextSendAt: { lte: now() } },
        data: { nextSendAt: new Date(now().getTime() + 1000) } });
      if (slot.count) await deliver(event);
    } finally { busy = false; }
  }

  return { tick, deliver, observeReply };
}

let worker;
function getWorker() {
  if (!worker) worker = createSlackCorrections({ db: require("../lib/prisma"), settings: require("../config").slack });
  return worker;
}

function startSlackCorrectionWorker() {
  if (!validateSettings(require("../config").slack)) return () => {};
  const poll = () => getWorker().tick().catch(() => console.warn("No se pudo observar la cola de Slack; revisar configuración, migración y conectividad."));
  const timer = setInterval(poll, 1000);
  timer.unref?.();
  poll();
  return () => clearInterval(timer);
}

async function getSlackCorrectionStatus() {
  const settings = require("../config").slack;
  const configured = validateSettings({ ...settings, enabled: true });
  if (!settings.enabled || !configured) return { enabled: settings.enabled, configured, includeReply: settings.includeReply, observerInitialized: false };
  const db = require("../lib/prisma");
  const cursor = await db.slackCorrectionCursor.findUnique({ where: { id: CURSOR_ID } });
  const notifications = await db.slackCorrectionNotification.findMany({ orderBy: { id: "desc" }, take: 50,
    select: { id: true, watchId: true, kind: true, state: true, attempts: true, sentAt: true, lastError: true, createdAt: true } });
  return { enabled: true, configured, includeReply: settings.includeReply, observerInitialized: Boolean(cursor), startedAt: cursor?.startedAt || null, notifications };
}

module.exports = { createSlackCorrections, isTimeCorrection, actionObservation, validateSettings,
  renderPayload, getSlackCorrectionStatus, startSlackCorrectionWorker };
