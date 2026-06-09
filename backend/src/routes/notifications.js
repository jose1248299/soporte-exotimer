const express = require("express");
const {
  deactivateSubscription,
  getPublicKey,
  isPushConfigured,
  upsertSubscription,
} = require("../services/pushNotifications");

const router = express.Router();

router.get("/public-key", (_req, res) => {
  res.json({
    configured: isPushConfigured(),
    publicKey: getPublicKey(),
  });
});

router.post("/subscriptions", async (req, res) => {
  try {
    const item = await upsertSubscription({
      subscription: req.body?.subscription,
      user: req.user,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json({ ok: true, id: item.id });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "No se pudo guardar suscripcion" });
  }
});

router.delete("/subscriptions", async (req, res) => {
  await deactivateSubscription(req.body?.endpoint);
  res.json({ ok: true });
});

module.exports = router;
