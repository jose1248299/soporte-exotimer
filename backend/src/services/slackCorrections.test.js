const test = require("node:test");
const assert = require("node:assert/strict");
const { createSlackCorrections, isTimeCorrection, actionObservation, validateSettings, renderPayload } = require("./slackCorrections");

const settings = { enabled: true, webhookUrl: "https://hooks.slack.com/services/T_SIMULATED/B_SIMULATED/NOT_A_REAL_SECRET",
  caseBaseUrl: "https://support.example.test/", includeReply: false };
const classification = { action: "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION", summary: "Corregir tiempo" };

// Simulated persistence only: no production database, Slack, OpenAI, Meta or Race Line calls.
function fixture({ send, options = {} } = {}) {
  let clock = new Date("2026-10-09T12:00:00Z");
  let state = { messages: [], actions: [], cursors: [], watches: [], notifications: [], observed: [] };
  let transaction = Promise.resolve();
  let sends = [];
  const names = { message: "messages", supportAction: "actions", slackCorrectionCursor: "cursors",
    slackCorrectionWatch: "watches", slackCorrectionNotification: "notifications", slackCorrectionObservedReply: "observed" };
  const match = (row, where, table) => Object.entries(where || {}).every(([key, value]) => {
    if (key === "slackObservation") return !state.observed.some(item => item.messageId === row.id);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, expected]) => {
        if (operator === "in") return expected.includes(row[key]);
        if (operator === "gt") return row[key] > expected;
        if (operator === "gte") return row[key] >= expected;
        if (operator === "lt") return row[key] < expected;
        if (operator === "lte") return row[key] <= expected;
        throw new Error(`Unsupported fake query: ${table}.${key}.${operator}`);
      });
    }
    return row[key] === value;
  });
  const change = (row, data) => {
    for (const [key, value] of Object.entries(data)) row[key] = value?.increment ? (row[key] || 0) + value.increment : value;
    if (Object.keys(data).length) row.updatedAt = new Date(clock);
    return structuredClone(row);
  };
  const db = {};
  for (const [table, rows] of Object.entries(names)) {
    db[table] = {
      findMany: async ({ where, orderBy, take } = {}) => {
        const found = state[rows].filter(row => match(row, where, table));
        const order = Object.entries(orderBy || {})[0];
        if (order) found.sort((a, b) => (a[order[0]] > b[order[0]] ? 1 : a[order[0]] < b[order[0]] ? -1 : 0) * (order[1] === "desc" ? -1 : 1));
        return structuredClone(take ? found.slice(0, take) : found);
      },
      findUnique: async ({ where }) => structuredClone(state[rows].find(row => match(row, where, table)) || null),
      create: async ({ data }) => {
        const row = { id: state[rows].length + 1, createdAt: new Date(clock), updatedAt: new Date(clock),
          ...(rows === "notifications" ? { state: "PENDING", attempts: 0 } : {}),
          ...(rows === "cursors" ? { lastWatchId: 0 } : {}), ...data };
        if (state[rows].some(item => rows === "observed" ? item.messageId === row.messageId :
          rows === "notifications" ? item.eventKey === row.eventKey : rows === "watches" ? item.key === row.key : item.id === row.id)) {
          throw Object.assign(new Error("unique constraint"), { code: "P2002" });
        }
        state[rows].push(row);
        return structuredClone(row);
      },
      update: async ({ where, data }) => {
        const row = state[rows].find(item => match(item, where, table));
        assert.ok(row, `Missing ${table} to update`);
        return change(row, data);
      },
      updateMany: async ({ where, data }) => {
        const found = state[rows].filter(row => match(row, where, table));
        for (const row of found) change(row, data);
        return { count: found.length };
      },
    };
    db[table].findFirst = async args => (await db[table].findMany({ ...args, take: 1 }))[0] || null;
    db[table].upsert = async ({ where, create, update }) => {
      const existing = await db[table].findUnique({ where });
      return existing ? db[table].update({ where, data: update }) : db[table].create({ data: create });
    };
  }
  db.$transaction = fn => {
    const run = transaction.then(async () => {
      const snapshot = structuredClone(state);
      try { return await fn(db); } catch (error) { state = snapshot; throw error; }
    });
    transaction = run.catch(() => {});
    return run;
  };
  const opts = { ...settings, ...options };
  const transport = async (url, payload) => { sends.push({ url, payload }); return send ? send(url, payload) : { status: 200, body: "ok" }; };
  const createWorker = () => createSlackCorrections({ db, settings: opts, send: transport, now: () => new Date(clock) });
  return { db, options: opts, worker: createWorker(), createWorker, get rows() { return state; }, get sends() { return sends; },
    advance: ms => { clock = new Date(clock.getTime() + ms); },
    reply: (id, overrides = {}) => state.messages.push({ id, conversationId: 8, supportCaseId: 21, direction: "OUTBOUND",
      content: "Se corrigió el tiempo de Ana, DNI 12345678, teléfono +51912345678", aiMetadata: { classification }, createdAt: new Date(clock), ...overrides }),
    action: (overrides = {}) => state.actions.push({ id: 5, conversationId: 8, supportCaseId: 21, name: classification.action,
      status: "EXECUTED", output: { verification: { verified: true } }, updatedAt: new Date(clock), ...overrides }),
  };
}

