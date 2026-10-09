const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const records = new Map();
const processed = [];
let failDatabase = false;
process.env.DATABASE_URL = "postgresql://synthetic.invalid/not-used";
require.cache[require.resolve("../config")] = { exports: { meta: { phoneNumberId: "our-phone", webhookVerifyToken: "test" } } };
require.cache[require.resolve("./supportProcessor")] = { exports: { processInboundMessage: async input => processed.push(input) } };
require.cache[require.resolve("./startListWhatsapp")] = { exports: { enabled: () => false, validMetaSignature: () => true } };
const db = {
  $transaction: async fn => { if (failDatabase) throw new Error("synthetic database error"); return fn(db); },
  $executeRaw: async () => 1,
  whatsappDelivery: {
    findUnique: async ({ where }) => records.get(where.providerMessageId),
    upsert: async ({ where, create, update }) => {
      const row = { ...(records.get(where.providerMessageId) || create), ...update };
      records.set(where.providerMessageId, row); return row;
    },
  }, message: { updateMany: async () => ({ count: 0 }) },
};
require.cache[require.resolve("../lib/prisma")] = { exports: db };
const webhook = require("../routes/webhook");

async function post(body) {
  const app = express(); app.use(express.json()); app.use("/webhook", webhook);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return response.status;
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("status-only webhooks are persisted before acknowledgement", async () => {
  assert.equal(await post({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.test", status: "delivered", timestamp: "1790000000" }] } }] }] }), 200);
  assert.ok(records.get("wamid.test").deliveredAt);
});

test("database failure returns retryable HTTP error rather than silently dropping statuses", async () => {
  failDatabase = true;
  assert.equal(await post({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.fail", status: "failed", timestamp: "1790000000" }] } }] }] }), 500);
  assert.equal(records.has("wamid.fail"), false);
  failDatabase = false;
});

test("all changes/messages are processed and contact identity does not leak between senders", async () => {
  const message = (from, id) => ({ from, id, type: "text", text: { body: "Synthetic" }, timestamp: "1790000000" });
  assert.equal(await post({ entry: [
    { changes: [{ value: { metadata: { phone_number_id: "other-phone" }, messages: [message("51900000999", "wrong-app")] } }] },
    { changes: [{ value: { contacts: [
      { wa_id: "51900000002", profile: { name: "Two" } }, { wa_id: "51900000001", profile: { name: "One" } },
    ], messages: [message("51900000001", "one"), message("51900000002", "two")] } },
    { value: { messages: [{ from_user_id: "PE.321", id: "three", type: "text", text: { body: "Test" } }],
      contacts: [{ user_id: "PE.321", profile: { name: "Three" } }] } }] },
  ] }), 200);
  assert.deepEqual(processed.map(m => [m.waId, m.displayName, m.from]), [
    ["one", "One", "51900000001"], ["two", "Two", "51900000002"], ["three", "Three", "PE.321"],
  ]);
});
