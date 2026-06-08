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

async function getMediaUrl(mediaId) {
  assertMetaConfig();

  const { data } = await axios.get(`${apiUrl}/${mediaId}`, {
    headers: {
      Authorization: `Bearer ${config.meta.accessToken}`,
    },
    timeout: 15000,
  });

  if (!data?.url) throw new Error("Meta no devolvio URL de media.");
  return data;
}

async function downloadMedia(mediaId) {
  const media = await getMediaUrl(mediaId);
  const response = await axios.get(media.url, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${config.meta.accessToken}`,
    },
    timeout: 30000,
  });

  return {
    buffer: Buffer.from(response.data),
    mimeType: response.headers["content-type"] || media.mime_type || null,
    sha256: media.sha256 || null,
    url: media.url,
  };
}

module.exports = { downloadMedia, sendTextMessage };
