const test = require("node:test");
const assert = require("node:assert/strict");
const { authMode, registeredPhone, findActiveTimer, startListInput, createRequestLimiter } = require("./startListWhatsappAccess");

test("signature verification is the default and only the exact explicit mode enables directory trust", () => {
  const before = process.env.START_LIST_WHATSAPP_AUTH_MODE;
  try {
    for (const value of ["", "anything", "REGISTERED_TIMER", "meta_signature"]) {
      process.env.START_LIST_WHATSAPP_AUTH_MODE = value;
      assert.equal(authMode(), "meta_signature");
    }
    process.env.START_LIST_WHATSAPP_AUTH_MODE = "registered_timer";
    assert.equal(authMode(), "registered_timer");
  } finally { if (before == null) delete process.env.START_LIST_WHATSAPP_AUTH_MODE; else process.env.START_LIST_WHATSAPP_AUTH_MODE = before; }
});

test("directory trust accepts a complete numeric message.from without guessing country codes or stripping identities", async () => {
  const queried = [];
  const prisma = { timerContact: { findFirst: async ({ where }) => { queried.push(where); return { id: 3, phone: where.phone, active: true }; } } };
  for (const value of [null, 51900000001, "", "+51900000001", "51 900000001", "PE.51900000001", "00000000", "1234567890123456"]) {
    assert.equal(registeredPhone(value), null);
    assert.equal(await findActiveTimer(prisma, value), null);
  }
  assert.equal(queried.length, 0);
  assert.deepEqual(await findActiveTimer(prisma, "51900000001"), { id: 3, phone: "51900000001", active: true });
  assert.deepEqual(queried, [{ phone: "51900000001", active: true }]);
});

test("invalid import commands and spreadsheets are recognized before any generic support fallback", () => {
  for (const text of ["VINCULAR incorrecto", "CONFIRMAR nope", "ESTADO", "CANCELAR IMPORTACIÓN", "quiero cargar participantes"]) {
    assert.equal(startListInput({ text }).requested, true);
  }
  assert.equal(startListInput({ type: "document", media: { filename: "archivo.xlsx" } }).requested, true);
  assert.equal(startListInput({ text: "Hola, quiero ver mi resultado" }).requested, false);
});

test("request limits bound each phone, global traffic, debounce and tracked identities with expiry", () => {
  const perPhone = createRequestLimiter({ maxPerPhone: 2, maxGlobal: 4, minIntervalMs: 1000 });
  assert.equal(perPhone("a", 1000), true);
  assert.equal(perPhone("a", 1001), false);
  assert.equal(perPhone("a", 2000), true);
  assert.equal(perPhone("a", 3000), false);
  assert.equal(perPhone("b", 3000), true);
  assert.equal(perPhone("c", 3001), true);
  assert.equal(perPhone("d", 3002), false);
  assert.equal(perPhone("a", 63002), true);
  const bounded = createRequestLimiter({ maxPhones: 1 });
  assert.equal(bounded("a", 1000), true);
  assert.equal(bounded("b", 2000), false);
  assert.equal(bounded("b", 62000), true);
});
