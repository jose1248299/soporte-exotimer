const crypto = require("node:crypto");
const prisma = require("../lib/prisma");
const config = require("../config");
const outbox = require("./whatsappOutbox");
const startListAccess = require("./startListWhatsappAccess");
const { WINDOW_MS } = require("./whatsappOutbox");

function createReplyJobs({ db = prisma, processReply, now = () => new Date() } = {}) {
  let busy = false;
  let lastRecovery = 0;

  async function enqueue(conversationId) {
    const dueAt = new Date(now().getTime() + Math.max(0, Number(config.support.replyDebounceMs || 8000)));
    return db.conversationReplyJob.upsert({ where: { conversationId },
      create: { conversationId, dueAt },
      update: { revision: { increment: 1 }, dueAt, state: "PENDING", attempts: 0, lastError: null },
    });
  }

  async function recoverMissingJobs() {
    const candidates = await db.$queryRaw`
      SELECT DISTINCT ON (m."conversationId") m.* FROM "Message" m
      WHERE m.direction = 'INBOUND' AND m.timestamp > NOW() - INTERVAL '24 hours'
        AND m."aiMetadata"->>'debounceProcessedAt' IS NULL
        AND NOT EXISTS (SELECT 1 FROM "Message" o WHERE o."conversationId" = m."conversationId"
          AND o.direction = 'OUTBOUND' AND o.timestamp >= m.timestamp)
      ORDER BY m."conversationId", m.timestamp DESC`;
    for (const message of candidates) {
      if (startListAccess.isStartListMessage(message)) continue;
      await db.conversationReplyJob.upsert({ where: { conversationId: message.conversationId },
        create: { conversationId: message.conversationId, dueAt: now() }, update: {} });
    }
  }

  async function run(job) {
    const time = now();
    const token = crypto.randomUUID();
    const claimed = await db.conversationReplyJob.updateMany({ where: {
      conversationId: job.conversationId, revision: job.revision, state: "PENDING", dueAt: { lte: time },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: time } }],
    }, data: { leaseToken: token, leaseUntil: new Date(time.getTime() + 120000) } });
    if (!claimed.count) return;
    const leaseWhere = { conversationId: job.conversationId, leaseToken: token };
    const heartbeat = setInterval(() => {
      db.conversationReplyJob.updateMany({ where: leaseWhere, data: { leaseUntil: new Date(now().getTime() + 120000) } })
        .catch(() => console.warn("No se pudo renovar el bloqueo de respuesta.", { conversationId: job.conversationId }));
    }, 20000);
    heartbeat.unref?.();
    try {
      const conversation = await db.conversation.findUnique({ where: { id: job.conversationId } });
      const inbound = await db.message.findFirst({ where: { conversationId: job.conversationId, direction: "INBOUND" }, orderBy: { timestamp: "desc" } });
      if (conversation?.channel === "WHATSAPP" && (!inbound || time - new Date(inbound.timestamp) >= WINDOW_MS)) {
        await db.conversationReplyJob.updateMany({ where: { ...leaseWhere, revision: job.revision }, data: { state: "EXPIRED" } });
        return;
      }
      await processReply(job.conversationId);
      // New messages arriving during the reply keep their newer revision and debounce deadline.
      await db.conversationReplyJob.deleteMany({ where: { ...leaseWhere, revision: job.revision } });
    } catch {
      await db.conversationReplyJob.updateMany({ where: { ...leaseWhere, revision: job.revision }, data: {
        attempts: { increment: 1 }, state: job.attempts >= 4 ? "FAILED" : "PENDING",
        dueAt: new Date(now().getTime() + Math.min(300000, 30000 * (job.attempts + 1))),
        lastError: "No se pudo completar la respuesta; revisar acciones y conectividad.",
      } });
      console.error("Respuesta pendiente no completada.", { conversationId: job.conversationId });
    } finally {
      clearInterval(heartbeat);
      await db.conversationReplyJob.updateMany({ where: leaseWhere, data: { leaseToken: null, leaseUntil: null } });
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (now().getTime() - lastRecovery > 60000) {
        await recoverMissingJobs();
        lastRecovery = now().getTime();
      }
      await outbox.recover();
      const jobs = await db.conversationReplyJob.findMany({ where: { state: "PENDING", dueAt: { lte: now() },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now() } }] }, orderBy: { dueAt: "asc" }, take: 5 });
      for (const job of jobs) await run(job);
    } finally { busy = false; }
  }

  return { enqueue, run, tick, recoverMissingJobs };
}

const jobs = createReplyJobs({ processReply: id => require("./supportProcessor").processConversationReply(id) });
function startReplyWorker() {
  const poll = () => jobs.tick().catch(() => console.error("No se pudo recuperar la cola de respuestas."));
  const interval = setInterval(poll, 1000);
  interval.unref?.();
  poll();
  return () => clearInterval(interval);
}

module.exports = { ...jobs, createReplyJobs, startReplyWorker };
