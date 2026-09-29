const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  handleStartListInbound, senderHash, encryptToken, decryptToken,
  validMetaSignature, renderReview, channelRequest,
  preserveAttemptedAnalysis,
} = require("./startListWhatsapp");
const { createRequestLimiter } = require("./startListWhatsappAccess");

const previous = Object.fromEntries(["START_LIST_IMPORTS_ENABLED", "START_LIST_WHATSAPP_ENABLED", "START_LIST_WHATSAPP_ENCRYPTION_KEY", "START_LIST_WHATSAPP_AUTH_MODE"].map(name => [name, process.env[name]]));
process.env.START_LIST_IMPORTS_ENABLED = "true";
process.env.START_LIST_WHATSAPP_ENABLED = "true";
process.env.START_LIST_WHATSAPP_AUTH_MODE = "meta_signature";
process.env.START_LIST_WHATSAPP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
test.after(() => { for (const [name, value] of Object.entries(previous)) { if (value == null) delete process.env[name]; else process.env[name] = value; } });
const DBNULL = Symbol("Prisma.DbNull");
const batchId = "c13b7700-1111-4222-8333-444455556666";

function matches(record, where) {
  if (!record) return false;
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") return expected.some(part => matches(record, part));
    if (expected instanceof Date) return new Date(record[key]).getTime() === expected.getTime();
    if (expected && typeof expected === "object" && "lt" in expected) return record[key] != null && new Date(record[key]) < expected.lt;
    if (expected === null) return record[key] == null;
    return record[key] === expected;
  });
}