test("disabled or invalid configuration never reads persistence or calls transport", async () => {
  for (const options of [{ enabled: false }, { webhookUrl: "http://localhost/steal" }, { caseBaseUrl: "" }]) {
    const worker = createSlackCorrections({ db: new Proxy({}, { get() { throw new Error("DB must remain untouched"); } }),
      settings: { ...settings, ...options }, send() { throw new Error("must not send"); } });
    await worker.tick();
  }
  assert.equal(validateSettings(settings), true);
  for (const url of ["https://hooks.slack.com.evil.test/services/T/B/S", "https://hooks.slack.com:8080/services/T/B/S",
    "https://user:pass@hooks.slack.com/services/T/B/S", "https://hooks.slack.com/services/T/B/S?secret=1"]) {
    assert.equal(validateSettings({ ...settings, webhookUrl: url }), false);
  }
});

test("triage distinguishes time correction from registration, bib and ordinary enquiries", () => {
  assert.equal(isTimeCorrection(classification), true);
  assert.equal(isTimeCorrection({ intent: "Revisar tiempo incorrecto", action: null }), true);
  assert.equal(isTimeCorrection({ action: "EXOTIMER_CREATE_RESULT_CORRECTION_CASE", summary: "Corregir dorsal" }), false);
  assert.equal(isTimeCorrection({ action: "EXOTIMER_UPDATE_INSCRIPTION_EMAIL", summary: "Error al registrar tiempo de inscripción" }), false);
  assert.equal(isTimeCorrection({ intent: "Consultar tiempo" }), false);
});

test("only explicit verified timing evidence implies completion; executed or resolved does not", () => {
  assert.equal(actionObservation({ name: classification.action, status: "EXECUTED", output: { verification: { verified: true } } }).code, "VERIFIED");
  assert.equal(actionObservation({ name: classification.action, status: "FAILED", output: { verification: { verified: false } } }).code, "MISMATCH");
  assert.equal(actionObservation({ name: "EXOTIMER_EDIT_RESULT_TIME", status: "EXECUTED", output: { verification: { officialTime: "01:02:00" } } }).code, "UNVERIFIED");
  assert.equal(actionObservation({ name: "EXOTIMER_CREATE_RESULT_CORRECTION_CASE", status: "EXECUTED" }).code, "REGISTERED");
  assert.equal(actionObservation({ name: "EXOTIMER_UPDATE_RESULT_DORSAL", status: "EXECUTED" }), null);
});

test("ID and authenticated case link are the only case data shared by default", async () => {
  const f = fixture();
  await f.worker.tick();
  f.reply(1);
  await f.worker.tick();
  assert.equal(f.sends.length, 1);
  const serialized = JSON.stringify(f.sends[0].payload);
  for (const personal of ["Ana", "12345678", "+51912345678", "Se corrigió"]) assert.ok(!serialized.includes(personal));
  assert.equal(f.sends[0].payload.blocks[1].elements[0].url, "https://support.example.test/?conversation=8&case=21");
  assert.equal(f.sends[0].payload.unfurl_links, false);
  assert.deepEqual(Object.keys(f.rows.notifications[0].payload).sort(), ["identifier", "url"]);
  assert.deepEqual(f.sends[0].payload, {
    text: "Caso #21",
    blocks: [
      { type: "section", text: { type: "plain_text", text: "Caso #21", emoji: false } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Abrir caso en soporte" },
        url: "https://support.example.test/?conversation=8&case=21" }] },
    ],
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.deepEqual(f.rows.messages[0].aiMetadata.classification, classification);
  assert.equal(f.rows.actions.length, 0);
});

