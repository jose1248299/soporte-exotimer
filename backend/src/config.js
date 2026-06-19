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
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
  },
  security: {
    exotimerApiKey: process.env.SUPPORT_EXOTIMER_API_KEY,
  },
  support: {
    replyDebounceMs: Number(process.env.SUPPORT_REPLY_DEBOUNCE_MS || 8000),
  },
  push: {
    vapidSubject: process.env.PUSH_VAPID_SUBJECT || process.env.PUBLIC_BASE_URL || "mailto:soporte@finisherdata.com",
    vapidPublicKey: process.env.PUSH_VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.PUSH_VAPID_PRIVATE_KEY,
  },
  exotimer: {
    baseUrl: (process.env.EXOTIMER_API_BASE_URL || "").replace(/\/+$/, ""),
    token: process.env.EXOTIMER_API_TOKEN,
    user: process.env.EXOTIMER_API_USER,
    password: process.env.EXOTIMER_API_PASSWORD,
  },
};

module.exports = config;