function harness({ linked = true, count = 1 } = {}) {
  let time = new Date("2026-09-30T15:00:00.000Z");
  const hash = senderHash("51900000001");
  let session = linked ? { phoneHash: hash, batchId, encryptedToken: encryptToken("delegated-test-token", hash), expiresAt: new Date(time.getTime() + 3600000), pendingConfirmation: null, processingUntil: null } : null;
  const messages = [];
  const updates = [];
  const sends = [];
  const calls = [];
  const timer = { id: 17, phone: "51900000001", active: true };
  let sessionReads = 0;
  let sequence = 0;
  const candidates = Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, source: { sheetName: "Lista", row: index + 2 }, values: { fullName: `Participante de prueba ${index}`, gender: "F", category: "Libre", distance: "10K", start: "General", dorsal: String(index + 1) }, eventId: 100, categoryId: 200, categoryMode: "basic", policyVersion: 1, issues: [] }));
  let batch = {
    id: batchId, competition_id: 10, version: 1, preview_token: "preview-v1", preview_row_keys: candidates.map(row => row.id),
    metadata: { start_list: { analysis: { sourceWorkbook: { test: true }, plan: { version: 1, blocks: [] }, candidates, questions: [], excludedRows: [], unassignedRows: [] }, decisions: {}, messages: [] } },
    rows: candidates.map(candidate => ({ row_key: candidate.id, status: "ready", attempted: false, payload: { event_id: 100, dorsal: candidate.values.dorsal }, source_ref: { row: candidate.source.row }, validation: { valid: true, assignment: { status: "created", category_id: 200 } } })),
  };
  const catalog = { competitionId: 10, events: [{ id: 100, name: "10K", categoryMode: "basic", policyVersion: 1, categories: [{ id: 200, name: "Libre", gender: "F" }], starts: [{ id: 300, name: "General" }] }] };
  const patch = data => { for (const [key, value] of Object.entries(data)) session[key] = value === DBNULL ? null : structuredClone(value); };
  const prisma = {
    timerContact: { findFirst: async ({ where }) => matches(timer, where) ? structuredClone(timer) : null },
    startListWhatsappSession: {
      findUnique: async ({ where }) => { sessionReads++; return matches(session, where) ? structuredClone(session) : null; },
      upsert: async ({ create, update }) => {
        if (!session) session = { pendingConfirmation: null, processingUntil: null, ...structuredClone(create) };
        else patch(update);
        return structuredClone(session);
      },
      updateMany: async ({ where, data }) => {
        updates.push({ where, data });
        if (!matches(session, where)) return { count: 0 };
        patch(data);
        return { count: 1 };
      },
      deleteMany: async ({ where }) => {
        if (!matches(session, where)) return { count: 0 };
        session = null; return { count: 1 };
      },
    },
    message: {
      findUnique: async ({ where }) => messages.find(message => message.waId === where.waId) || null,
      create: async ({ data }) => {
        if (data.waId && messages.some(message => message.waId === data.waId)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
        const message = { id: ++sequence, ...structuredClone(data) }; messages.push(message); return message;
      },
    },
  };
  let overrideRequest = null;
  const defaultRequest = async (path, options) => {
    if (path === "redeem") return { batch_id: batchId, token: "new-delegated-test-token", expires_at: new Date(time.getTime() + 3600000).toISOString() };
    if (path === "catalog") return structuredClone(catalog);
    if (path === "batch" && options.method === "GET") return structuredClone(batch);
    if (path === "batch" && options.method === "PATCH") {
      batch.version += 1;
      batch.metadata = structuredClone(options.body.metadata);
      const before = new Map(batch.rows.map(row => [row.row_key, row]));
      batch.rows = options.body.rows.map(row => ({ ...structuredClone(row), status: before.get(row.row_key)?.attempted ? before.get(row.row_key).status : "pending", attempted: before.get(row.row_key)?.attempted || false }));
      batch.preview_token = null; batch.preview_row_keys = [];
      return structuredClone(batch);
    }
    if (path === "preview") {
      batch.preview_token ||= "preview-renewed";
      for (const key of options.body.row_keys) {
        const row = batch.rows.find(row => row.row_key === key);
        row.status = "ready"; row.validation = { valid: true, assignment: { status: row.attempted ? "existing" : "created", category_id: 200 } };
      }
      batch.preview_row_keys = [...new Set([...batch.preview_row_keys, ...options.body.row_keys])];
      return structuredClone(batch);
    }
    if (path === "commit") {
      for (const key of options.body.row_keys) {
        const row = batch.rows.find(row => row.row_key === key);
        row.attempted = true; row.status = "imported"; row.receipt = { status: "created", resultId: key };
      }
      return structuredClone(batch);
    }
    if (path === "revoke") return { revoked: true };
    throw new Error(`Unexpected mocked path ${path}`);
  };
  const dependencies = {
    prisma, dbNull: DBNULL, now: () => new Date(time), allowRequest: () => true,
    waba: { sendTextMessage: async (phone, text) => { sends.push({ phone, text }); return { messages: [{ id: `out-${sends.length}` }] }; }, downloadMedia: async () => ({ buffer: Buffer.from("test-only"), mimeType: "text/csv" }) },
    request: async (path, options) => { calls.push({ path, options: structuredClone(options) }); return overrideRequest ? overrideRequest(path, options, defaultRequest) : defaultRequest(path, options); },
    analyze: async () => structuredClone(batch.metadata.start_list.analysis),
    reanalyze: () => structuredClone(batch.metadata.start_list.analysis),
    resolve: async () => ({ answers: [], clarification: "" }),
  };
  return {
    dependencies, calls, updates, sends, messages, catalog, timer,
    get sessionReads() { return sessionReads; },
    get session() { return session; }, get batch() { return batch; },
    advance(ms) { time = new Date(time.getTime() + ms); },
    overrideRequest(fn) { overrideRequest = fn; },
    async send(text, extra = {}) {
      return handleStartListInbound({ verified: true, phone: "51900000001", conversation: { id: 77 }, text, type: "text", waId: `in-${++sequence}`, ...extra }, dependencies);
    },
  };
}

