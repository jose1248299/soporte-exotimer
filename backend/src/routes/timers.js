const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { normalizePhone } = require("../utils/phone");

const router = express.Router();

const timerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(6),
  active: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

router.get("/", async (_req, res) => {
  const timers = await prisma.timerContact.findMany({
    orderBy: { name: "asc" },
  });
  res.json(timers);
});

router.post("/", async (req, res) => {
  const parsed = timerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Datos invalidos", details: parsed.error.flatten() });
  }

  const data = parsed.data;
  const timer = await prisma.timerContact.upsert({
    where: { phone: normalizePhone(data.phone) },
    create: {
      name: data.name,
      phone: normalizePhone(data.phone),
      active: data.active ?? true,
      notes: data.notes,
    },
    update: {
      name: data.name,
      active: data.active ?? true,
      notes: data.notes,
    },
  });

  res.status(201).json(timer);
});

router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const parsed = timerSchema.partial().safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    return res.status(400).json({ error: "Datos invalidos" });
  }

  const data = parsed.data;
  const timer = await prisma.timerContact.update({
    where: { id },
    data: {
      ...data,
      phone: data.phone ? normalizePhone(data.phone) : undefined,
    },
  });

  res.json(timer);
});

module.exports = router;
