const express = require("express");
const cors = require("cors");
const config = require("./config");
const webhookRouter = require("./routes/webhook");
const conversationsRouter = require("./routes/conversations");
const timersRouter = require("./routes/timers");
const actionsRouter = require("./routes/actions");
const settingsRouter = require("./routes/settings");
const exotimerSupportRouter = require("./routes/exotimerSupport");
const { requireExotimerApiKey, requireFirebaseAuth } = require("./middleware/auth");

const app = express();

if (config.env === "production" && !process.env.DATABASE_URL?.trim()) {
  throw new Error("DATABASE_URL es obligatorio en produccion.");
}

const prisma = require("./lib/prisma");

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "soporte-exotimer" });
});

app.get("/health/db", async (_req, res) => {
  if (!process.env.DATABASE_URL?.trim()) {
    return res.status(503).json({ ok: false, database: "missing" });
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});

app.use("/api/webhook", webhookRouter);
app.use("/api/conversations", requireFirebaseAuth, conversationsRouter);
app.use("/api/timers", requireFirebaseAuth, timersRouter);
app.use("/api/actions", requireFirebaseAuth, actionsRouter);
app.use("/api/settings", requireFirebaseAuth, settingsRouter);
app.use("/api/exotimer", requireExotimerApiKey, exotimerSupportRouter);

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Error interno" });
});

app.listen(config.port, () => {
  console.log(`Soporte Exotimer escuchando en puerto ${config.port}`);
});
