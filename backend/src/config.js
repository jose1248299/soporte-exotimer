require("dotenv").config();

const config = {
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "http://localhost:4000").replace(/\/+$/, ""),
  meta: {
    graphVersion: process.env.META_GRAPH_VERSION || process.env.WHATSAPP_GRAPH_VERSION || "v25.0",
    accessToken: process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN,
    wabaId: process.env.META_WABA_ID || process.env.WHATSAPP_WABA_ID,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID,
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4.1",
  },
  exotimer: {
    baseUrl: (process.env.EXOTIMER_API_BASE_URL || "").replace(/\/+$/, ""),
    token: process.env.EXOTIMER_API_TOKEN,
    user: process.env.EXOTIMER_API_USER,
    password: process.env.EXOTIMER_API_PASSWORD,
  },
};

module.exports = config;
