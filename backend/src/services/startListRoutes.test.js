const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const calls = [];
let analysisGate = null;
const authoritative = [{ id: "distance:trusted", options: [{ id: "event:1", label: "10K" }] }];
require.cache[require.resolve("../config")] = { exports: { security: { exotimerApiKey: "synthetic-service-key" } } };
require.cache[require.resolve("./startListAnalysis")] = { exports: {
  analyzeStartList: async input => { calls.push({ kind: "analyze", input }); if (analysisGate) await analysisGate; return { candidates: [], questions: authoritative }; },
  reanalyzeStartList: input => { calls.push({ kind: "rebuild", input }); return { questions: authoritative, candidates: [] }; },
} };
require.cache[require.resolve("./startListAi")] = { exports: {
  analyzeStartListPlan: () => { throw new Error("A real model must never be reached"); },
  resolveConversationAnswers: async input => { calls.push({ kind: "resolve", input }); return { answers: [{ questionId: "distance:trusted", optionId: "event:1" }, { questionId: "forged", optionId: "event:999" }], clarification: "Usaré 10K." }; },
} };
const router = require("../routes/startListImports");
const catalog = { competitionId: 1, events: [{ id: 1, name: "10K", categoryMode: "basic", categories: [], starts: [] }] };
const headers = { "Content-Type": "application/json", "X-Support-Api-Key": "synthetic-service-key", "X-Startlist-Operator": "a".repeat(64) };
const upload = { file: { name: "synthetic.csv", data: Buffer.from("Nombre\nPrueba").toString("base64"), mimeType: "text/csv" }, catalog };

async function serve(run) {
  const app = express(); app.use("/imports", router);
  const server = await new Promise(resolve => { const item = app.listen(0, "127.0.0.1", () => resolve(item)); });
  try { await run(`http://127.0.0.1:${server.address().port}/imports`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("the analysis service denies disabled and unauthorized requests before parsing or AI", async () => {
  calls.length = 0;
  await serve(async url => {
    process.env.START_LIST_IMPORTS_ENABLED = "false";
    assert.equal((await fetch(`${url}/analyze`, { method: "POST", headers, body: "invalid json" })).status, 503);
    process.env.START_LIST_IMPORTS_ENABLED = "true";
    assert.equal((await fetch(`${url}/analyze`, { method: "POST", headers: { ...headers, "X-Support-Api-Key": "wrong" }, body: "invalid json" })).status, 403);
    assert.equal((await fetch(`${url}/analyze`, { method: "POST", headers: { ...headers, "X-Startlist-Operator": "" }, body: JSON.stringify(upload) })).status, 400);
    assert.equal(calls.length, 0);
  });
});

test("a trusted existing-competition upload reaches only the structural analysis contract", async () => {
  calls.length = 0;
  await serve(async url => {
    const response = await fetch(`${url}/analyze`, { method: "POST", headers, body: JSON.stringify(upload) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.buffer.toString(), "Nombre\nPrueba");
    assert.equal(calls[0].input.catalog.competitionId, 1);
  });
});

test("conversation ignores supplied questions and accepts only regenerated option IDs", async () => {
  calls.length = 0;
  await serve(async url => {
    const response = await fetch(`${url}/resolve`, { method: "POST", headers, body: JSON.stringify({ catalog, sourceWorkbook: { synthetic: true }, plan: {}, decisions: {}, questions: [{ id: "forged", options: [{ id: "event:999" }] }], message: "Larga pertenece a 10K" }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(calls.find(call => call.kind === "resolve").input.questions, authoritative);
    assert.deepEqual(result.decisions, { "distance:trusted": "event:1" });
    assert.equal(result.assistantMessage, "Usaré 10K.");
  });
});

test("a second analysis for the same operator cannot run concurrently", async () => {
  let release;
  analysisGate = new Promise(resolve => { release = resolve; });
  calls.length = 0;
  try {
    await serve(async url => {
      const first = fetch(`${url}/analyze`, { method: "POST", headers, body: JSON.stringify(upload) });
      for (let attempt = 0; !calls.length && attempt < 500; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.ok(calls.length, "The first local request must reach the mocked analyzer");
      const second = await fetch(`${url}/analyze`, { method: "POST", headers, body: JSON.stringify(upload) });
      assert.equal(second.status, 429);
      assert.equal(calls.length, 1);
      release(); assert.equal((await first).status, 200);
    });
  } finally { release(); analysisGate = null; }
});