test("first activation excludes history; late commits and restarts do not lose or duplicate replies", async () => {
  const f = fixture();
  f.reply(1);
  f.advance(1000);
  await f.worker.tick();
  assert.equal(f.sends.length, 0);
  f.reply(4);
  await f.worker.tick();
  f.reply(3, { supportCaseId: 22 }); // Earlier ID, later commit.
  f.advance(1000);
  await f.createWorker().tick();
  f.advance(1000);
  await f.createWorker().tick();
  assert.equal(f.sends.length, 2);
  assert.equal(f.rows.observed.length, 2);
  assert.equal(f.rows.notifications.length, 2);
});

test("provisional conversation promotes to a case and repeated triage produces one request notice", async () => {
  const f = fixture();
  await f.worker.tick();
  f.reply(1, { supportCaseId: null });
  await f.worker.tick();
  f.reply(2);
  f.advance(1000);
  await f.worker.tick();
  assert.equal(f.rows.watches.length, 1);
  assert.equal(f.rows.watches[0].supportCaseId, 21);
  assert.equal(f.rows.notifications.length, 1);
  assert.equal(f.sends.length, 1);
});

test("legacy reply flag cannot expand shared data; repeated saved responses remain deduplicated", async () => {
  const f = fixture({ options: { includeReply: true } });
  await f.worker.tick();
  f.reply(1, { content: "<@here> A" });
  await f.worker.tick();
  f.reply(2, { content: "B" });
  f.advance(1000);
  await f.worker.tick();
  f.reply(3, { content: "<@here> A" });
  f.advance(1000);
  await f.worker.tick();
  assert.equal(f.sends.length, 2);
  for (const send of f.sends) {
    assert.equal(send.payload.blocks.length, 2);
    assert.equal(send.payload.text, "Caso #21");
    assert.ok(!JSON.stringify(send.payload).includes("<@here>"));
  }
  for (const row of f.rows.notifications) {
    assert.deepEqual(Object.keys(row.payload).sort(), ["identifier", "url"]);
  }
});

test("legacy queued payloads are filtered at delivery without rewriting their audit history", async () => {
  const f = fixture({ options: { includeReply: true } });
  await f.worker.tick();
  f.reply(1);
  await f.worker.observeReply(f.rows.messages[0]);
  const event = f.rows.notifications[0];
  Object.assign(event.payload, { status: "PRIVATE_STATUS", reply: "PRIVATE_REPLY", athleteName: "PRIVATE_NAME" });
  await f.worker.deliver(structuredClone(event));
  const rendered = JSON.stringify(f.sends[0].payload);
  for (const value of ["PRIVATE_STATUS", "PRIVATE_REPLY", "PRIVATE_NAME"]) assert.ok(!rendered.includes(value));
  assert.equal(event.payload.status, "PRIVATE_STATUS");
  assert.equal(event.payload.reply, "PRIVATE_REPLY");
  assert.equal(event.state, "SENT");
  assert.equal(renderPayload(event.payload, true).blocks.length, 2);
});

test("replaying the same saved message and SENT event through fresh workers does not send again", async () => {
  const f = fixture();
  await f.worker.tick();
  f.reply(1);
  await f.worker.tick();
  const event = structuredClone(f.rows.notifications[0]);
  for (let i = 0; i < 2; i++) {
    const worker = f.createWorker();
    await worker.observeReply(structuredClone(f.rows.messages[0]));
    await worker.deliver(event);
  }
  assert.equal(f.sends.length, 1);
  assert.equal(f.rows.observed.length, 1);
  assert.equal(f.rows.notifications.length, 1);
  assert.equal(f.rows.notifications[0].eventKey, event.eventKey);
  assert.equal(f.rows.notifications[0].attempts, 1);
  assert.equal(f.rows.notifications[0].state, "SENT");
});