test("signatures and tokens are bound to exact bytes and sender identities", () => {
  const body = Buffer.from('{"fixture":true}');
  const signature = `sha256=${crypto.createHmac("sha256", "test-app-secret").update(body).digest("hex")}`;
  assert.equal(validMetaSignature(body, signature, "test-app-secret"), true);
  assert.equal(validMetaSignature(Buffer.from("changed"), signature, "test-app-secret"), false);
  assert.equal(validMetaSignature(body, signature, ""), false);
  const hash = senderHash("test.sender");
  const encrypted = encryptToken("delegated-token", hash);
  assert.equal(decryptToken(encrypted, hash), "delegated-token");
  assert.throws(() => decryptToken(encrypted, senderHash("other.sender")));
  assert.throws(() => decryptToken("broken", hash));
  assert.throws(() => senderHash(undefined));
});

test("unverified webhooks and repeated provider message IDs never reach Registration", async () => {
  const h = harness();
  assert.equal(await h.send("ESTADO", { verified: false }), null);
  assert.equal(h.calls.length, 0);
  await h.send("ESTADO", { waId: "same-message" });
  const count = h.calls.length;
  assert.deepEqual(await h.send("ESTADO", { waId: "same-message" }), { duplicated: true });
  assert.equal(h.calls.length, count);
});

test("an explicit import request gets linking guidance without hijacking ordinary support", async () => {
  const h = harness({ linked: false });
  const result = await h.send("Quiero importar una lista de participantes desde Excel");
  assert.ok(result.reply.includes("Continuar en WhatsApp"));
  assert.ok(result.reply.includes("VINCULAR"));
  assert.equal(h.calls.length, 0);
  assert.equal(await h.send("Quiero ver mi resultado"), null);
});

test("VINCULAR acquires the same sender lease and never replaces a session in use", async () => {
  const h = harness({ linked: false });
  let allowRedeem;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { allowRedeem = resolve; });
  h.overrideRequest(async (path, options, fallback) => { if (path === "redeem") { markStarted(); await gate; } return fallback(path, options); });
  const first = h.send("VINCULAR AAAAAAAAAAAAAAAAAAAA");
  await started;
  const second = await h.send("VINCULAR BBBBBBBBBBBBBBBBBBBB");
  assert.ok(second.reply.includes("procesando"));
  assert.equal(h.calls.filter(call => call.path === "redeem").length, 1);
  allowRedeem();
  await first;
  assert.equal(h.session.batchId, batchId);
  assert.equal(h.session.processingUntil, null);
  assert.equal(h.session.pendingConfirmation, null);
  assert.ok(h.updates.some(update => update.data.pendingConfirmation === DBNULL));
  assert.equal(decryptToken(h.session.encryptedToken, h.session.phoneHash), "new-delegated-test-token");
});

test("bad ciphertext releases/deletes its lease and does not call a data endpoint", async () => {
  const h = harness();
  h.session.encryptedToken = "not-an-encrypted-token";
  const result = await h.send("ESTADO");
  assert.ok(result.reply.includes("recuperar la vinculación"));
  assert.equal(h.calls.length, 0);
  assert.equal(h.session, null);
});

test("the exact reviewed command commits only its selected rows and consumes confirmation first", async () => {
  const h = harness({ count: 2 });
  h.batch.metadata.start_list.analysis.candidates[1].issues = [{ severity: "error", message: "Fixture pending" }];
  const review = await h.send("ESTADO");
  const confirmation = structuredClone(h.session.pendingConfirmation);
  assert.match(confirmation.command, /^CONFIRMAR [A-F0-9]{8} V\d+ [A-F0-9]{32}$/);
  assert.ok(h.sends.at(-1).text.includes(confirmation.command));
  assert.ok(!review.reply.includes(confirmation.command));
  assert.ok(h.messages.every(message => !message.content?.includes(confirmation.command)));
  assert.deepEqual(confirmation.rowKeys, ["row-0"]);
  h.overrideRequest(async (path, options, fallback) => {
    if (path === "commit") assert.equal(h.session.pendingConfirmation, null);
    return fallback(path, options);
  });
  await h.send(confirmation.command);
  assert.ok(h.messages.every(message => !message.content?.includes(confirmation.command)));
  assert.deepEqual(h.calls.find(call => call.path === "commit").options.body.row_keys, ["row-0"]);
  assert.equal(h.batch.rows[0].status, "imported");
  assert.equal(h.batch.rows[1].status, "ready");
  assert.equal(h.session.processingUntil, null);
});

