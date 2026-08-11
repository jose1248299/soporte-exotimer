const express = require("express");
const config = require("../config");
const { processInboundMessage } = require("../services/supportProcessor");
const { resolveWhatsappIdentity } = require("../utils/whatsapp");

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
    if (!["text", "image", "document"].includes(message.type)) {
      return res.sendStatus(200);
    }

    const contact = value.contacts?.[0];
    const identity = resolveWhatsappIdentity(value);
    if (!identity.recipient) {
      console.warn("Webhook de WhatsApp recibido sin telefono ni from_user_id.");
      return res.sendStatus(200);
    }
    const timestamp = message.timestamp
      ? new Date(Number(message.timestamp) * 1000)
      : new Date();

    res.sendStatus(200);

    await processInboundMessage({
      waId: message.id || null,
      from: identity.recipient,
      whatsappUserId: identity.whatsappUserId,
      type: message.type,
      text:
        message.type === "image"
          ? message.image?.caption || ""
          : message.type === "document"
            ? message.document?.caption || ""
            : message.text?.body || "",
      media: ["image", "document"].includes(message.type)
        ? {
            id: message[message.type]?.id || null,
            mimeType: message[message.type]?.mime_type || null,
            sha256: message[message.type]?.sha256 || null,
            filename: message[message.type]?.filename || null,
          }
        : null,
      timestamp,
      rawPayload: req.body,
      displayName:
        contact?.profile?.name || contact?.profile?.username || null,
    });
  } catch (error) {
    console.error("Error procesando webhook:", error);
    if (!res.headersSent) return res.sendStatus(500);
  }
});

module.exports = router;
