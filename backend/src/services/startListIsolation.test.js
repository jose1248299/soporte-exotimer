const test = require("node:test");
const assert = require("node:assert/strict");

// Exercise the real debounce/replay selection. Model and storage dependencies
// stay local: reaching classification only records the prompt and stops.
let pending = [], history = [], prompts = [], conversationReads = 0;
const stop = new Error("stop-after-capturing-local-prompt");
const unexpectedModelCall = () => { throw new Error("No other model path may run in this fixture"); };
require.cache[require.resolve("./ai")] = { exports: {
  classifyMessage: async input => { prompts.push(input); throw stop; },
  analyzeDocumentEvidence: unexpectedModelCall, analyzeImageEvidence: unexpectedModelCall,
  composeReply: unexpectedModelCall, sanitizeExternalReply: unexpectedModelCall,
} };
require.cache[require.resolve("../lib/prisma")] = { exports: {
  conversation: { findUnique: async () => { conversationReads++; return { id: 77, phone: "51900000001", channel: "WHATSAPP", userType: "UNKNOWN", classification: null }; } },
  timerContact: { findFirst: async () => null },
  message: {
    findFirst: async () => null,
    findMany: async query => query.where.direction === "INBOUND" ? pending.slice(0, query.take) : history,
  },
  supportAction: { findMany: async () => [] },
} };
const { processConversationReply, processInboundMessage } = require("./supportProcessor");
const at = new Date(Date.now() + 60000);
const imported = { id: 1, direction: "INBOUND", contentType: "TEXT", content: "IMPORT-ONLY-INSTRUCTION", timestamp: at,
  createdAt: at, aiMetadata: { source: "start_list_whatsapp", handled: true } };

test("Start List messages never reenter generic actions through pending debounce or replay", async () => {
  prompts = []; pending = [imported]; history = [imported];
  assert.equal(await processConversationReply(77), null);
  assert.equal(await processConversationReply(77, { replay: true }), null);
  assert.equal(prompts.length, 0);
});

test("ordinary support retains its prompt while both inbound and outbound import history stay isolated", async () => {
  prompts = [];
  const ordinary = { id: 2, direction: "INBOUND", contentType: "TEXT", content: "Quiero ver mi resultado", timestamp: at, createdAt: at, aiMetadata: null };
  pending = [imported, ordinary];
  history = [imported, { ...imported, id: 3, direction: "OUTBOUND" }, ordinary];
  await assert.rejects(() => processConversationReply(78), error => error === stop);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].text.includes(ordinary.content));
  assert.ok(!JSON.stringify(prompts[0]).includes(imported.content));
});

test("a timer revoked after webhook authorization is denied before creating or reading a conversation", async () => {
  conversationReads = 0;
  const result = await processInboundMessage({ from: "51900000001", whatsappUserId: "PE.666666666", text: "10K", type: "text",
    startListAuthorization: { mode: "registered_timer", phone: "51900000001", timerContactId: 17 } });
  assert.deepEqual(result, { handled: true, denied: true });
  assert.equal(conversationReads, 0);
});