async function registeredMode(run) {
  process.env.START_LIST_WHATSAPP_AUTH_MODE = "registered_timer";
  try { await run(); } finally { process.env.START_LIST_WHATSAPP_AUTH_MODE = "meta_signature"; }
}
const registeredInput = { verified: false, authorization: { mode: "registered_timer", phone: "51900000001", timerContactId: 17 } };

test("registered-timer mode pins responses and session keys to the directory phone, ignoring injected IDs", () => registeredMode(async () => {
  const h = harness();
  await h.send("ESTADO", { ...registeredInput, whatsappUserId: "PE.666666666" });
  assert.ok(h.sends.length);
  assert.ok(h.sends.every(message => message.phone === h.timer.phone));
  assert.ok(h.calls.every(call => call.options.phoneHash === senderHash(h.timer.phone)));
  const command = h.session.pendingConfirmation.command;
  await h.send(command, { ...registeredInput, whatsappUserId: "PE.666666666" });
  assert.equal(h.batch.rows[0].status, "imported");
  await h.send(command, registeredInput);
  assert.equal(h.calls.filter(call => call.path === "commit").length, 1);
}));

test("unknown or inactive phones cannot read a session, download files, or reach Registration", () => registeredMode(async () => {
  for (const extra of [{ phone: "51900000009" }, { inactive: true }, { phone: "+51900000001" }, { phone: "" }]) {
    const h = harness();
    if (extra.inactive) h.timer.active = false;
    h.dependencies.waba.downloadMedia = async () => { throw new Error("An unauthorized file must not be fetched"); };
    const result = await h.send("", { ...registeredInput, ...extra, type: "document", media: { id: "unknown", filename: "lista.csv" } });
    assert.deepEqual(result, { handled: true, denied: true });
    assert.equal(h.sessionReads, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.messages.length, 0);
    assert.equal(h.sends.length, 0);
  }
}));

test("revoking a registered timer during validation blocks the following commit and removes its local session", () => registeredMode(async () => {
  const h = harness();
  await h.send("ESTADO", registeredInput);
  const command = h.session.pendingConfirmation.command;
  h.overrideRequest(async (path, options, fallback) => {
    const value = await fallback(path, options);
    if (path === "batch" && options.method === "GET") h.timer.active = false;
    return value;
  });
  const result = await h.send(command, registeredInput);
  assert.equal(result.denied, true);
  assert.equal(h.calls.filter(call => call.path === "commit").length, 0);
  assert.equal(h.session, null);
}));

test("five forged confirmations invalidate the secret command and impose a persistent cooldown", () => registeredMode(async () => {
  const h = harness();
  await h.send("ESTADO", registeredInput);
  const realCommand = h.session.pendingConfirmation.command;
  const forged = `${realCommand.slice(0, -32)}${"0".repeat(32)}`;
  for (let count = 0; count < 5; count++) await h.send(forged, registeredInput);
  assert.equal(h.session.pendingConfirmation.failedAttempts, 5);
  assert.ok(h.session.pendingConfirmation.lockedUntil);
  assert.equal(h.session.pendingConfirmation.command, undefined);
  await h.send(realCommand, registeredInput);
  await h.send("ESTADO", registeredInput);
  assert.equal(h.session.pendingConfirmation.command, undefined);
  assert.equal(h.calls.filter(call => call.path === "commit").length, 0);
  h.advance(5 * 60000 + 1);
  await h.send("ESTADO", registeredInput);
  assert.notEqual(h.session.pendingConfirmation.command, realCommand);
  await h.send(realCommand, registeredInput);
  assert.equal(h.calls.filter(call => call.path === "commit").length, 0);
}));

