const express = require("express");
const prisma = require("../lib/prisma");
const { executeAction } = require("../services/exotimerClient");
const { getPolicy } = require("../services/supportPolicies");

const router = express.Router();

router.get("/", async (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;

  const actions = await prisma.supportAction.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
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
    },
    take: 100,
  });

  res.json(actions);
});

router.post("/:id/execute", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID invalido" });

  const action = await prisma.supportAction.findUnique({
    where: { id },
    include: { conversation: true },
  });

  if (!action) return res.status(404).json({ error: "Accion no encontrada" });
  if (action.status === "EXECUTED") {
    return res.status(409).json({ error: "La accion ya fue ejecutada" });
  }

  const mergedInput = {
    ...(action.input || {}),
    ...(req.body?.input || {}),
    confirmed: true,
    confirmedBy: req.body?.confirmedBy || "support-panel",
  };

  try {
    const policy = await getPolicy(action.userType, action.name);
    if (!policy.enabled) {
      return res.status(403).json({ error: "Accion deshabilitada por configuracion" });
    }

    const output = await executeAction(action.userType, action.name, mergedInput, {
      allowByPolicy: true,
    });
    const updated = await prisma.supportAction.update({
      where: { id },
      data: {
        status: "EXECUTED",
        input: mergedInput,
        output,
        error: null,
      },
    });

    await prisma.conversation.update({
      where: { id: action.conversationId },
      data: { status: "OPEN" },
    });

    res.json({ action: updated, output });
  } catch (error) {
    const updated = await prisma.supportAction.update({
      where: { id },
      data: {
        status: "FAILED",
        input: mergedInput,
        error: error.message,
      },
    });

    res.status(500).json({ action: updated, error: error.message });
  }
});

router.post("/:id/skip", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID invalido" });

  const action = await prisma.supportAction.update({
    where: { id },
    data: {
      status: "SKIPPED",
      error: req.body?.reason || null,
    },
  });

  res.json(action);
});

module.exports = router;
