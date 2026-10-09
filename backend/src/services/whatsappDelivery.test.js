const test = require("node:test");
const assert = require("node:assert/strict");
const { recordStatuses, enrichMessages, deliveryState } = require("./whatsappDelivery");

function fixture() {
  const records = new Map();
  const messages = [{ id: 1, direction: "OUTBOUND", aiMetadata: { providerMessageId: "wamid.test" } }];
  const db = {
    $transaction: async fn => fn(db), $executeRaw: async () => 1,
    whatsappDelivery: {
      findUnique: async ({ where }) => records.get(where.providerMessageId),
      upsert: async ({ where, create, update }) => {
        const value = { ...(records.get(where.providerMessageId) || create), ...update };
        records.set(where.providerMessageId, value); return value;
      },
      findMany: async () => [...records.values()],
    },
    message: { updateMany: async ({ data }) => { messages.forEach(m => Object.assign(m, data)); return { count: messages.length }; } },
  };
  return { db, records, messages };
}

test("status callbacks survive before message storage and tolerate duplicate/out-of-order events", async () => {
  const { db, records, messages } = fixture();
  messages.length = 0;
  await recordStatuses([{ id: "wamid.test", status: "read", timestamp: "1790000020" }], db);
  await recordStatuses([{ id: "wamid.test", status: "sent", timestamp: "1790000000" },
    { id: "wamid.test", status: "read", timestamp: "1790000010" }], db);
  assert.equal(deliveryState(records.get("wamid.test")), "READ");
  assert.equal(records.get("wamid.test").readAt.getTime(), 1790000020000);
  const enriched = await enrichMessages([{ id: 3, aiMetadata: { providerMessageId: "wamid.test" }, deliveryStatus: "ACCEPTED" }], db);
  assert.equal(enriched[0].deliveryStatus, "READ");
});

test("accepted is not delivered; failure records error codes, not bearer request headers", async () => {
  const { db, messages } = fixture();
  assert.equal((await enrichMessages(messages, db))[0].deliveryStatus, "ACCEPTED");
  await recordStatuses([{ id: "wamid.test", status: "failed", timestamp: "1790000000",
    errors: [{ code: 131026, title: "Undeliverable", message: "Recipient unavailable", headers: { Authorization: "secret" } }] }], db);
  assert.equal(messages[0].deliveryStatus, "FAILED");
  assert.equal(messages[0].deliveryError[0].code, 131026);
  assert.equal(messages[0].deliveryError[0].headers, undefined);
  await recordStatuses([{ id: "wamid.test", status: "delivered", timestamp: "1790000020" }], db);
  assert.equal(messages[0].deliveryStatus, "DELIVERED");
});