test("request limits stop repeated commands before recording or sending messages or calling Registration", () => registeredMode(async () => {
  const h = harness();
  h.dependencies.allowRequest = createRequestLimiter({ maxPerPhone: 2, minIntervalMs: 1000 });
  await h.send("ESTADO", registeredInput);
  const before = { calls: h.calls.length, messages: h.messages.length, sends: h.sends.length };
  assert.equal((await h.send("ESTADO", registeredInput)).rateLimited, true);
  assert.deepEqual({ calls: h.calls.length, messages: h.messages.length, sends: h.sends.length }, before);
  h.advance(1000);
  await h.send("ESTADO", registeredInput);
  h.advance(1000);
  assert.equal((await h.send("ESTADO", registeredInput)).rateLimited, true);
}));

test("stale version, token, assignment, row set or expired confirmation blocks every write", async () => {
  const changes = [
    h => { h.batch.version++; },
    h => { h.batch.preview_token = "different-token"; },
    h => { h.batch.rows[0].validation.assignment.category_id = 999; },
    h => { h.batch.rows[0].payload.event_id = 999; },
    h => { h.batch.preview_row_keys = []; },
    h => { h.session.pendingConfirmation.rowKeys.push("other-row"); },
    h => { h.session.pendingConfirmation.expiresAt = "not-a-date"; },
    h => { h.advance(16 * 60 * 1000); },
  ];
  for (const change of changes) {
    const h = harness();
    await h.send("ESTADO");
    const command = h.session.pendingConfirmation.command;
    change(h);
    const result = await h.send(command);
    assert.ok(result.reply.includes("no corresponde"));
    assert.equal(h.calls.filter(call => call.path === "commit").length, 0);
  }
});

test("uncertain commits are never retried by a repeated confirmation", async () => {
  const h = harness();
  await h.send("ESTADO");
  const command = h.session.pendingConfirmation.command;
  h.overrideRequest(async (path, options, fallback) => {
    const response = await fallback(path, options);
    if (path === "commit") throw new Error("network acknowledgement lost");
    return response;
  });
  const failed = await h.send(command);
  assert.ok(failed.reply.includes("No volveré a enviarlo automáticamente"));
  assert.equal(h.session.pendingConfirmation, null);
  await h.send(command);
  assert.equal(h.calls.filter(call => call.path === "commit").length, 1);
  await h.send("ESTADO");
  assert.equal(h.calls.filter(call => call.path === "commit").length, 1);
  assert.equal(h.batch.rows[0].status, "imported");
});

test("ESTADO can revalidate an attempted failure but requires a new confirmation for recovery", async () => {
  const h = harness();
  h.batch.rows[0].attempted = true;
  h.batch.rows[0].status = "failed";
  await h.send("ESTADO");
  assert.equal(h.calls.filter(call => call.path === "preview").length, 1);
  assert.equal(h.calls.filter(call => call.path === "commit").length, 0);
  const command = h.session.pendingConfirmation.command;
  await h.send(command);
  assert.equal(h.calls.filter(call => call.path === "commit").length, 1);
});

test("heartbeat renewals and chunked previews/commits preserve one lease", async () => {
  const h = harness({ count: 101 });
  h.dependencies.heartbeatMs = 5;
  h.batch.rows.forEach(row => { row.status = "pending"; });
  h.batch.preview_row_keys = [];
  h.overrideRequest(async (path, options, fallback) => {
    if (["preview", "commit"].includes(path)) await new Promise(resolve => setTimeout(resolve, 20));
    return fallback(path, options);
  });
  await h.send("ESTADO");
  assert.equal(h.calls.filter(call => call.path === "preview").length, 2);
  assert.ok(h.updates.filter(update => update.data.processingUntil instanceof Date).length > 10);
  await h.send(h.session.pendingConfirmation.command);
  assert.equal(h.calls.filter(call => call.path === "commit").length, 2);
  assert.equal(h.session.processingUntil, null);
});

