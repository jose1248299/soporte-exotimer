const { normalizePhone } = require("./phone");

const WHATSAPP_USER_ID_PATTERN = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/;

function normalizeWhatsappUserId(value) {
  return String(value || "").trim();
}

function isWhatsappUserId(value) {
  return WHATSAPP_USER_ID_PATTERN.test(normalizeWhatsappUserId(value));
}

function normalizeWhatsappRecipient(value) {
  const recipient = String(value || "").trim();
  if (!recipient) return "";
  if (isWhatsappUserId(recipient)) return recipient;
  if (/[A-Za-z]/.test(recipient)) return "";
  return normalizePhone(recipient);
}

function resolveWhatsappIdentity(value = {}) {
  const message = value.messages?.[0] || {};
  const contact = value.contacts?.[0] || {};
  const phone = normalizePhone(message.from || contact.wa_id);
  const whatsappUserId = normalizeWhatsappUserId(
    message.from_user_id || contact.user_id
  );

  return {
    phone: phone || null,
    whatsappUserId: whatsappUserId || null,
    recipient: phone || whatsappUserId || null,
  };
}

function whatsappConversationRecipient(conversation = {}) {
  return normalizeWhatsappRecipient(
    conversation.whatsappUserId || conversation.phone
  );
}

module.exports = {
  isWhatsappUserId,
  normalizeWhatsappRecipient,
  normalizeWhatsappUserId,
  resolveWhatsappIdentity,
  whatsappConversationRecipient,
};
