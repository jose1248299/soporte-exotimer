const express = require("express");
const config = require("../config");
const { processInboundMessage } = require("../services/supportProcessor");

const router = express.Router();

router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.meta.webhookVerifyToken) {
    return res.status(200).send(challenge);
  }

  console.warn("Verificacion de webhook Meta rechazada.");
  return res.sendStatus(403);
});

router.post("/", async (req, res) => {
  try {
    if (!process.env.DATABASE_URL?.trim()) {
      console.error("Webhook recibido sin DATABASE_URL configurado. Mensaje no procesado.");
      return res.sendStatus(503);
    }

    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);
    if (!["text", "image"].includes(message.type)) return res.sendStatus(200);

    const contact = value.contacts?.[0];
    const timestamp = message.timestamp
      ? new Date(Number(message.timestamp) * 1000)
      : new Date();

    res.sendStatus(200);

    await processInboundMessage({
      waId: message.id || null,
      from: message.from,
      type: message.type,
      text: message.type === "image" ? message.image?.caption || "" : message.text?.body || "",
      media: message.type === "image"
        ? {
            id: message.image?.id || null,
            mimeType: message.image?.mime_type || null,
            sha256: message.image?.sha256 || null,
          }
        : null,
      timestamp,
      rawPayload: req.body,
      displayName: contact?.profile?.name || null,
    });
  } catch (error) {
    console.error("Error procesando webhook:", error);
    if (!res.headersSent) return res.sendStatus(500);
  }
});

module.exports = router;
