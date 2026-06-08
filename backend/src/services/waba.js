const axios = require("axios");
const config = require("../config");
const { normalizePhone } = require("../utils/phone");

const apiUrl = `https://graph.facebook.com/${config.meta.graphVersion}`;

function assertMetaConfig() {
  const missing = [];
  if (!config.meta.accessToken) missing.push("META_ACCESS_TOKEN");
  if (!config.meta.phoneNumberId) missing.push("META_PHONE_NUMBER_ID");
  if (missing.length) {
    throw new Error(`Falta configurar Meta WhatsApp Cloud API: ${missing.join(", ")}`);
  }
}

async function postMessage(payload) {
  assertMetaConfig();

  const { data } = await axios.post(
    `${apiUrl}/${config.meta.phoneNumberId}/messages`,
    payload,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.meta.accessToken}`,
      },
    }
  );

  return data;
}

async function sendTextMessage(to, body) {
  return postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhone(to),
    type: "text",
    text: {
      preview_url: false,
      body,
    },
  });
}

module.exports = { sendTextMessage };