test("observes human action transitions without invoking corrections; reused action is deduplicated", async () => {
  const f = fixture();
  await f.worker.tick();
  f.reply(1);
  f.action({ status: "PROPOSED", output: null });
  await f.worker.tick();
  f.advance(1000);
  await f.worker.tick();
  f.rows.actions[0].status = "EXECUTED";
  f.rows.actions[0].output = { verification: { verified: true } };
  f.advance(1000);
  await f.worker.tick();
  f.advance(1000);
  await f.worker.tick();
  f.action({ id: 6, status: "SKIPPED", output: { idempotentReplay: true, reusedFromActionId: 5, verification: { verified: true } } });
  f.advance(1000);
  await f.worker.tick();
  assert.equal(f.sends.length, 3);
  assert.equal(f.rows.notifications.filter(row => row.eventKey.endsWith(":VERIFIED")).length, 1);
  assert.equal(f.rows.actions.length, 2);
});

test("concurrent delivery claims reserve one POST per event", async () => {
  const f = fixture();
  await f.worker.tick();
  f.reply(1);
  await f.worker.observeReply(f.rows.messages[0]);
  const event = f.rows.notifications[0];
  await Promise.all([f.worker.deliver(event), f.createWorker().deliver(event)]);
  assert.equal(f.sends.length, 1);
  assert.equal(f.rows.notifications[0].state, "SENT");
});

test("429 retries only after Retry-After; permanent and uncertain failures never auto-resend", async () => {
  let responses = 0;
  const f = fixture({ send: () => ++responses === 1 ? { status: 429, retryAfter: "10" } : { status: 200, body: "ok" } });
  await f.worker.tick();
  f.reply(1);
  await f.worker.tick();
  f.advance(9000);
  await f.worker.tick();
  assert.equal(f.sends.length, 1);
  f.advance(1000);
  await f.worker.tick();
  assert.equal(f.sends.length, 2);
  assert.equal(f.rows.notifications[0].state, "SENT");
  for (const response of [{ status: 400 }, { status: 500 }, null]) {
    const uncertain = fixture({ send: () => { if (response) return response; throw new Error("URL with secret must not be logged"); } });
    await uncertain.worker.tick();
    uncertain.reply(1);
    await uncertain.worker.tick();
    uncertain.advance(60000);
    await uncertain.createWorker().tick();
    assert.equal(uncertain.sends.length, 1);
    assert.equal(uncertain.rows.notifications[0].state, response?.status === 400 ? "FAILED" : "UNCERTAIN");
    assert.ok(!uncertain.rows.notifications[0].lastError.includes("secret"));
  }
});

test("crash after provider acceptance leaves an uncertain record without resending", async () => {
  const f = fixture();
  await f.worker.tick();
  f.reply(1);
  const original = f.db.slackCorrectionNotification.update;
  f.db.slackCorrectionNotification.update = async () => { throw new Error("DB disconnected after POST"); };
  await assert.rejects(() => f.worker.tick());
  assert.equal(f.rows.notifications[0].state, "SENDING");
  f.db.slackCorrectionNotification.update = original;
  f.advance(31000);
  await f.createWorker().tick();
  assert.equal(f.rows.notifications[0].state, "UNCERTAIN");
  assert.equal(f.sends.length, 1);
});

test("failed observation transaction is retried without losing the saved reply", async () => {
  const f = fixture();
  await f.worker.tick();
  f.reply(1);
  const original = f.db.slackCorrectionNotification.upsert;
  f.db.slackCorrectionNotification.upsert = async () => { throw new Error("temporary DB failure"); };
  await assert.rejects(() => f.worker.tick());
  assert.equal(f.rows.observed.length, 0);
  assert.equal(f.rows.watches.length, 0);
  f.db.slackCorrectionNotification.upsert = original;
  await f.worker.tick();
  assert.equal(f.sends.length, 1);
});

test("case links parse strictly and filter the requested case after authentication", async () => {
  const { parseCaseLink, filterLinkedCase } = await import("../../../frontend/src/utils/caseLink.js");
  assert.deepEqual(parseCaseLink("?conversation=8&case=21"), { conversationId: 8, caseId: 21 });
  for (const query of ["?conversation=0", "?conversation=8.5", "?conversation=-8", "?conversation=9007199254740993"]) assert.equal(parseCaseLink(query), null);
  assert.deepEqual(filterLinkedCase([{ id: 1, supportCaseId: 21 }, { id: 2, supportCaseId: 22 }], 21), [{ id: 1, supportCaseId: 21 }]);
});
