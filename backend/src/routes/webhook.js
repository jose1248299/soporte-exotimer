const express = require("express");
const config = require("../config");
const { processInboundMessage } = require("../services/supportProcessor");
const { resolveWhatsappIdentity } = require("../utils/whatsapp");
const startList = require("../services/startListWhatsapp");
const startListAccess = require("../services/startListWhatsappAccess");
const prisma = require("../lib/prisma");

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
    const signature = req.get("x-hub-signature-256");
    const startListVerified = startList.validMetaSignature(req.rawBody, signature);
    const registeredMode = startList.enabled() && startListAccess.authMode() === "registered_timer";
    if (startList.enabled() && ((!registeredMode && !startListVerified)
      || (process.env.META_APP_SECRET && !startListVerified))) return res.sendStatus(403);
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
    let identity = resolveWhatsappIdentity(value);
    let startListAuthorization = null;
    if (registeredMode) {
      const phone = startListAccess.registeredPhone(message.from);
      const request = startListAccess.startListInput({ type: message.type, text: message.text?.body || message.document?.caption,
        media: { filename: message.document?.filename, mimeType: message.document?.mime_type } });
      // Only inspect the existence/expiry of a local link to recognize replies
      // to an active import. Never read a grant or draft before authorization.
      const linked = !request.requested && phone ? await prisma.startListWhatsappSession.findUnique({
        where: { phoneHash: startList.senderHash(phone) }, select: { expiresAt: true },
      }) : null;
      const importScope = request.requested || (linked && new Date(linked.expiresAt).getTime() > Date.now());
      if (importScope) {
        if (!phone) return res.sendStatus(200);
        if (!startListAccess.allowRegisteredIngress(phone)) return res.status(429).set("Retry-After", "60").end();
        const timer = await startListAccess.findActiveTimer(prisma, phone);
        if (!timer) return res.sendStatus(200);
        identity = { phone: timer.phone, recipient: timer.phone, whatsappUserId: null };
        startListAuthorization = { mode: "registered_timer", phone: timer.phone, timerContactId: timer.id };
      }
    }
    if (!identity.recipient) {
      console.warn("Webhook de WhatsApp recibido sin telefono ni from_user_id.");
      return res.sendStatus(200);
    }
    const timestamp = message.timestamp
      ? new Date(Number(message.timestamp) * 1000)
      : new Date();

    res.sendStatus(200);

    await processInboundMessage({
      startListVerified,
      startListAuthorization,
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
      displayName: startListAuthorization ? null : contact?.profile?.name || contact?.profile?.username || null,
    });
  } catch (error) {
    // Axios errors can contain bearer headers and message bodies. Log only diagnostics.
    console.error("Error procesando webhook:", { name: error?.name || "Error", status: error?.response?.status || null });
    if (!res.headersSent) return res.sendStatus(500);
  }
});

module.exports = router;
