const test = require("node:test");
const assert = require("node:assert/strict");
const { createOutbox, classifySendError } = require("./whatsappOutbox");

function fixture({ send, age = 60000 } = {}) {
  const now = new Date("2026-10-09T12:00:00Z");
  const message = { id: 1, conversationId: 2, direction: "OUTBOUND", deliveryStatus: "QUEUED", content: "Saved reply",
    sendAttempts: 0, aiMetadata: { action: "already-executed" }, conversation: { phone: "51900000001", whatsappUserId: "PE.123" } };
  let sends = 0;
  const db = { message: {
    updateMany: async ({ where, data }) => {
      if (where.id && message.deliveryStatus !== where.deliveryStatus) return { count: 0 };
      Object.assign(message, { ...data, ...(data.sendAttempts ? { sendAttempts: message.sendAttempts + 1 } : {}) }); return { count: 1 };
    },
    findUnique: async () => ({ ...message }), findFirst: async () => ({ timestamp: new Date(now - age) }),
    update: async ({ data }) => { Object.assign(message, data); return { ...message }; },
  }, whatsappDelivery: { findUnique: async () => null } };
  const outbox = createOutbox({ db, now: () => now, send: async (...args) => { sends++; return send ? send(...args) : { messages: [{ id: "wamid.test" }] }; } });
  return { message, outbox, sends: () => sends, db };
}

test("durable reply sends once without re-executing any support action", async () => {
  const f = fixture();
  await Promise.all([f.outbox.deliver(1), f.outbox.deliver(1)]);
  assert.equal(f.sends(), 1);
  assert.equal(f.message.deliveryStatus, "ACCEPTED");
  assert.equal(f.message.providerMessageId, "wamid.test");
  assert.equal(f.message.aiMetadata.action, "already-executed");
});

test("closed 24h window never sends old free-text responses", async () => {
  const f = fixture({ age: 25 * 3600000 });
  await f.outbox.deliver(1);
  assert.equal(f.sends(), 0);
  assert.equal(f.message.deliveryStatus, "EXPIRED");
});

test("safe throttling retries the stored reply; network uncertainty does not retry", async () => {
  const f = fixture({ send: async () => { throw { response: { status: 429, data: { error: { code: 130429 } } } }; } });
  await f.outbox.deliver(1);
  assert.equal(f.message.deliveryStatus, "QUEUED");
  assert.ok(f.message.nextSendAt);
  assert.equal(classifySendError({ code: "ETIMEDOUT", message: "timeout" }).state, "UNKNOWN");
  assert.equal(classifySendError({ response: { status: 500 } }).state, "UNKNOWN");
  assert.equal(classifySendError({ response: { status: 400, data: { error: { code: 131047 } } } }).state, "FAILED");
});

test("failure to persist provider acceptance does not cause an automatic resend", async () => {
  const f = fixture();
  f.db.message.update = async () => { throw new Error("database unavailable"); };
  await assert.rejects(() => f.outbox.deliver(1));
  assert.equal(f.message.deliveryStatus, "SENDING");
  await f.outbox.deliver(1);
  assert.equal(f.sends(), 1);
});
