const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { normalizePhone } = require("../utils/phone");

const contactSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(6),
  active: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

function createContactDirectoryRouter(modelName) {
  const router = express.Router();

  function model() {
    const delegate = prisma[modelName];
    if (!delegate) throw new Error(`El modelo Prisma ${modelName} no está disponible.`);
    return delegate;
  }

  router.get("/", async (_req, res) => {
    const contacts = await model().findMany({
      orderBy: { name: "asc" },
    });
    res.json(contacts);
  });

  router.post("/", async (req, res) => {
    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Datos invalidos", details: parsed.error.flatten() });
    }

    const data = parsed.data;
    const contact = await model().upsert({
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

    res.status(201).json(contact);
  });

  router.patch("/:id", async (req, res) => {
    const id = Number(req.params.id);
    const parsed = contactSchema.partial().safeParse(req.body);
    if (!Number.isInteger(id) || !parsed.success) {
      return res.status(400).json({ error: "Datos invalidos" });
    }

    const data = parsed.data;
    const contact = await model().update({
      where: { id },
      data: {
        ...data,
        phone: data.phone ? normalizePhone(data.phone) : undefined,
      },
    });

    res.json(contact);
  });

  return router;
}

module.exports = createContactDirectoryRouter;
