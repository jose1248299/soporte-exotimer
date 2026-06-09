const webpush = require("web-push");
const prisma = require("../lib/prisma");
const config = require("../config");

function isPushConfigured() {
  return Boolean(config.push.vapidPublicKey && config.push.vapidPrivateKey);
}

function configureWebPush() {
  if (!isPushConfigured()) return false;
  webpush.setVapidDetails(
    config.push.vapidSubject,
    config.push.vapidPublicKey,
    config.push.vapidPrivateKey
  );
  return true;
}

function getPublicKey() {
  return config.push.vapidPublicKey || null;
}

async function upsertSubscription({ subscription, user, userAgent }) {
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    const error = new Error("Suscripcion push invalida.");
    error.statusCode = 400;
    throw error;
  }

  return prisma.pushSubscription.upsert({
    where: { endpoint },
    create: {
      uid: user?.uid || null,
      email: user?.email || null,
      endpoint,
      p256dh,
      auth,
      userAgent: userAgent || null,
      active: true,
    },
    update: {
      uid: user?.uid || null,
      email: user?.email || null,
      p256dh,
      auth,
      userAgent: userAgent || null,
      active: true,
    },
  });
}

async function deactivateSubscription(endpoint) {
  if (!endpoint) return null;
  return prisma.pushSubscription.updateMany({
    where: { endpoint },
    data: { active: false },
  });
}

async function sendNewMessageNotification({ conversation, message, userType }) {
  if (!configureWebPush()) return { sent: 0, skipped: "not_configured" };

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { active: true },
  });
  if (!subscriptions.length) return { sent: 0, skipped: "no_subscriptions" };

  const title = conversation.displayName || conversation.phone || "Nuevo mensaje";
  const body = message.contentType === "IMAGE"
    ? message.content && message.content !== "[Imagen recibida]"
      ? `Imagen: ${message.content}`
      : "Imagen recibida por WhatsApp"
    : message.content || "Nuevo mensaje recibido";

  const payload = JSON.stringify({
    title,
    body,
    badge: 1,
    icon: "/icons/icon-192.png",
    badgeIcon: "/icons/maskable-512.png",
    url: "/",
    tag: `conversation-${conversation.id}`,
    data: {
      conversationId: conversation.id,
      messageId: message.id,
      userType,
      phone: conversation.phone,
    },
  });

  let sent = 0;
  await Promise.all(
    subscriptions.map(async (item) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: item.endpoint,
            keys: {
              p256dh: item.p256dh,
              auth: item.auth,
            },
          },
          payload
        );
        sent += 1;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await deactivateSubscription(item.endpoint);
        } else {
          console.warn("No se pudo enviar push:", error.statusCode || error.message);
        }
      }
    })
  );

  return { sent };
}

module.exports = {
  deactivateSubscription,
  getPublicKey,
  isPushConfigured,
  sendNewMessageNotification,
  upsertSubscription,
};
