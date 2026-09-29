const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");

// The real webhook and signature verifier run behind local HTTP only. No support
// processor, database, Meta API or model is reachable from this fixture.
const processed = [];
require.cache[require.resolve("../config")] = { exports: { meta: { webhookVerifyToken: "test" }, raceline: {}, openai: {} } };
require.cache[require.resolve("./supportProcessor")] = { exports: { processInboundMessage: async input => { processed.push(input); } } };
require.cache[require.resolve("../lib/prisma")] = { exports: {} };
const webhook = require("../routes/webhook");

const payload = JSON.stringify({ entry: [{ changes: [{ value: {
  contacts: [{ wa_id: "51900000001", profile: { name: "Synthetic" } }],
  messages: [{ id: "test-inbound", from: "51900000001", timestamp: "1790000000", type: "document", document: { id: "test-media", filename: "start-list.xlsx", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }],
} }] }] });

async function serve(run) {
  const app = express();
  app.use(express.json({ limit: "2mb", verify: (req, _res, bytes) => { req.rawBody = bytes; } }));
  app.use("/webhook", webhook);
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  try { await run(`http://127.0.0.1:${server.address().port}/webhook`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("enabled WhatsApp imports reject unsigned/tampered webhooks before processing", async () => {
  process.env.START_LIST_IMPORTS_ENABLED = "true";
  process.env.START_LIST_WHATSAPP_ENABLED = "true";
  process.env.META_APP_SECRET = "synthetic-meta-secret";
  process.env.DATABASE_URL = "postgresql://not-used.invalid/test";
  processed.length = 0;
  await serve(async url => {
    const unsigned = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    assert.equal(unsigned.status, 403);
    const bad = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${"0".repeat(64)}` }, body: payload });
    assert.equal(bad.status, 403);
    assert.equal(processed.length, 0);
  });
});

test("signed documents preserve identity, media and verification for the scoped importer", async () => {
  processed.length = 0;
  const signature = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(payload).digest("hex")}`;
  await serve(async url => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature }, body: payload });
    assert.equal(response.status, 200);
    assert.equal(processed.length, 1);
    assert.equal(processed[0].startListVerified, true);
    assert.equal(processed[0].from, "51900000001");
    assert.equal(processed[0].media.filename, "start-list.xlsx");
  });
});

test("feature off preserves the legacy webhook behavior", async () => {
  process.env.START_LIST_WHATSAPP_ENABLED = "false";
  processed.length = 0;
  await serve(async url => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    assert.equal(response.status, 200);
    assert.equal(processed.length, 1);
    assert.equal(processed[0].startListVerified, false);
  });
});
