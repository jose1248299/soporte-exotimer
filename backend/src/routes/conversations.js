const express = require("express");
const prisma = require("../lib/prisma");
const { Prisma } = require("@prisma/client");
const outbox = require("../services/whatsappOutbox");
const { enrichMessages } = require("../services/whatsappDelivery");

const router = express.Router();

const messageSelect = {
  id: true,
  conversationId: true,
  supportCaseId: true,
  competitionId: true,
  waId: true,
  direction: true,
  contentType: true,
  phone: true,
  whatsappUserId: true,
  content: true,
  mediaId: true,
  mediaMimeType: true,
  mediaSha256: true,
  mediaFilename: true,
  mediaAnalysis: true,
  aiMetadata: true,
  timestamp: true,
  createdAt: true,
  providerMessageId: true,
  deliveryStatus: true,
  deliveryError: true,
};

router.get("/", async (req, res) => {
  const userType = req.query.userType ? String(req.query.userType).toUpperCase() : undefined;

  const conversations = await prisma.conversation.findMany({
    where: userType ? { userType } : undefined,
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    include: {
      messages: {
        orderBy: { timestamp: "desc" },
        take: 1,
        select: messageSelect,
      },
    },
  });

  const messages = await enrichMessages(conversations.flatMap(c => c.messages));
  const byId = new Map(messages.map(m => [m.id, m]));
  res.json(conversations.map(c => ({ ...c, messages: c.messages.map(m => byId.get(m.id)) })));
});

router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID invalido" });

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { timestamp: "asc" }, select: messageSelect },
      actions: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!conversation) return res.status(404).json({ error: "Conversacion no encontrada" });
  conversation.messages = await enrichMessages(conversation.messages);
  res.json(conversation);
});

router.get("/messages/:messageId/media", async (req, res) => {
  const messageId = Number(req.params.messageId);
  if (!Number.isInteger(messageId)) return res.status(400).json({ error: "ID invalido" });

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      mediaData: true,
      mediaMimeType: true,
      mediaFilename: true,
    },
  });

  if (!message?.mediaData) return res.status(404).json({ error: "Media no encontrado" });

  res.setHeader("Content-Type", message.mediaMimeType || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (message.mediaFilename) {
    res.setHeader("Content-Disposition", `inline; filename="${message.mediaFilename.replace(/"/g, "")}"`);
  }
  res.send(Buffer.from(message.mediaData));
});

router.post("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const content = String(req.body?.content || "").trim();

  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID invalido" });
  if (!content) return res.status(400).json({ error: "Mensaje requerido" });

  const conversation = await prisma.conversation.findUnique({ where: { id } });
  if (!conversation) return res.status(404).json({ error: "Conversacion no encontrada" });

  if (conversation.channel !== "WHATSAPP") return res.status(400).json({ error: "Esta conversacion no es de WhatsApp" });

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      phone: conversation.phone,
      whatsappUserId: conversation.whatsappUserId || null,
      content,
      deliveryStatus: "QUEUED",
      nextSendAt: new Date(),
      aiMetadata: {
        manual: true,
      },
      timestamp: new Date(),
    },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: message.timestamp },
  });

  const delivered = await outbox.deliver(message.id).catch(() => null);
  res.status(201).json({ message: delivered || message });
});

router.post("/:id/messages/:messageId/retry", async (req, res) => {
  const id = Number(req.params.id);
  const messageId = Number(req.params.messageId);
  if (!Number.isInteger(id) || !Number.isInteger(messageId)) return res.status(400).json({ error: "ID invalido" });
  const message = await prisma.message.findUnique({ where: { id: messageId }, include: { conversation: true } });
  if (!message || message.conversationId !== id) return res.status(404).json({ error: "Mensaje no encontrado" });
  if (message.conversation.channel !== "WHATSAPP" || message.direction !== "OUTBOUND" || message.contentType !== "TEXT"
    || !["FAILED", "EXPIRED"].includes(message.deliveryStatus) || message.aiMetadata?.source === "start_list_whatsapp") {
    return res.status(409).json({ error: "No se puede reintentar este mensaje sin riesgo de duplicarlo" });
  }
  const claimed = await prisma.message.updateMany({ where: { id: messageId, deliveryStatus: message.deliveryStatus },
    data: { deliveryStatus: "QUEUED", nextSendAt: new Date(), sendAttempts: 0, deliveryError: Prisma.DbNull } });
  if (!claimed.count) return res.status(409).json({ error: "El mensaje ya esta siendo procesado" });
  const result = await outbox.deliver(messageId).catch(() => null);
  res.json({ message: result || await prisma.message.findUnique({ where: { id: messageId } }) });
});

module.exports = router;
