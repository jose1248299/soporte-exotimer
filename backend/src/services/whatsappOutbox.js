const prisma = require("../lib/prisma");
const { Prisma } = require("@prisma/client");
const { sendTextMessage } = require("./waba");
const { whatsappConversationRecipient } = require("../utils/whatsapp");
const { deliveryState, safeMetaErrors } = require("./whatsappDelivery");

const WINDOW_MS = 24 * 60 * 60 * 1000;

function classifySendError(error) {
  const status = error.response?.status;
  const details = safeMetaErrors([error.response?.data?.error || { message: error.message }]);
  // A lost response or server error may hide a successful send. Never automatically duplicate it.
  const state = status === 429 ? "QUEUED" : !status || status >= 500 || error.deliveryUnknown ? "UNKNOWN" : "FAILED";
  return { state, details };
}

function createOutbox({ db = prisma, send = sendTextMessage, now = () => new Date() } = {}) {
  async function deliver(messageId) {
    const time = now();
    const claim = await db.message.updateMany({
      where: { id: messageId, direction: "OUTBOUND", deliveryStatus: "QUEUED",
        OR: [{ nextSendAt: null }, { nextSendAt: { lte: time } }] },
      data: { deliveryStatus: "SENDING", sendLeaseUntil: new Date(time.getTime() + 120000), sendAttempts: { increment: 1 } },
    });
    if (!claim.count) return db.message.findUnique({ where: { id: messageId } });
    const message = await db.message.findUnique({ where: { id: messageId }, include: { conversation: true } });
    const inbound = await db.message.findFirst({ where: { conversationId: message.conversationId, direction: "INBOUND" }, orderBy: { timestamp: "desc" } });
    if (!inbound || time.getTime() - new Date(inbound.timestamp).getTime() >= WINDOW_MS) {
      return db.message.update({ where: { id: messageId }, data: { deliveryStatus: "EXPIRED", sendLeaseUntil: null,
        deliveryError: [{ title: "Ventana de WhatsApp cerrada", message: "Se requiere un nuevo mensaje del cliente o una plantilla aprobada." }] } });
    }
    let sent;
    try {
      sent = await send(whatsappConversationRecipient(message.conversation), message.content);
    } catch (error) {
      const { state, details } = classifySendError(error);
      const exhausted = state === "QUEUED" && message.sendAttempts >= 5;
      return db.message.update({ where: { id: messageId }, data: {
        deliveryStatus: exhausted ? "FAILED" : state, deliveryError: details, sendLeaseUntil: null,
        nextSendAt: state === "QUEUED" && !exhausted ? new Date(time.getTime() + 60000 * message.sendAttempts) : null,
      } });
    }
    const providerMessageId = sent.messages[0].id;
    // A persistence failure here is deliberately not treated as a send failure.
    // The expired SENDING lease becomes UNKNOWN instead of sending the message again.
    const record = await db.whatsappDelivery.findUnique({ where: { providerMessageId } });
    return db.message.update({ where: { id: messageId }, data: {
      providerMessageId, deliveryStatus: deliveryState(record) || "ACCEPTED", sendLeaseUntil: null, nextSendAt: null,
      deliveryError: deliveryState(record) === "FAILED" && record?.errors ? record.errors : Prisma.DbNull,
      aiMetadata: { ...(message.aiMetadata || {}), providerMessageId },
    } });
  }

  async function recover() {
    await db.message.updateMany({ where: { deliveryStatus: "SENDING", sendLeaseUntil: { lte: now() } },
      data: { deliveryStatus: "UNKNOWN", sendLeaseUntil: null } });
    const queued = await db.message.findMany({ where: { deliveryStatus: "QUEUED", direction: "OUTBOUND",
      OR: [{ nextSendAt: null }, { nextSendAt: { lte: now() } }] }, orderBy: { id: "asc" }, take: 20 });
    for (const message of queued) await deliver(message.id);
  }
  return { deliver, recover };
}

module.exports = { ...createOutbox(), createOutbox, classifySendError, WINDOW_MS };
