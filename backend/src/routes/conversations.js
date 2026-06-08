const express = require("express");
const prisma = require("../lib/prisma");
const { sendTextMessage } = require("../services/waba");

const router = express.Router();

router.get("/", async (req, res) => {
  const userType = req.query.userType ? String(req.query.userType).toUpperCase() : undefined;

  const conversations = await prisma.conversation.findMany({
    where: userType ? { userType } : undefined,
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    include: {
      messages: {
        orderBy: { timestamp: "desc" },
        take: 1,
      },
    },
  });

  res.json(conversations);
});

router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID invalido" });

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { timestamp: "asc" } },
      actions: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!conversation) return res.status(404).json({ error: "Conversacion no encontrada" });
  res.json(conversation);
});

router.post("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const content = String(req.body?.content || "").trim();

  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID invalido" });
  if (!content) return res.status(400).json({ error: "Mensaje requerido" });

  const conversation = await prisma.conversation.findUnique({ where: { id } });
  if (!conversation) return res.status(404).json({ error: "Conversacion no encontrada" });

  let sent = null;
  try {
    sent = await sendTextMessage(conversation.phone, content);
  } catch (error) {
    console.error("No se pudo enviar mensaje WhatsApp:", error.response?.data || error.message);
    return res.status(502).json({ error: "No se pudo enviar por WhatsApp" });
  }

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      phone: conversation.phone,
      content,
      aiMetadata: {
        manual: true,
        providerMessageId: sent?.messages?.[0]?.id || null,
      },
      timestamp: new Date(),
    },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: message.timestamp },
  });

  res.status(201).json({ sent, message });
});

module.exports = router;
