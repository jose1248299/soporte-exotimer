const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");

// The real webhook and signature verifier run behind local HTTP only. No support
// processor, database, Meta API or model is reachable from this fixture.
const processed = [];
const timers = new Map();
const links = new Map();
const directoryQueries = [];
const sessionQueries = [];
require.cache[require.resolve("../config")] = { exports: { meta: { webhookVerifyToken: "test" }, raceline: {}, openai: {} } };
require.cache[require.resolve("./supportProcessor")] = { exports: { processInboundMessage: async input => { processed.push(input); return { reply: `CONFIRMAR AABBCCDD V1 ${"A".repeat(32)}` }; } } };
require.cache[require.resolve("../lib/prisma")] = { exports: {
  timerContact: { findFirst: async query => { directoryQueries.push(query); const contact = timers.get(query.where.phone); return contact?.active ? contact : null; } },
  startListWhatsappSession: { findUnique: async query => { sessionQueries.push(query); return links.get(query.where.phoneHash) || null; } },
} };
const webhook = require("../routes/webhook");
const { senderHash } = require("./startListWhatsapp");

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

async function withRegisteredMode(run) {
  const keys = ["START_LIST_IMPORTS_ENABLED", "START_LIST_WHATSAPP_ENABLED", "START_LIST_WHATSAPP_AUTH_MODE", "START_LIST_WHATSAPP_ENCRYPTION_KEY", "META_APP_SECRET"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.START_LIST_IMPORTS_ENABLED = "true";
  process.env.START_LIST_WHATSAPP_ENABLED = "true";
  process.env.START_LIST_WHATSAPP_AUTH_MODE = "registered_timer";
  process.env.START_LIST_WHATSAPP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  delete process.env.META_APP_SECRET;
  processed.length = 0; timers.clear(); links.clear(); directoryQueries.length = 0; sessionQueries.length = 0;
  try { await serve(run); } finally { for (const [key, value] of Object.entries(previous)) { if (value == null) delete process.env[key]; else process.env[key] = value; } }
}

function registeredPayload(phone, options = {}) {
  const value = JSON.parse(payload).entry[0].changes[0].value;
  value.messages[0].from = phone;
  Object.assign(value.messages[0], options);
  return { object: "whatsapp_business_account", entry: [{ changes: [{ value }] }] };
}
const post = (url, body, extraHeaders = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });

test("registered imports ignore spoofed BSUID/contact/profile fields and never return a private confirmation over HTTP", () => withRegisteredMode(async url => {
  const phone = "51900000011";
  timers.set(phone, { id: 11, phone, active: true });
  const body = registeredPayload(phone, { from_user_id: "PE.666666666" });
  const value = body.entry[0].changes[0].value;
  value.contacts = [{ wa_id: "51900000999", user_id: "PE.666666666", profile: { name: "Forged name" } }];
  const response = await post(url, body);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OK");
  assert.equal(processed.length, 1);
  assert.equal(processed[0].from, phone);
  assert.equal(processed[0].whatsappUserId, null);
  assert.equal(processed[0].displayName, null);
  assert.equal(processed[0].startListVerified, false);
  assert.deepEqual(processed[0].startListAuthorization, { mode: "registered_timer", phone, timerContactId: 11 });
}));

test("contact-card phones, business IDs and formatted from fields cannot substitute for raw numeric from on an import", () => withRegisteredMode(async url => {
  for (const phone of [undefined, "", "+51900000012", "51 900000012", "PE.51900000012"]) {
    const response = await post(url, registeredPayload(phone, { from_user_id: "PE.123456789" }));
    assert.equal(response.status, 200);
  }
  assert.equal(processed.length, 0);
  assert.equal(directoryQueries.length, 0);
  assert.equal(sessionQueries.length, 0);
}));

test("unregistered and inactive imports are dropped before conversations, local sessions or media processing", () => withRegisteredMode(async url => {
  timers.set("51900000013", { id: 13, phone: "51900000013", active: false });
  for (const phone of ["51900000013", "51900000014"]) assert.equal((await post(url, registeredPayload(phone))).status, 200);
  assert.equal(processed.length, 0);
  assert.equal(sessionQueries.length, 0);
}));

test("ordinary replies to an existing import still require an active timer before conversation processing", () => withRegisteredMode(async url => {
  const phone = "51900000015";
  links.set(senderHash(phone), { expiresAt: new Date(Date.now() + 60000) });
  timers.set(phone, { id: 15, phone, active: false });
  const response = await post(url, registeredPayload(phone, { type: "text", text: { body: "Larga pertenece a 10K" } }));
  assert.equal(response.status, 200);
  assert.equal(processed.length, 0);
  assert.deepEqual(sessionQueries[0].select, { expiresAt: true });
}));

test("unrelated support messages retain legacy identity handling without gaining Start List authorization", () => withRegisteredMode(async url => {
  const body = registeredPayload("51900000016", { type: "text", from_user_id: "PE.123456789", text: { body: "Quiero ver mi resultado" } });
  assert.equal((await post(url, body)).status, 200);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].startListAuthorization, null);
  assert.equal(processed[0].whatsappUserId, "PE.123456789");
  assert.equal(processed[0].displayName, "Synthetic");
  assert.equal(directoryQueries.length, 0);
}));

test("configuring a Meta secret rejects both missing and invalid signatures without downgrade, while signed imports work", () => withRegisteredMode(async url => {
  process.env.META_APP_SECRET = "configured-secret";
  const phone = "51900000017", body = registeredPayload(phone);
  timers.set(phone, { id: 17, phone, active: true });
  assert.equal((await post(url, body)).status, 403);
  assert.equal((await post(url, body, { "X-Hub-Signature-256": `sha256=${"0".repeat(64)}` })).status, 403);
  assert.equal(directoryQueries.length, 0);
  const signature = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(JSON.stringify(body)).digest("hex")}`;
  assert.equal((await post(url, body, { "X-Hub-Signature-256": signature })).status, 200);
  assert.equal(processed[0].startListVerified, true);
  assert.equal(processed[0].startListAuthorization.mode, "registered_timer");
}));
