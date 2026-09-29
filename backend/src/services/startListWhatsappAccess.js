const crypto = require("node:crypto");
const { spreadsheetKind } = require("./startListWorkbook");

const authMode = () => process.env.START_LIST_WHATSAPP_AUTH_MODE === "registered_timer" ? "registered_timer" : "meta_signature";

// In the explicit trust mode, accept only Meta's numeric `message.from` field.
// Contact cards and business-scoped IDs supplied in an unsigned body cannot
// establish either the identity or the destination of an outbound challenge.
function registeredPhone(value) {
  return typeof value === "string" && /^[1-9][0-9]{7,14}$/.test(value) ? value : null;
}

async function findActiveTimer(prisma, value) {
  const phone = registeredPhone(value);
  if (!phone) return null;
  const contact = await prisma.timerContact.findFirst({ where: { phone, active: true }, select: { id: true, phone: true, active: true } });
  return contact?.active === true && contact.phone === phone ? contact : null;
}

function startListInput(input) {
  const content = String(input.text || "").trim();
  const normalized = content.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const importIntent = /\b(?:importar|importa|importacion|cargar|carga|subir|sube)\b.{0,80}\b(?:participantes|start[\s-]?list|listado|lista|excel|csv)\b/.test(normalized);
  const spreadsheet = input.type === "document" && spreadsheetKind(input.media?.filename, input.media?.mimeType);
  const control = /^(?:VINCULAR|CONFIRMAR|ESTADO|CANCELAR\s+IMPORTACI[OÓ]N)\b/i.test(content);
  return { content, importIntent, spreadsheet, control, requested: Boolean(importIntent || spreadsheet || control), link: /^VINCULAR\s+([A-F0-9]{20})$/i.exec(content) };
}

function isStartListMessage(message) {
  return message?.aiMetadata?.source === "start_list_whatsapp";
}

function redactConfirmation(value) {
  return String(value || "").replace(/\bCONFIRMAR\s+[A-F0-9]{8}\s+V\d+\s+[A-F0-9]{8,64}\b/gi, "CONFIRMAR [código privado enviado por WhatsApp]");
}

function createRequestLimiter({ windowMs = 60000, maxGlobal = 120, maxPerPhone = 12, minIntervalMs = 1000, maxPhones = 2000 } = {}) {
  let global = [];
  const phones = new Map();
  return (phone, now = Date.now()) => {
    const key = crypto.createHash("sha256").update(String(phone)).digest("hex");
    global = global.filter(time => time > now - windowMs);
    for (const [name, entry] of phones) if (entry.times.every(time => time <= now - windowMs)) phones.delete(name);
    const entry = phones.get(key) || { times: [] };
    entry.times = entry.times.filter(time => time > now - windowMs);
    if (global.length >= maxGlobal || entry.times.length >= maxPerPhone
      || (entry.times.length && now - entry.times.at(-1) < minIntervalMs)
      || (!phones.has(key) && phones.size >= maxPhones)) return false;
    entry.times.push(now); global.push(now); phones.set(key, entry);
    return true;
  };
}

// The cheap ingress bound precedes directory queries. The smaller operation
// bound is shared by signed and registered-timer import commands, before work.
const allowRegisteredIngress = createRequestLimiter({ maxGlobal: 300, maxPerPhone: 30, minIntervalMs: 500 });
const allowImportRequest = createRequestLimiter();

module.exports = { authMode, registeredPhone, findActiveTimer, startListInput, isStartListMessage, redactConfirmation, createRequestLimiter, allowRegisteredIngress, allowImportRequest };
