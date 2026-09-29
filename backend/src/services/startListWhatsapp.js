const crypto = require("node:crypto");
const axios = require("axios");
const config = require("../config");
const { Prisma } = require("@prisma/client");
const { analyzeStartList, reanalyzeStartList } = require("./startListAnalysis");
const { analyzeStartListPlan, resolveConversationAnswers } = require("./startListAi");
const access = require("./startListWhatsappAccess");

const enabled = () => process.env.START_LIST_WHATSAPP_ENABLED === "true" && process.env.START_LIST_IMPORTS_ENABLED === "true";

function key() {
  const encoded = String(process.env.START_LIST_WHATSAPP_ENCRYPTION_KEY || "").trim();
  const value = Buffer.from(encoded, "base64");
  if (value.length !== 32 || value.toString("base64") !== encoded) throw new Error("La vinculación de importaciones no está configurada.");
  return value;
}

function senderHash(sender) {
  const value = String(sender || "").trim();
  if (!value || value.length > 160) throw new Error("El remitente de WhatsApp no es válido.");
  return crypto.createHmac("sha256", key()).update(`start-list-whatsapp:${value}`).digest("hex");
}
function encryptToken(token, hash) {
  if (typeof token !== "string" || !token || token.length > 4096 || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("La vinculación recibida no es válida.");
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(hash));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
}
function decryptToken(value, hash) {
  if (typeof value !== "string" || value.length > 6000 || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Vuelve a vincular WhatsApp desde Timing.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length <= 28 || bytes.toString("base64") !== value) throw new Error("Vuelve a vincular WhatsApp desde Timing.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(hash)); decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}

function validMetaSignature(rawBody, signature, secret = process.env.META_APP_SECRET) {
  if (!secret || !Buffer.isBuffer(rawBody) || !/^sha256=[a-f0-9]{64}$/.test(signature || "")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature.slice(7), "hex"), Buffer.from(expected, "hex"));
}

async function channelRequest(path, { token, phoneHash, body, method = "POST" } = {}) {
  const allowed = { redeem: ["POST"], batch: ["GET", "PATCH"], catalog: ["GET"], preview: ["POST"], commit: ["POST"], revoke: ["POST"] };
  if (!allowed[path]?.includes(method)) throw new Error("Operación del canal no permitida.");
  const internal = process.env.START_LIST_REGISTRATION_INTERNAL_TOKEN;
  if (!internal || !config.raceline.baseUrl) throw new Error("El canal de importación no está configurado.");
  const { data } = await axios.request({ method, url: `${config.raceline.baseUrl}/registration/api/v1/timing-imports/channel/${path}`,
    headers: { "X-Internal-Service-Token": internal, ...(token ? { "X-Import-Channel-Token": token, "X-Import-Phone-Hash": phoneHash } : {}) },
    data: body, timeout: 180000, maxContentLength: 64 * 1024 * 1024, maxBodyLength: 64 * 1024 * 1024, maxRedirects: 0 });
  return data;
}

function batchRows(analysis, competitionId) {
  return (analysis.candidates || []).map(candidate => {
    const value = candidate.values || {}, dorsal = String(value.dorsal || "").trim();
    return { row_key: candidate.id, source_ref: { sheet: candidate.source.sheetName, row: candidate.source.row }, payload: {
      competition_id: competitionId, event_id: candidate.eventId, category_mode: candidate.categoryMode,
      category_policy_version: candidate.policyVersion ?? 0, category_id: candidate.categoryId,
      participant: { first_name: value.firstName || null, last_name: value.lastName || null,
        display_name: value.fullName || [value.firstName, value.lastName].filter(Boolean).join(" "),
        birth_date: value.birthDate || null, gender: value.gender || "", document_number: value.document || null,
        email: value.email || null, phone: value.phone || null, club: value.club || null },
      dorsal: dorsal ? /^\d+$/.test(dorsal) ? Number(dorsal) : dorsal : null, chip: value.chip || null,
      salida: value.start || null, supplied_category_name: candidate.suppliedCategoryName || null,
      document: { _startlist_source: { sheet: candidate.source.sheetName, row: candidate.source.row } },
    }};
  });
}

const blocked = candidate => (candidate?.issues || []).some(issue => issue.severity === "error");
const state = batch => batch.metadata?.start_list || {};

function preserveAttemptedAnalysis(updated, previous, rows) {
  const attempted = new Set(rows.filter(row => row.attempted).map(row => row.row_key));
  if (!attempted.size) return updated;
  const old = new Map((previous?.candidates || []).filter(row => attempted.has(row.id)).map(row => [row.id, row]));
  const candidates = (updated.candidates || []).filter(row => !attempted.has(row.id));
  candidates.push(...old.values());
  const excludedRows = (updated.excludedRows || []).filter(row => !attempted.has(row.id));
  const unassignedRows = (updated.unassignedRows || []).filter(row => !attempted.has(row.id));
  const questions = (updated.questions || []).map(question => ({ ...question, rowIds: (question.rowIds || []).filter(id => !attempted.has(id)) }))
    .filter(question => question.type === "column" || question.rowIds.length);
  return { ...updated, candidates, excludedRows, unassignedRows, questions,
    summary: { ...updated.summary, candidates: candidates.length, excluded: excludedRows.length, unassigned: unassignedRows.length,
      pending: candidates.filter(row => row.status === "pending").length,
      ready: candidates.filter(row => row.status !== "pending").length } };
}

function confirmationCommand(batch, rowKeys = [], nonce = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.createHash("sha256").update(JSON.stringify([batch.id, batch.version, batch.preview_token, rowKeys, nonce])).digest("hex").slice(0, 32).toUpperCase();
  return `CONFIRMAR ${batch.id.slice(0, 8).toUpperCase()} V${batch.version} ${digest}`;
}

function matchesConfirmation(value, expected) {
  if (typeof expected !== "string" || !/^CONFIRMAR [A-F0-9]{8} V\d+ [A-F0-9]{32}$/.test(expected)) return false;
  const actual = Buffer.from(String(value).toUpperCase()), target = Buffer.from(expected);
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}

function selectionHash(batch, rowKeys) {
  const rows = new Map(batch.rows.map(row => [row.row_key, row]));
  return crypto.createHash("sha256").update(JSON.stringify({ id: batch.id, version: batch.version,
    previewToken: batch.preview_token, rows: rowKeys.map(key => ({ key, payload: rows.get(key)?.payload,
      assignment: rows.get(key)?.validation?.assignment || null })) })).digest("hex");
}

function renderReview(batch) {
  const analysis = state(batch).analysis || {};
  const candidates = new Map((analysis.candidates || []).map(row => [row.id, row]));
  const authorized = new Set(batch.preview_row_keys || []);
  const ready = batch.rows.filter(row => row.status === "ready" && authorized.has(row.row_key) && candidates.has(row.row_key) && !blocked(candidates.get(row.row_key)));
  const existing = ready.filter(row => row.validation?.assignment?.status === "existing");
  const imported = batch.rows.filter(row => row.status === "imported");
  const pending = batch.rows.filter(row => !["ready", "imported"].includes(row.status) || blocked(candidates.get(row.row_key)));
  const unassigned = analysis.unassignedRows?.length || 0;
  const questions = (analysis.questions || []).filter(question => !question.resolved && question.required && question.options?.length).slice(0, 3);
  const readyKeys = ready.map(row => row.row_key);
  const command = readyKeys.length ? confirmationCommand(batch, readyKeys) : null;
  const parts = [`Competencia ${batch.competition_id} · propuesta V${batch.version}.`,
    `${batch.rows.length} participantes: ${ready.length - existing.length} listos, ${existing.length} ya existentes, ${imported.length} procesados y ${pending.length} pendientes.`,
    `${analysis.excludedRows?.length || 0} filas de cabecera/resumen excluidas; ${unassigned} filas del archivo pendientes de revisar.`];
  for (const question of questions) parts.push(`${question.title} (${question.rowIds.length} filas, valor «${String(question.sourceValue || "vacío").slice(0, 90)}»). Opciones: ${question.options.slice(0, 8).map(option => option.label).join(" / ")}.`);
  if (ready.length) parts.push(`Para importar únicamente las ${ready.length} filas listas y dejar las demás pendientes, escribe exactamente: ${command}`);
  else parts.push("Resuelve las preguntas o abre el borrador en Start List de Timing para corregir y validar las filas.");
  parts.push("Puedes escribir ESTADO para actualizar el resumen o CANCELAR IMPORTACION para cerrar esta vinculación.");
  return { text: parts.join("\n\n"), readyKeys, command };
}

async function handleStartListInbound(input, dependencies = {}) {
  if (!enabled()) return null;
  const prisma = dependencies.prisma || require("../lib/prisma");
  const registeredMode = access.authMode() === "registered_timer";
  const { content, link, spreadsheet, requested } = access.startListInput(input);
  let timer = null;
  if (registeredMode) {
    if (input.authorization?.mode !== "registered_timer") return requested ? { handled: true, denied: true } : null;
    timer = await access.findActiveTimer(prisma, input.phone);
    if (!timer || input.authorization.phone !== timer.phone || input.authorization.timerContactId !== timer.id) return { handled: true, denied: true };
    input = { ...input, phone: timer.phone, whatsappUserId: null };
  } else if (input.verified !== true) return null;
  const waba = dependencies.waba || require("./waba");
  const request = dependencies.request || channelRequest;
  const analyze = dependencies.analyze || analyzeStartList;
  const reanalyze = dependencies.reanalyze || reanalyzeStartList;
  const resolve = dependencies.resolve || resolveConversationAnswers;
  const clock = dependencies.now || (() => new Date());
  const dbNull = dependencies.dbNull || Prisma.DbNull;
  const leaseMs = 5 * 60 * 1000;
  const now = clock();
  const hash = senderHash(input.whatsappUserId || input.phone);
  let session = await prisma.startListWhatsappSession.findUnique({ where: { phoneHash: hash } });
  if (!session && !requested) return null;
  if (!(dependencies.allowRequest || access.allowImportRequest)(hash, clock().getTime())) return { handled: true, rateLimited: true };
  if (input.waId && await prisma.message.findUnique({ where: { waId: input.waId } })) return { duplicated: true };
  let inbound;
  try {
    inbound = await prisma.message.create({ data: {
      conversationId: input.conversation.id, waId: input.waId, direction: "INBOUND", phone: input.phone,
      whatsappUserId: input.whatsappUserId || null, contentType: spreadsheet ? "DOCUMENT" : "TEXT",
      content: link ? "[Vinculación de Start List]" : access.redactConfirmation(content) || "[Start List recibida]",
      mediaFilename: spreadsheet ? input.media?.filename : null,
      timestamp: input.timestamp || now, aiMetadata: { source: "start_list_whatsapp", handled: true },
    } });
  } catch (error) {
    if (input.waId && error.code === "P2002") return { duplicated: true };
    throw error;
  }
  async function requireActiveTimer() {
    if (!registeredMode) return;
    const current = await access.findActiveTimer(prisma, timer.phone);
    if (!current || current.id !== timer.id) throw Object.assign(new Error("El cronometrador ya no está habilitado."), { code: "timer_not_active" });
  }
  async function reply(text) {
    try { await requireActiveTimer(); } catch { return { handled: true, denied: true }; }
    const body = text.slice(0, 3900);
    const recordedBody = access.redactConfirmation(body);
    let sent;
    try { sent = await waba.sendTextMessage(input.whatsappUserId || input.phone, body); }
    catch { return { handled: true, conversationId: input.conversation.id, deliveryFailed: true }; }
    try {
      await prisma.message.create({ data: { conversationId: input.conversation.id, direction: "OUTBOUND", phone: input.phone,
        whatsappUserId: input.whatsappUserId || null, content: recordedBody,
        aiMetadata: { source: "start_list_whatsapp", inboundId: inbound.id, providerMessageId: sent?.messages?.[0]?.id || null } } });
    } catch {
      // The provider may already have delivered the reply. Do not send it twice
      // merely because local delivery bookkeeping failed.
      return { handled: true, conversationId: input.conversation.id, reply: recordedBody, deliveryRecorded: false };
    }
    return { handled: true, conversationId: input.conversation.id, reply: recordedBody };
  }

  // Linking also participates in the sender lease. A second VINCULAR must not
  // replace a bearer while another command is importing under the old grant.
  if (link && !session) {
    session = await prisma.startListWhatsappSession.upsert({ where: { phoneHash: hash },
      create: { phoneHash: hash, batchId: "pending-link", encryptedToken: "", expiresAt: now }, update: {} });
  }
  if (!session) return reply("Para importar participantes, abre Start List en Timing, pulsa Continuar en WhatsApp y envíame el comando VINCULAR con su código. Así usaré la competencia y los permisos de tu cuenta.");

  let leaseUntil = new Date(clock().getTime() + leaseMs + crypto.randomInt(1, 1000));
  const lease = await prisma.startListWhatsappSession.updateMany({ where: { phoneHash: hash,
    batchId: session.batchId, encryptedToken: session.encryptedToken,
    OR: [{ processingUntil: null }, { processingUntil: { lt: clock() } }] }, data: { processingUntil: leaseUntil } });
  if (!lease.count) return reply("Estoy procesando tu propuesta anterior. Espera a su resumen y vuelve a enviar la respuesta.");
  let leaseLost = false;
  let leaseClosed = false;
  let renewing = Promise.resolve();
  const ownerWhere = () => ({ phoneHash: hash, batchId: session.batchId, encryptedToken: session.encryptedToken, processingUntil: leaseUntil });
  const withOwner = operation => {
    renewing = renewing.then(async () => {
      if (leaseLost) throw new Error("La sesión cambió durante la operación.");
      if (leaseClosed) return;
      return operation();
    });
    return renewing;
  };
  const refreshLease = async () => {
    const next = new Date(clock().getTime() + leaseMs + crypto.randomInt(1, 1000));
    const updated = await prisma.startListWhatsappSession.updateMany({ where: ownerWhere(), data: { processingUntil: next } });
    if (updated.count !== 1) { leaseLost = true; throw new Error("La sesión cambió durante la operación."); }
    leaseUntil = next;
  };
  const renewLease = () => withOwner(refreshLease);
  const heartbeat = setInterval(() => { renewLease().catch(() => { leaseLost = true; }); }, dependencies.heartbeatMs || 60000);
  heartbeat.unref?.();
  const writeSession = data => withOwner(async () => {
    await refreshLease();
    const updated = await prisma.startListWhatsappSession.updateMany({ where: ownerWhere(), data });
    if (updated.count !== 1) { leaseLost = true; throw new Error("La sesión cambió durante la operación."); }
    session = { ...session, ...Object.fromEntries(Object.entries(data).map(([name, value]) => [name, value === dbNull ? null : value])) };
  });
  const removeSession = () => withOwner(async () => {
    await refreshLease();
    await prisma.startListWhatsappSession.deleteMany({ where: ownerWhere() });
    leaseClosed = true;
  });
  let wroteCommit = false;
  try {
    if (link) {
      await requireActiveTimer();
      const redeemed = await request("redeem", { body: { code: link[1].toUpperCase(), phone_hash: hash } });
      const expiration = new Date(redeemed.expires_at);
      if (typeof redeemed.batch_id !== "string" || !redeemed.batch_id || !Number.isFinite(expiration.getTime()) || expiration <= clock()) throw new Error("Vinculación inválida.");
      const encryptedToken = encryptToken(redeemed.token, hash);
      await writeSession({ batchId: redeemed.batch_id, encryptedToken, expiresAt: expiration, pendingConfirmation: dbNull });
      session = { ...session, batchId: redeemed.batch_id, encryptedToken, expiresAt: expiration, pendingConfirmation: null };
      return await reply("WhatsApp vinculado al borrador de Timing. Envía tu Excel o CSV para analizarlo, o escribe ESTADO si ya cargaste el archivo. La vinculación dura hasta una hora y respeta los permisos actuales de tu cuenta.");
    }
    if (!Number.isFinite(new Date(session.expiresAt).getTime()) || new Date(session.expiresAt) <= clock()) {
      await removeSession();
      return await reply("La vinculación expiró. Genera un nuevo código desde Start List en Timing para continuar con el mismo borrador.");
    }
    if (new Date(session.pendingConfirmation?.lockedUntil).getTime() > clock().getTime()) {
      return await reply("La confirmación quedó bloqueada por varios intentos inválidos. Espera cinco minutos y escribe ESTADO, o revisa el borrador desde Timing.");
    }
    // Decryption belongs inside try/finally so a bad ciphertext cannot strand a
    // lease until its timeout. No token or participant value is ever logged.
    let token;
    try { token = decryptToken(session.encryptedToken, hash); }
    catch {
      await removeSession();
      return await reply("No pude recuperar la vinculación. Vuelve a vincular WhatsApp desde Start List en Timing.");
    }
    const channel = async (path, body, method = "POST") => {
      await renewLease();
      if (new Date(session.expiresAt) <= clock()) throw Object.assign(new Error("Vinculación expirada."), { response: { status: 401 } });
      await requireActiveTimer();
      const result = await request(path, { token, phoneHash: hash, body, method });
      await renewLease();
      return result;
    };
    let batch = await channel("batch", undefined, "GET");
    if (batch.id !== session.batchId) throw new Error("La respuesta no corresponde al borrador vinculado.");
    if (/^CANCELAR\s+IMPORTACI[OÓ]N$/i.test(content)) {
      await channel("revoke", {});
      await removeSession();
      return await reply("Vinculación cerrada. El borrador y las filas ya importadas permanecen disponibles en Timing.");
    }
    const confirmation = session.pendingConfirmation;
    if (/^CONFIRMAR\b/i.test(content)) {
      const keys = confirmation?.rowKeys;
      const candidates = new Map((state(batch).analysis?.candidates || []).map(row => [row.id, row]));
      const current = new Map(batch.rows.map(row => [row.row_key, row]));
      const authorized = new Set(batch.preview_row_keys || []);
      const validSelection = Array.isArray(keys) && keys.length > 0 && keys.length <= 10000 && new Set(keys).size === keys.length
        && keys.every(key => typeof key === "string" && authorized.has(key) && current.get(key)?.status === "ready"
          && candidates.has(key) && !blocked(candidates.get(key)));
      const expiration = new Date(confirmation?.expiresAt).getTime();
      if (!confirmation || !matchesConfirmation(content, confirmation.command) || confirmation.batchId !== batch.id
          || confirmation.version !== batch.version || !batch.preview_token || confirmation.previewToken !== batch.preview_token
          || !Number.isFinite(expiration) || expiration <= clock().getTime() || !validSelection
          || confirmation.selectionHash !== selectionHash(batch, keys)) {
        const failedAttempts = Math.min(5, (Number(confirmation?.failedAttempts) || 0) + 1);
        await writeSession({ pendingConfirmation: failedAttempts >= 5
          ? { failedAttempts, lockedUntil: new Date(Math.min(clock().getTime() + 5 * 60000, new Date(session.expiresAt).getTime())).toISOString() }
          : { ...confirmation, failedAttempts } });
        return await reply("La confirmación no corresponde a la propuesta vigente. Escribe ESTADO para revisar el resumen y obtener su comando actual.");
      }
      // Consume before the first write. If HTTP times out after materialization,
      // an identical message cannot trigger an automatic retry of the batch.
      await writeSession({ pendingConfirmation: dbNull });
      for (let offset = 0; offset < keys.length; offset += 100) {
        wroteCommit = true;
        batch = await channel("commit", { expected_version: confirmation.version,
          preview_token: confirmation.previewToken, row_keys: keys.slice(offset, offset + 100) });
      }
    } else if (spreadsheet) {
      if (batch.rows.some(row => row.attempted)) return await reply("Este borrador ya tiene filas enviadas a Timing. Para cargar otro archivo, inicia una nueva vinculación desde Start List. Puedes escribir ESTADO para revisar este envío.");
      await writeSession({ pendingConfirmation: dbNull });
      const catalog = await channel("catalog", undefined, "GET");
      const media = await waba.downloadMedia(input.media.id, { maxBytes: 10 * 1024 * 1024 });
      await renewLease();
      const analysis = await analyze({ buffer: media.buffer, filename: input.media.filename,
        mimeType: input.media.mimeType || media.mimeType, catalog, planAnalyzer: analyzeStartListPlan });
      await renewLease();
      const { sourceRows: _source, workbook: _workbook, ...stored } = analysis;
      batch = await channel("batch", { expected_version: batch.version, rows: batchRows(analysis, batch.competition_id),
        metadata: { start_list: { analysis: stored, catalog, decisions: {}, messages: [
          { id: `wa-${inbound.id}`, role: "assistant", content: "Archivo recibido desde WhatsApp. Revisa las asignaciones antes de importar." },
        ] } } }, "PATCH");
    } else if (!/^ESTADO$/i.test(content)) {
      const previous = state(batch);
      if (!previous.analysis?.sourceWorkbook) return await reply("Envía el archivo Excel o CSV para empezar el análisis de esta importación.");
      await writeSession({ pendingConfirmation: dbNull });
      const catalog = await channel("catalog", undefined, "GET");
      // Choices stored in yesterday's metadata are not authoritative. Rebuild
      // them using today's scoped catalog before interpreting a reply.
      const currentAnalysis = preserveAttemptedAnalysis(reanalyze({ sourceWorkbook: previous.analysis.sourceWorkbook,
        plan: previous.analysis.plan, decisions: previous.decisions || {}, catalog }), previous.analysis, batch.rows);
      let answers;
      try { answers = await resolve({ message: access.redactConfirmation(content), questions: currentAnalysis.questions || [], catalog }); }
      catch { answers = { answers: [], clarification: "No pude resolver esa respuesta de forma segura. Abre el borrador en Timing para seleccionar la opción." }; }
      await renewLease();
      const decisions = { ...previous.decisions };
      for (const answer of answers.answers || []) {
        const question = currentAnalysis.questions.find(item => item.id === answer.questionId);
        if (question?.options.some(option => option.id === answer.optionId)) decisions[answer.questionId] = answer.optionId;
      }
      const analysis = preserveAttemptedAnalysis(reanalyze({ sourceWorkbook: previous.analysis.sourceWorkbook, plan: currentAnalysis.plan, decisions, catalog }), previous.analysis, batch.rows);
      const { sourceRows: _source, workbook: _workbook, ...stored } = analysis;
      const rows = new Map(batchRows(analysis, batch.competition_id).map(row => [row.row_key, row]));
      for (const row of batch.rows.filter(row => row.attempted)) rows.set(row.row_key, { row_key: row.row_key, source_ref: row.source_ref, payload: row.payload });
      batch = await channel("batch", { expected_version: batch.version, rows: [...rows.values()], metadata: { start_list: {
        analysis: stored, decisions, catalog, messages: [...(previous.messages || []).slice(-46),
          { id: `wa-user-${inbound.id}`, role: "user", content: access.redactConfirmation(content) },
          { id: `wa-agent-${inbound.id}`, role: "assistant", content: answers.clarification || "Actualicé las asignaciones de la propuesta." }],
      } } }, "PATCH");
    }
    const candidates = new Map((state(batch).analysis?.candidates || []).map(row => [row.id, row]));
    const pending = batch.rows.filter(row => candidates.has(row.row_key) && !blocked(candidates.get(row.row_key))
      && ((!row.attempted && row.status === "pending") || (/^ESTADO$/i.test(content) && row.attempted && ["failed", "ready"].includes(row.status))));
    for (let offset = 0; offset < pending.length; offset += 100) {
      batch = await channel("preview", { expected_version: batch.version, row_keys: pending.slice(offset, offset + 100).map(row => row.row_key) });
    }
    const review = renderReview(batch);
    const expiry = Math.min(clock().getTime() + 15 * 60 * 1000, new Date(session.expiresAt).getTime());
    await writeSession({ pendingConfirmation: review.readyKeys.length ? {
      batchId: batch.id, version: batch.version, previewToken: batch.preview_token,
      rowKeys: review.readyKeys, command: review.command, selectionHash: selectionHash(batch, review.readyKeys),
      expiresAt: new Date(expiry).toISOString(), failedAttempts: 0,
    } : dbNull });
    return await reply(review.text);
  } catch (error) {
    if (error.code === "timer_not_active") {
      await removeSession().catch(() => {});
      return { handled: true, denied: true };
    }
    if (link) return await reply("No pude vincular ese código. Genera uno nuevo desde Start List en Timing y envía VINCULAR seguido del código.");
    if (error.code === "analysis_busy") return await reply("Hay otro archivo en análisis. Espera unos segundos y vuelve a enviar tu archivo. El borrador anterior sigue guardado.");
    const status = error.response?.status;
    if ([401, 403].includes(status) && !leaseLost) {
      await removeSession().catch(() => {});
      return await reply("La vinculación o los permisos de Timing ya no están vigentes. Vuelve a vincular tu cuenta desde Start List.");
    }
    return await reply(wroteCommit
      ? "No pude comprobar el final del envío. No volveré a enviarlo automáticamente. Escribe ESTADO para consultar los recibos antes de confirmar una selección nueva, o abre el borrador en Timing."
      : "No pude completar la operación. Escribe ESTADO para consultar lo que quedó guardado, o abre el borrador en Timing para revisar las opciones.");
  } finally {
    clearInterval(heartbeat);
    await renewing.catch(() => {});
    if (!leaseLost && !leaseClosed) await prisma.startListWhatsappSession.updateMany({ where: ownerWhere(), data: { processingUntil: null } }).catch(() => {});
  }
}
module.exports = { enabled, validMetaSignature, handleStartListInbound, channelRequest,
  batchRows, renderReview, confirmationCommand, matchesConfirmation, selectionHash, preserveAttemptedAnalysis, encryptToken, decryptToken, senderHash };
