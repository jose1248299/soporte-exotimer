const prisma = require("../lib/prisma");
const { Prisma } = require("@prisma/client");

function deliveryState(record) {
  if (record?.readAt) return "READ";
  if (record?.deliveredAt) return "DELIVERED";
  if (record?.failedAt) return "FAILED";
  if (record?.sentAt) return "SENT";
  return null;
}

function safeMetaErrors(errors) {
  return (Array.isArray(errors) ? errors : []).map(error => ({
    code: error.code || null,
    title: String(error.title || "Error de WhatsApp").slice(0, 300),
    message: String(error.message || error.error_data?.details || "").slice(0, 1000),
  }));
}

async function recordStatuses(statuses, db = prisma) {
  for (const status of statuses || []) {
    const field = { sent: "sentAt", delivered: "deliveredAt", read: "readAt", failed: "failedAt" }[status.status];
    if (!field || !status.id) continue;
    const timestamp = new Date(Number(status.timestamp) * 1000);
    if (!Number.isFinite(timestamp.getTime())) continue;
    await db.$transaction(async tx => {
      // Serialize concurrent callbacks for one provider ID, including callbacks before the send is saved.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${status.id}))`;
      const previous = await tx.whatsappDelivery.findUnique({ where: { providerMessageId: status.id } });
      const patch = previous?.[field] && previous[field] > timestamp ? {} : {
        [field]: timestamp,
        ...(field === "failedAt" ? { errors: safeMetaErrors(status.errors) } : {}),
      };
      const record = await tx.whatsappDelivery.upsert({
        where: { providerMessageId: status.id },
        create: { providerMessageId: status.id, ...patch }, update: patch,
      });
      await tx.message.updateMany({
        where: { direction: "OUTBOUND", OR: [
          { providerMessageId: status.id },
          { aiMetadata: { path: ["providerMessageId"], equals: status.id } },
        ] },
        data: { deliveryStatus: deliveryState(record), deliveryError: deliveryState(record) === "FAILED" && record.errors ? record.errors : Prisma.DbNull },
      });
    });
  }
}

async function enrichMessages(messages, db = prisma) {
  const ids = [...new Set(messages.map(m => m.providerMessageId || m.aiMetadata?.providerMessageId).filter(Boolean))];
  if (!ids.length) return messages;
  const records = await db.whatsappDelivery.findMany({ where: { providerMessageId: { in: ids } } });
  const byId = new Map(records.map(r => [r.providerMessageId, r]));
  return messages.map(message => {
    const id = message.providerMessageId || message.aiMetadata?.providerMessageId;
    const record = byId.get(id);
    return { ...message, providerMessageId: id || null,
      deliveryStatus: deliveryState(record) || message.deliveryStatus || (id ? "ACCEPTED" : null),
      deliveryError: record ? (deliveryState(record) === "FAILED" ? record.errors || null : null) : message.deliveryError || null };
  });
}

module.exports = { deliveryState, safeMetaErrors, recordStatuses, enrichMessages };
