const express = require("express");
const prisma = require("../lib/prisma");
const { sendTextMessage } = require("../services/waba");
const {
  findOrCreateExotimerConversation,
  processInboundExotimerMessage,
} = require("../services/supportProcessor");

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
  content: true,
  mediaId: true,
  mediaMimeType: true,
  mediaSha256: true,
  mediaFilename: true,
  mediaAnalysis: true,
  aiMetadata: true,
  timestamp: true,
  createdAt: true,
};

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

function readUserContext(req) {
  const userId = String(req.query.userId || req.body?.userId || "").trim();
  const userName = String(req.query.userName || req.body?.userName || "").trim();
  const userRole = String(req.query.userRole || req.body?.userRole || "").trim();
  return { userId, userName, userRole };
}

router.get("/competitions/:competitionId/assistant/conversation", async (req, res) => {
  const competitionId = parseId(req.params.competitionId);
  const { userId, userName, userRole } = readUserContext(req);
  if (!competitionId) return res.status(400).json({ error: "competitionId invalido" });
  if (!userId) return res.status(400).json({ error: "userId requerido" });

  const conversation = await findOrCreateExotimerConversation({
    competitionId,
    userId,
    userName,
    userRole,
    touchLastMessageAt: false,
  });

  const detail = await prisma.conversation.findUnique({
    where: { id: conversation.id },
    include: {
      messages: {
        where: { competitionId },
        orderBy: { timestamp: "asc" },
        select: messageSelect,
      },
      actions: {
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });

  res.json(detail);
});

router.post("/competitions/:competitionId/assistant/messages", async (req, res) => {
  const competitionId = parseId(req.params.competitionId);
  const { userId, userName, userRole } = readUserContext(req);
  const content = String(req.body?.content || "").trim();
  if (!competitionId) return res.status(400).json({ error: "competitionId invalido" });
  if (!userId) return res.status(400).json({ error: "userId requerido" });
  if (!content) return res.status(400).json({ error: "Mensaje requerido" });

  try {
    const result = await processInboundExotimerMessage({
      competitionId,
      userId,
      userName,
      userRole,
      text: content,
      context: req.body?.context || null,
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get("/competitions/:competitionId/support-cases", async (req, res) => {
  const competitionId = parseId(req.params.competitionId);
  if (!competitionId) return res.status(400).json({ error: "competitionId invalido" });

  const cases = await prisma.supportCase.findMany({
    where: { competitionId },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    include: {
      conversation: {
        select: {
          id: true,
          phone: true,
          displayName: true,
          userType: true,
          status: true,
        },
      },
      messages: {
        orderBy: { timestamp: "desc" },
        take: 1,
        select: messageSelect,
      },
      _count: {
        select: { messages: true },
      },
    },
  });

  res.json(cases);
});

router.get("/competitions/:competitionId/support-cases/:caseId/messages", async (req, res) => {
  const competitionId = parseId(req.params.competitionId);
  const caseId = parseId(req.params.caseId);
  if (!competitionId || !caseId) return res.status(400).json({ error: "IDs invalidos" });

  const supportCase = await prisma.supportCase.findFirst({
    where: { id: caseId, competitionId },
    include: {
      conversation: {
        select: {
          id: true,
          phone: true,
          displayName: true,
          userType: true,
          status: true,
        },
      },
      messages: {
        orderBy: { timestamp: "asc" },
        select: messageSelect,
      },
      actions: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!supportCase) return res.status(404).json({ error: "Caso no encontrado" });
  res.json(supportCase);
});

router.get("/messages/:messageId/media", async (req, res) => {
  const messageId = parseId(req.params.messageId);
  if (!messageId) return res.status(400).json({ error: "messageId invalido" });

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

router.post("/support-cases/:caseId/messages", async (req, res) => {
  const caseId = parseId(req.params.caseId);
  const content = String(req.body?.content || "").trim();
  if (!caseId) return res.status(400).json({ error: "caseId invalido" });
  if (!content) return res.status(400).json({ error: "Mensaje requerido" });

  const supportCase = await prisma.supportCase.findUnique({
    where: { id: caseId },
    include: { conversation: true },
  });
  if (!supportCase) return res.status(404).json({ error: "Caso no encontrado" });

  let sent = null;
  try {
    sent = await sendTextMessage(supportCase.conversation.phone, content);
  } catch (error) {
    console.error("No se pudo enviar mensaje WhatsApp desde Exotimer:", error.response?.data || error.message);
    return res.status(502).json({ error: "No se pudo enviar por WhatsApp" });
  }

  const timestamp = new Date();
  const message = await prisma.message.create({
    data: {
      conversationId: supportCase.conversationId,
      supportCaseId: supportCase.id,
      competitionId: supportCase.competitionId,
      direction: "OUTBOUND",
      phone: supportCase.conversation.phone,
      content,
      aiMetadata: {
        manual: true,
        source: "exotimer",
        providerMessageId: sent?.messages?.[0]?.id || null,
      },
      timestamp,
    },
    select: messageSelect,
  });

  await prisma.$transaction([
    prisma.conversation.update({
      where: { id: supportCase.conversationId },
      data: { lastMessageAt: timestamp },
    }),
    prisma.supportCase.update({
      where: { id: supportCase.id },
      data: { lastMessageAt: timestamp },
    }),
  ]);

  res.status(201).json({ sent, message });
});

router.patch("/support-cases/:caseId", async (req, res) => {
  const caseId = parseId(req.params.caseId);
  if (!caseId) return res.status(400).json({ error: "caseId invalido" });

  const allowedStatuses = ["OPEN", "WAITING_CLARIFICATION", "WAITING_HUMAN", "RESOLVED"];
  const data = {};
  if (req.body?.status != null) {
    const status = String(req.body.status).toUpperCase();
    if (!allowedStatuses.includes(status)) return res.status(400).json({ error: "status invalido" });
    data.status = status;
  }
  if (req.body?.competitionId != null) {
    const competitionId = parseId(req.body.competitionId);
    if (!competitionId) return res.status(400).json({ error: "competitionId invalido" });
    data.competitionId = competitionId;
  }
  for (const field of ["athleteName", "dorsal", "subject", "summary"]) {
    if (req.body?.[field] !== undefined) data[field] = req.body[field] ? String(req.body[field]) : null;
  }
  if (req.body?.detectedDorsals !== undefined) {
    data.detectedDorsals = Array.isArray(req.body.detectedDorsals) ? req.body.detectedDorsals.map(String) : [];
  }
  if (req.body?.detectedAthletes !== undefined) {
    data.detectedAthletes = Array.isArray(req.body.detectedAthletes) ? req.body.detectedAthletes : [];
  }

  const supportCase = await prisma.supportCase.update({
    where: { id: caseId },
    data,
  });

  if (data.competitionId) {
    await prisma.message.updateMany({
      where: { supportCaseId: caseId },
      data: { competitionId: data.competitionId },
    });
  }

  res.json(supportCase);
});

router.post("/messages/:messageId/assign", async (req, res) => {
  const messageId = parseId(req.params.messageId);
  const competitionId = parseId(req.body?.competitionId);
  if (!messageId || !competitionId) return res.status(400).json({ error: "IDs invalidos" });

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: true },
  });
  if (!message) return res.status(404).json({ error: "Mensaje no encontrado" });

  const supportCase = await prisma.supportCase.create({
    data: {
      conversationId: message.conversationId,
      competitionId,
      userType: message.conversation.userType,
      status: "OPEN",
      subject: req.body?.subject ? String(req.body.subject) : "Asignacion manual desde Exotimer",
      summary: req.body?.summary ? String(req.body.summary) : message.content,
      detectedDorsals: Array.isArray(req.body?.detectedDorsals) ? req.body.detectedDorsals.map(String) : null,
      detectedAthletes: Array.isArray(req.body?.detectedAthletes) ? req.body.detectedAthletes : null,
      lastMessageAt: message.timestamp,
    },
  });

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: {
      supportCaseId: supportCase.id,
      competitionId,
    },
    select: messageSelect,
  });

  res.status(201).json({ supportCase, message: updated });
});

module.exports = router;