test("conversational answers are constrained by regenerated questions and current catalog", async () => {
  const h = harness();
  h.batch.metadata.start_list.analysis.questions = [{ id: "old", options: [{ id: "event:999" }] }];
  const current = structuredClone(h.batch.metadata.start_list.analysis);
  current.questions = [{ id: "current", type: "distance", required: true, resolved: false, rowIds: ["row-0"], title: "Distancia", options: [{ id: "event:100", label: "10K" }] }];
  h.dependencies.reanalyze = ({ catalog }) => { assert.equal(catalog.events[0].id, 100); return structuredClone(current); };
  h.dependencies.resolve = async ({ questions }) => {
    assert.equal(questions[0].id, "current");
    return { answers: [{ questionId: "old", optionId: "event:999" }, { questionId: "current", optionId: "event:100" }], clarification: "" };
  };
  await h.send("Los de larga son de 10K");
  const patch = h.calls.find(call => call.path === "batch" && call.options.method === "PATCH");
  assert.deepEqual(patch.options.body.metadata.start_list.decisions, { current: "event:100" });
});

test("cancel revokes the backend grant, deletes only its session and preserves imported rows", async () => {
  const h = harness();
  h.batch.rows[0].status = "imported"; h.batch.rows[0].attempted = true;
  await h.send("CANCELAR IMPORTACION");
  assert.equal(h.calls.filter(call => call.path === "revoke").length, 1);
  assert.equal(h.session, null);
  assert.equal(h.batch.rows[0].status, "imported");
});

test("a lost lease cannot clear or mutate a newer sender session", async () => {
  const h = harness();
  h.overrideRequest(async (path, options, fallback) => {
    if (path === "batch") { h.session.batchId = "another-batch"; h.session.processingUntil = new Date("2026-09-30T16:00:00Z"); }
    return fallback(path, options);
  });
  await h.send("ESTADO");
  assert.equal(h.session.batchId, "another-batch");
  assert.ok(h.session.processingUntil instanceof Date);
  assert.equal(h.calls.filter(call => call.path === "commit").length, 0);
});

test("unscoped channel paths and missing candidate evidence never become writable selections", async () => {
  await assert.rejects(() => channelRequest("../../results", { method: "POST" }), /no permitida/);
  const h = harness();
  h.batch.metadata.start_list.analysis.candidates = [];
  assert.deepEqual(renderReview(h.batch).readyKeys, []);
  await h.send("ESTADO");
  assert.equal(h.session.pendingConfirmation, null);
});

test("reanalyzing a partial import preserves attempted participants and their displayed assignment", () => {
  const original = { candidates: [{ id: "done", values: { start: "Primera" }, startId: 1, status: "ready" }] };
  const changed = { candidates: [{ id: "done", values: { start: "Segunda" }, startId: 2, status: "ready" }, { id: "new", status: "pending" }],
    excludedRows: [{ id: "done" }], unassignedRows: [{ id: "done" }],
    questions: [{ type: "start", rowIds: ["done", "new"] }, { type: "row", rowIds: ["done"] }], summary: {} };
  const preserved = preserveAttemptedAnalysis(changed, original, [{ row_key: "done", attempted: true }]);
  assert.equal(preserved.candidates.find(row => row.id === "done").startId, 1);
  assert.equal(preserved.candidates.find(row => row.id === "done").values.start, "Primera");
  assert.deepEqual(preserved.excludedRows, []);
  assert.deepEqual(preserved.unassignedRows, []);
  assert.deepEqual(preserved.questions.map(question => question.rowIds), [["new"]]);
});

test("a busy shared analyzer asks for a later resend without changing the draft or holding the chat lease", async () => {
  const h = harness();
  const before = structuredClone(h.batch);
  h.dependencies.analyze = async () => { throw Object.assign(new Error("Another file is being analyzed"), { code: "analysis_busy" }); };
  await h.send("", { type: "document", media: { id: "synthetic-media", filename: "lista.csv", mimeType: "text/csv" } });
  assert.match(h.sends.at(-1).text, /otro archivo en análisis.*vuelve a enviar tu archivo/);
  assert.deepEqual(h.batch, before);
  assert.equal(h.session.processingUntil, null);
  assert.equal(h.calls.filter(call => ["preview", "commit"].includes(call.path) || call.options.method === "PATCH").length, 0);
});
