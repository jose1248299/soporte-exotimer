const express = require("express");
const crypto = require("node:crypto");
const config = require("../config");
const { analyzeStartList, reanalyzeStartList } = require("../services/startListAnalysis");
const { analyzeStartListPlan, resolveConversationAnswers } = require("../services/startListAi");

const router = express.Router();
const active = new Set();
const starts = new Map();
const enabled = () => process.env.START_LIST_IMPORTS_ENABLED === "true";

function requireTrustedCaller(req, res, next) {
  if (!enabled()) return res.status(503).json({ error: "El asistente de importación está deshabilitado." });
  const expected = Buffer.from(config.security.exotimerApiKey || "");
  const actual = Buffer.from(req.get("x-support-api-key") || "");
  if (!expected.length || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return res.status(403).json({ error: "Canal no autorizado." });
  }
  next();
}

router.use(requireTrustedCaller);
router.use(express.json({ limit: "15mb" }));

function catalogFrom(value) {
  if (!value || !Number.isSafeInteger(value.competitionId) || value.competitionId < 1
    || !Array.isArray(value.events) || !value.events.length || value.events.length > 500) {
    throw new Error("La competencia debe tener distancias configuradas.");
  }
  if (value.events.some(event => !Number.isSafeInteger(event.id) || typeof event.name !== "string"
    || !["basic", "detailed"].includes(event.categoryMode) || !Array.isArray(event.categories) || !Array.isArray(event.starts))) {
    throw new Error("No se pudo comprobar la configuración de la competencia.");
  }
  return value;
}

async function limited(req, res, run) {
  const key = String(req.get("x-startlist-operator") || "");
  if (!/^[a-f0-9]{64}$/.test(key)) return res.status(400).json({ error: "Falta el contexto del operador." });
  const usesAi = req.path === "/analyze" || (typeof req.body?.message === "string" && Boolean(req.body.message.trim()));
  const quotaKey = `${key}:${usesAi ? "ai" : "manual"}`;
  const now = Date.now();
  for (const [item, times] of starts) if (times.every(time => time < now - 900000)) starts.delete(item);
  const times = (starts.get(quotaKey) || []).filter(time => time > now - 900000);
  if (active.has(key) || active.size >= 4 || times.length >= (usesAi ? 12 : 120) || (starts.size >= 2000 && !starts.has(quotaKey))) return res.status(429).set("Retry-After", "60").json({ error: "Espera a que termine el análisis antes de continuar." });
  active.add(key); starts.set(quotaKey, [...times, now]);
  try { res.set("Cache-Control", "no-store").json(await run()); }
  catch (error) {
    if (error.code === "analysis_busy") return res.status(429).set("Retry-After", "10").json({ error: error.message, code: error.code });
    const known = error.name === "StartListAnalysisError" || error.name === "ZodError";
    res.status(known ? 422 : 400).json({ error: known ? error.message : "No se pudo analizar la propuesta. Revisa el archivo y la configuración.", code: error.code || "START_LIST_ANALYSIS_FAILED" });
  } finally { active.delete(key); }
}

router.post("/analyze", (req, res) => limited(req, res, async () => {
  const { file, catalog } = req.body || {};
  if (!file || typeof file.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
      || file.data.length > 14 * 1024 * 1024 || typeof file.name !== "string") throw new Error("Archivo inválido.");
  return analyzeStartList({ buffer: Buffer.from(file.data, "base64"), filename: file.name.slice(0, 255),
    mimeType: String(file.mimeType || ""), catalog: catalogFrom(catalog), planAnalyzer: analyzeStartListPlan });
}));

router.post("/resolve", (req, res) => limited(req, res, async () => {
  const { sourceWorkbook, plan, decisions = {}, questions = [], message = "", catalog } = req.body || {};
  if (!sourceWorkbook || typeof decisions !== "object" || Array.isArray(decisions)
    || typeof message !== "string" || message.length > 4000 || !Array.isArray(questions) || questions.length > 10000) throw new Error("Propuesta inválida.");
  const trustedCatalog = catalogFrom(catalog);
  // Recompute choices from the stored source and the current catalog; a caller's
  // question text/option list is never authoritative for a conversational edit.
  const current = reanalyzeStartList({ sourceWorkbook, plan, decisions, catalog: trustedCatalog });
  let reply = null;
  if (message.trim()) {
    try { reply = await resolveConversationAnswers({ message, questions: current.questions, catalog: trustedCatalog }); }
    catch {
      reply = { answers: [], clarification: "No pude resolver esa respuesta de forma segura. Selecciona la opción en la tabla." };
    }
  }
  const proposed = reply?.answers || [];
  const next = { ...decisions };
  for (const answer of proposed) {
    const questionId = answer.questionId ?? answer.question_id;
    const optionId = answer.optionId ?? answer.option_id;
    const question = current.questions.find(item => item.id === questionId);
    if (question?.options?.some(option => option.id === optionId)) next[questionId] = optionId;
  }
  const analysis = await reanalyzeStartList({ sourceWorkbook, workbook: sourceWorkbook, plan, decisions: next, catalog: trustedCatalog });
  return { ...analysis, decisions: next, assistantMessage: reply?.clarification || null };
}));

module.exports = router;
module.exports.catalogFrom = catalogFrom;
