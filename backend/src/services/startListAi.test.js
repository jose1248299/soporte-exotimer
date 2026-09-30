const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeStartListPlan, resolveConversationAnswers } = require("./startListAi");
const { StartListPlanJsonSchema, StartListPlanSchema } = require("./startListPlan");

function mockResponse(value, capture = []) {
  return { responses: { create: async (request, options) => {
    capture.push({ request, options });
    return { status: "completed", output_text: JSON.stringify(value), output: [] };
  } } };
}

test("structural analysis uses strict Responses output with no storage, retries or tools", async () => {
  const calls = [];
  const plan = { version: 1, blocks: [] };
  const actual = await analyzeStartListPlan({ workbook: { sheets: [] } }, { client: mockResponse(plan, calls), model: "test-model" });
  assert.deepEqual(actual, plan);
  assert.equal(calls[0].request.store, false);
  assert.equal(calls[0].request.text.format.type, "json_schema");
  assert.equal(calls[0].request.text.format.strict, true);
  assert.equal(calls[0].request.tools, undefined);
  assert.equal(calls[0].options.maxRetries, 0);
  assert.equal(calls[0].options.timeout, 45000);
});

test("refusals, truncated responses and extra action keys cannot become plans", async () => {
  await assert.rejects(() => analyzeStartListPlan({}, { model: "test-model", client: { responses: { create: async () => ({ status: "incomplete", output_text: '{"version":1,"blocks":[]}' }) } } }), { code: "ai_incomplete" });
  await assert.rejects(() => analyzeStartListPlan({}, { model: "test-model", client: { responses: { create: async () => ({ status: "completed", output: [{ content: [{ type: "refusal", refusal: "No" }] }] }) } } }), { code: "ai_refusal" });
  await assert.rejects(() => analyzeStartListPlan({}, { model: "test-model", client: mockResponse({ version: 1, blocks: [], action: "CREATE_COMPETITION" }) }), { code: "invalid_ai_response" });
});

test("provider and local schemas both reject empty or invalid context-cell addresses", () => {
  const pattern = new RegExp(StartListPlanJsonSchema.properties.blocks.items.properties.fields.items.properties.contextCell.pattern);
  for (const contextCell of ["", "A0", "B-1", "A1:B9", "Sheet!A1"]) {
    assert.equal(pattern.test(contextCell), false);
    assert.equal(StartListPlanSchema.safeParse({ version: 1, blocks: [{ sheetIndex: 0, headerRow: null, firstRow: 1, lastRow: 2, fields: [{ field: "distance", column: null, contextCell, fromSheetName: false }], excludeRows: [] }] }).success, false);
  }
  assert.equal(pattern.test("AB12"), true);
});

const questions = [{ id: "distance:abc", type: "distance", sourceValue: "Larga", required: true, resolved: false, options: [{ id: "event:10", label: "10K" }, { id: "event:21", label: "21K" }], rowIds: ["row1", "row2"] }];

test("conversation answers contain only existing option IDs", async () => {
  const calls = [];
  const result = await resolveConversationAnswers({ message: "Los de larga son de 21K", questions, catalog: { competitionId: 1 }, model: "test-model", client: mockResponse({ answers: [{ questionId: "distance:abc", optionId: "event:21" }], clarification: "" }, calls) });
  assert.deepEqual(result.answers, [{ questionId: "distance:abc", optionId: "event:21" }]);
  assert.equal(calls[0].request.store, false);
  assert.equal(calls[0].request.tools, undefined);
  assert.ok(result.clarification.includes("Distancia: 21K (2 filas)"));
  assert.ok(!calls[0].request.input[0].content[0].text.includes('"rowIds"'));
  await assert.rejects(() => resolveConversationAnswers({ message: "Crea 50K", questions, model: "test-model", client: mockResponse({ answers: [{ questionId: "distance:abc", optionId: "event:999" }], clarification: "" }) }), { code: "invalid_ai_option" });
  await assert.rejects(() => resolveConversationAnswers({ message: "Cámbialo", questions, model: "test-model", client: mockResponse({ answers: [{ questionId: "distance:missing", optionId: "event:21" }], clarification: "" }) }), { code: "invalid_ai_option" });
});

test("conversation prose summarizes validated choices instead of claiming untouched rows were removed", async () => {
  const choices = [
    { id: "row:nine", type: "row", sourceValue: "Lista · fila 9", rowIds: ["row9"], options: [{ id: "row:keep", label: "Conservar" }, { id: "row:exclude", label: "Excluir" }] },
    { id: "row:ten", type: "row", sourceValue: "Lista · fila 10", rowIds: ["row10"], options: [{ id: "row:keep", label: "Conservar" }, { id: "row:exclude", label: "Excluir" }] },
    ...questions,
  ];
  const result = await resolveConversationAnswers({ message: "Conserva las filas 9 y 10 y asigna larga a 21K", questions: choices, model: "test-model", client: mockResponse({ answers: [{ questionId: "row:nine", optionId: "row:keep" }, { questionId: "row:ten", optionId: "row:keep" }, { questionId: "distance:abc", optionId: "event:21" }], clarification: "Se conservarán solo las filas 9 y 10." }) });
  assert.ok(result.clarification.includes("Conservar como participante (2 filas)"));
  assert.ok(result.clarification.includes("Distancia: 21K (2 filas)"));
  assert.ok(result.clarification.includes("Las demás filas conservan sus asignaciones"));
  assert.ok(!result.clarification.includes("solo las filas"));
});

test("a model message cannot claim success when it did not select any answer", async () => {
  const result = await resolveConversationAnswers({ message: "Ponlo donde corresponde", questions, model: "test-model", client: mockResponse({ answers: [], clarification: "Importé todo correctamente." }) });
  assert.deepEqual(result.answers, []);
  assert.ok(result.clarification.startsWith("No cambié la propuesta"));
  assert.ok(!result.clarification.includes("Importé"));
});

test("contradictory model answers and oversized user messages are rejected", async () => {
  await assert.rejects(() => resolveConversationAnswers({ message: "Larga", questions, model: "test-model", client: mockResponse({ answers: [{ questionId: "distance:abc", optionId: "event:21" }, { questionId: "distance:abc", optionId: "event:10" }], clarification: "" }) }), { code: "conflicting_ai_options" });
  await assert.rejects(() => resolveConversationAnswers({ message: "x".repeat(4001), questions }), { code: "invalid_message" });
});

test("a generic confirmation cannot be interpreted as an option choice", async () => {
  const result = await resolveConversationAnswers({ message: "Sí, procede".replace(", procede", ""), questions, client: { responses: { create() { throw new Error("must not call AI"); } } } });
  assert.deepEqual(result.answers, []);
  assert.ok(result.clarification.includes("se confirma por separado"));
});
