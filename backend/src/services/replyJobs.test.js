const test = require("node:test");
const assert = require("node:assert/strict");
const { createReplyJobs } = require("./replyJobs");

function fixture({ age = 1000, processReply } = {}) {
  const rows = new Map();
  let time = new Date("2026-10-09T12:00:00Z");
  let replies = 0;
  const matches = (row, where) => row && (!where.revision || row.revision === where.revision)
    && (!where.state || row.state === where.state) && (!where.leaseToken || row.leaseToken === where.leaseToken)
    && (!where.dueAt || row.dueAt <= where.dueAt.lte)
    && (!where.OR || !row.leaseUntil || row.leaseUntil <= time);
  const db = {
    $queryRaw: async () => [],
    conversation: { findUnique: async () => ({ channel: "WHATSAPP" }) },
    message: { findFirst: async () => ({ timestamp: new Date(time - age) }) },
    conversationReplyJob: {
      upsert: async ({ where, create, update }) => {
        let row = rows.get(where.conversationId);
        if (!row) row = { revision: 1, state: "PENDING", attempts: 0, leaseUntil: null, ...create };
        else row = { ...row, ...update, ...(update.revision ? { revision: row.revision + 1 } : {}) };
        rows.set(where.conversationId, row); return { ...row };
      },
      updateMany: async ({ where, data }) => {
        const row = rows.get(where.conversationId);
        if (!matches(row, where)) return { count: 0 };
        rows.set(where.conversationId, { ...row, ...data, ...(data.attempts ? { attempts: row.attempts + 1 } : {}) });
        return { count: 1 };
      },
      deleteMany: async ({ where }) => {
        if (!matches(rows.get(where.conversationId), where)) return { count: 0 };
        rows.delete(where.conversationId); return { count: 1 };
      },
    },
  };
  const options = { db, now: () => time, processReply: async id => { replies++; await processReply?.(id); } };
  return { rows, jobs: createReplyJobs(options), restart: () => createReplyJobs(options),
    advance: () => { time = new Date(time.getTime() + 10000); }, replies: () => replies };
}

test("debounced replies survive restarting the processor with one stored job", async () => {
  const f = fixture();
  await f.jobs.enqueue(1);
  await f.jobs.enqueue(1);
  assert.equal(f.rows.size, 1);
  assert.equal(f.rows.get(1).revision, 2);
  f.advance();
  await f.restart().run({ ...f.rows.get(1) });
  assert.equal(f.replies(), 1);
  assert.equal(f.rows.size, 0);
});

test("new messages during an in-flight reply preserve their newer revision", async () => {
  let f;
  f = fixture({ processReply: async () => f.jobs.enqueue(1) });
  await f.jobs.enqueue(1); f.advance();
  await f.jobs.run({ ...f.rows.get(1) });
  assert.equal(f.rows.get(1).revision, 2);
  assert.equal(f.rows.get(1).leaseUntil, null);
});

test("two workers cannot claim the same conversation simultaneously", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ processReply: async () => pending });
  await f.jobs.enqueue(1); f.advance();
  const job = { ...f.rows.get(1) };
  const first = f.jobs.run(job);
  await f.restart().run(job);
  finish(); await first;
  assert.equal(f.replies(), 1);
});

test("old WhatsApp conversations expire without running the model or an action", async () => {
  const f = fixture({ age: 25 * 3600000 });
  await f.jobs.enqueue(1); f.advance(); await f.jobs.run({ ...f.rows.get(1) });
  assert.equal(f.replies(), 0);
  assert.equal(f.rows.get(1).state, "EXPIRED");
});

test("reply failure persists backoff and releases the lease for recovery", async () => {
  const f = fixture({ processReply: async () => { throw new Error("temporary outage"); } });
  await f.jobs.enqueue(1); f.advance(); await f.jobs.run({ ...f.rows.get(1) });
  assert.equal(f.rows.get(1).attempts, 1);
  assert.equal(f.rows.get(1).state, "PENDING");
  assert.equal(f.rows.get(1).leaseUntil, null);
});
