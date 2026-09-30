const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const { parseStartListWorkbook, spreadsheetKind, START_LIST_LIMITS } = require("./startListWorkbook");
const { analyzeStartList, reanalyzeStartList, normalizeBirthDate, distanceKey, makeQuestionId } = require("./startListAnalysis");
const { inferStartListPlan, validateStartListPlan, buildStartListAnalysisContext, normalizeLabel, StartListPlanJsonSchema } = require("./startListPlan");

function workbook(sheets, { date1904 = false, bookType = "xlsx", customize } = {}) {
  const book = XLSX.utils.book_new();
  book.Workbook = { WBProps: { date1904 } };
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  if (customize) customize(book);
  return XLSX.write(book, { type: "buffer", bookType, compression: true });
}

function catalog(overrides = {}) {
  return {
    competitionId: 10,
    events: [{
      id: 100, name: "10K", categoryMode: "basic", policyVersion: 1,
      categories: [{ id: 201, name: "Libre", gender: "Femenino" }, { id: 202, name: "Libre", gender: "Masculino" }],
      starts: [{ id: 301, name: "Salida general" }],
      ...overrides,
    }],
  };
}

const ordinaryHeader = ["Nombre completo", "Dorsal", "Sexo", "Distancia", "Categoría", "Documento", "Fecha de nacimiento"];
const ordinaryRow = ["Ana Pérez López", "001", "F", "10 km", "LIBRE", "00123456", "25/12/1990"];

test("one shared permit covers parsing and structural AI while existing drafts can be resolved", { timeout: 15000 }, async () => {
  const buffer = workbook({ "10K": [ordinaryHeader, ordinaryRow] });
  const input = { buffer, filename: "lista.xlsx", catalog: catalog() };
  const source = parseStartListWorkbook(input);
  let releasePlan;
  let enteredPlan;
  const gate = new Promise(resolve => { releasePlan = resolve; });
  const entered = new Promise(resolve => { enteredPlan = resolve; });
  const first = analyzeStartList({ ...input, planAnalyzer: async () => {
    enteredPlan(); await gate; return inferStartListPlan(source);
  } });
  try {
    // The permit is already held before the first worker returns. An invalid
    // second file is rejected as busy without spawning another parser.
    await assert.rejects(() => analyzeStartList({ ...input, buffer: Buffer.from("invalid") }), { code: "analysis_busy" });
    await entered;
    await assert.rejects(() => analyzeStartList(input), { code: "analysis_busy" });
    const revised = reanalyzeStartList({ sourceWorkbook: source, plan: inferStartListPlan(source), catalog: catalog() });
    assert.equal(revised.candidates.length, 1);
  } finally {
    releasePlan(); await first;
  }
  assert.equal((await analyzeStartList(input)).candidates.length, 1);
});

test("analysis errors and provider fallback release the shared permit for a later upload", async () => {
  await assert.rejects(() => analyzeStartList({ buffer: Buffer.alloc(0), filename: "invalid.xlsx", catalog: catalog() }));
  const input = { buffer: workbook({ "10K": [ordinaryHeader, ordinaryRow] }), filename: "lista.xlsx", catalog: catalog() };
  const fallback = await analyzeStartList({ ...input, planAnalyzer: async () => { throw new Error("synthetic provider failure"); } });
  assert.ok(fallback.issues.some(issue => issue.code === "ai_plan_unavailable"));
  assert.equal((await analyzeStartList(input)).candidates.length, 1);
});

test("fallback separates notes from six participants without losing a single source row", async () => {
  const rows = Array.from({ length: 6 }, (_, index) => [`Prueba ${index + 1}`, String(index + 1), index % 2 ? "F" : "M", index < 4 ? ["2.5K", "2.5k", "2.5 km", "2,5 km"][index] : ["5K / 10K", "Ruta inexistente"][index - 4], "Libre", `QA-${index + 1}`, index === 3 ? "" : "1990-01-15"]);
  const buffer = workbook({
    "Listado de prueba": [["Listado de prueba"], [], [], ordinaryHeader, ...rows],
    "Notas y totales": [["Notas de prueba"], [], ["Contenido", "Datos totalmente ficticios"], ["Total de filas en el listado", 6], ["Esta hoja", "No contiene participantes"]],
  });
  const result = await analyzeStartList({ buffer, filename: "prueba.xlsx", catalog: catalog({ name: "2.5K" }), planAnalyzer: async () => { throw new Error("provider response must stay private"); } });
  assert.equal(result.candidates.length, 6);
  assert.equal(result.summary.ready, 4);
  assert.equal(result.summary.pending, 2);
  assert.equal(result.unassignedRows.length, 5);
  assert.equal(result.excludedRows.length, 1);
  assert.equal(result.summary.sourceRows, 12);
  assert.equal(result.summary.balanced, true);
  assert.ok(result.questions.filter((question) => question.type === "column").every((question) => question.resolved && question.affectedRows === 6 && question.rowIds.length === 0));
  assert.ok(!result.questions.some((question) => question.type === "column" && question.title.includes("Notas y totales")));
  assert.ok(result.questions.filter((question) => question.type === "row").every((question) => !question.sourceValue.includes(result.file.sha256)));
  assert.equal(result.issues[0].diagnosticCode, "ai_provider_error");
  assert.ok(!JSON.stringify(result.issues).includes("provider response"));

  const decisions = Object.fromEntries(result.questions.filter((question) => question.type === "row" && question.sourceValue.startsWith("Notas y totales")).map((question) => [question.id, "row:exclude"]));
  const revised = reanalyzeStartList({ sourceWorkbook: result.sourceWorkbook, plan: result.plan, decisions, catalog: catalog({ name: "2.5K" }) });
  assert.equal(revised.candidates.length, 6);
  assert.equal(revised.unassignedRows.length, 1);
  assert.ok(!revised.questions.some((question) => !question.resolved && question.type !== "row" && question.rowIds.length === 0));
});

test("saved empty-field fallback blocks stay reviewable instead of becoming unnamed participants", async () => {
  const buffer = workbook({ Lista: [ordinaryHeader, ordinaryRow], Notas: [["Nota de organización"], ["Contenido", "Observaciones"]] });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  const oldPlan = structuredClone(result.plan);
  oldPlan.blocks.push({ sheetIndex: 1, headerRow: null, firstRow: 1, lastRow: 2, fields: [], excludeRows: [] });
  const revised = reanalyzeStartList({ sourceWorkbook: result.sourceWorkbook, plan: oldPlan, catalog: catalog() });
  assert.equal(revised.candidates.length, 1);
  assert.equal(revised.unassignedRows.length, 2);
  assert.equal(revised.summary.balanced, true);
  const decisions = Object.fromEntries(revised.questions.filter((question) => question.type === "row").map((question) => [question.id, "row:exclude"]));
  const excluded = reanalyzeStartList({ sourceWorkbook: result.sourceWorkbook, plan: oldPlan, decisions, catalog: catalog() });
  assert.ok(!excluded.questions.some((question) => question.type === "column" && question.title.includes("Notas")));
  assert.equal(excluded.summary.balanced, true);
});

test("keeping one row of an old unknown block never includes neighbouring notes", async () => {
  const buffer = workbook({ Lista: [["Ana", "F"], ["Nota de organización", "Pendiente"]] });
  const sourceWorkbook = parseStartListWorkbook({ buffer, filename: "lista.xlsx" });
  const oldPlan = { version: 1, blocks: [{ sheetIndex: 0, headerRow: null, firstRow: 1, lastRow: 2, fields: [], excludeRows: [] }] };
  const initial = reanalyzeStartList({ sourceWorkbook, plan: oldPlan, catalog: catalog() });
  const first = initial.questions.find((question) => question.type === "row" && question.sourceValue.endsWith("fila 1"));
  const decisions = { [first.id]: "row:keep" };
  assert.equal(initial.plan.blocks[0].reviewScope, "individual");
  const kept = reanalyzeStartList({ sourceWorkbook, plan: JSON.parse(JSON.stringify(initial.plan)), decisions, catalog: catalog() });
  assert.equal(kept.candidates.length, 1);
  assert.equal(kept.unassignedRows.length, 1);
  decisions[kept.questions.find((question) => question.type === "column" && question.field === "fullName").id] = "column:1";
  const mapped = reanalyzeStartList({ sourceWorkbook, plan: JSON.parse(JSON.stringify(kept.plan)), decisions, catalog: catalog() });
  assert.equal(mapped.candidates.length, 1);
  assert.equal(mapped.candidates[0].values.fullName, "Ana");
  assert.equal(mapped.unassignedRows.length, 1);
  decisions[first.id] = "row:exclude";
  const removed = reanalyzeStartList({ sourceWorkbook, plan: JSON.parse(JSON.stringify(mapped.plan)), decisions, catalog: catalog() });
  assert.equal(removed.candidates.length, 0);
  assert.equal(removed.unassignedRows.length, 1);
  assert.equal(removed.summary.balanced, true);
  assert.equal(removed.plan.blocks[0].reviewScope, "individual");
});

test("legacy manually named blocks preserve their scope and earlier exclusions across later decisions", () => {
  const buffer = workbook({ Lista: [["Ana", "F"], ["Luis", "M"], ["Nota de organización", "Pendiente"]] });
  const sourceWorkbook = parseStartListWorkbook({ buffer, filename: "lista.xlsx" });
  const plan = { version: 1, blocks: [{ sheetIndex: 0, headerRow: null, firstRow: 1, lastRow: 3, fields: [], excludeRows: [] }] };
  const scope = [sourceWorkbook.file.sha256, "0:1:3"];
  const excludedId = makeQuestionId("row", sourceWorkbook.file.sha256, normalizeLabel(sourceWorkbook.sourceRows[2].id));
  const keptId = makeQuestionId("row", sourceWorkbook.file.sha256, normalizeLabel(sourceWorkbook.sourceRows[0].id));
  for (const field of ["fullName", "firstName"]) {
    const nameId = makeQuestionId("column", [...scope, field], normalizeLabel(field));
    const genderId = makeQuestionId("column", [...scope, "gender"], normalizeLabel("gender"));
    const decisions = { [nameId]: "column:1", [genderId]: "column:2", [excludedId]: "row:exclude" };
    const initial = reanalyzeStartList({ sourceWorkbook, plan, decisions, catalog: catalog() });
    assert.equal(initial.plan.blocks[0].reviewScope, "legacy_mapped");
    assert.equal(initial.candidates.length, 2);
    assert.equal(initial.unassignedRows.length, 0);
    assert.deepEqual(initial.candidates.map((row) => row.values[field]), ["Ana", "Luis"]);
    assert.ok(initial.candidates.every((row) => row.status === "ready"));
    const revised = reanalyzeStartList({ sourceWorkbook, plan: JSON.parse(JSON.stringify(initial.plan)), decisions: { ...decisions, [keptId]: "row:keep" }, catalog: catalog() });
    assert.equal(revised.candidates.length, 2, "conserving one row must not drop the rest of an already mapped legacy list");
    assert.equal(revised.excludedRows.length, 1);
    assert.equal(revised.summary.balanced, true);
    const cleared = reanalyzeStartList({ sourceWorkbook, plan: JSON.parse(JSON.stringify(revised.plan)), decisions: { ...decisions, [nameId]: "unmapped" }, catalog: catalog() });
    assert.equal(cleared.plan.blocks[0].reviewScope, "legacy_mapped");
    assert.equal(cleared.candidates.length, 2, "an explicit mapping correction keeps the original reviewed scope");
    assert.equal(cleared.excludedRows.length, 1);
  }
});

test("only valid legacy name mappings activate the old table scope and its marker round-trips locally", () => {
  const buffer = workbook({ Lista: [["Ana", "F"], ["Nota", "Pendiente"]] });
  const sourceWorkbook = parseStartListWorkbook({ buffer, filename: "lista.xlsx" });
  const plan = { version: 1, blocks: [{ sheetIndex: 0, headerRow: null, firstRow: 1, lastRow: 2, fields: [], excludeRows: [] }] };
  for (const [field, option] of [["fullName", "column:3"], ["firstName", "column:0"], ["gender", "column:2"], ["lastName", "column:1"]]) {
    const questionId = makeQuestionId("column", [sourceWorkbook.file.sha256, "0:1:2", field], normalizeLabel(field));
    const result = reanalyzeStartList({ sourceWorkbook, plan, decisions: { [questionId]: option }, catalog: catalog() });
    assert.equal(result.plan.blocks[0].reviewScope, "individual");
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(validateStartListPlan(JSON.parse(JSON.stringify(result.plan)), sourceWorkbook), result.plan);
  }
  const invalid = structuredClone(plan);
  invalid.blocks[0].reviewScope = "all_rows";
  assert.throws(() => validateStartListPlan(invalid, sourceWorkbook), { code: "invalid_plan" });
  assert.equal(StartListPlanJsonSchema.properties.blocks.items.properties.reviewScope, undefined, "the provider never chooses persisted compatibility state");
});

test("unrecognized headerless participant rows require review and can be mapped explicitly", async () => {
  const buffer = workbook({ Lista: [["Ana Pérez", "F", "10K", "Libre"]] });
  const initial = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  assert.equal(initial.candidates.length, 0);
  assert.equal(initial.unassignedRows.length, 1);
  const review = initial.questions.find((question) => question.type === "row");
  const decisions = { [review.id]: "row:keep" };
  const kept = reanalyzeStartList({ sourceWorkbook: initial.sourceWorkbook, plan: initial.plan, decisions, catalog: catalog() });
  const columns = { fullName: 1, gender: 2, distance: 3, category: 4 };
  for (const [field, column] of Object.entries(columns)) decisions[kept.questions.find((question) => question.type === "column" && question.field === field).id] = `column:${column}`;
  const mapped = reanalyzeStartList({ sourceWorkbook: initial.sourceWorkbook, plan: kept.plan, decisions, catalog: catalog() });
  assert.equal(mapped.candidates[0].values.fullName, "Ana Pérez");
  assert.equal(mapped.candidates[0].status, "ready");
  assert.equal(mapped.summary.balanced, true);
  assert.equal(mapped.candidates[0].id, initial.unassignedRows[0].id);
});

test("excluding all participants in a block removes its column and assignment questions", async () => {
  const buffer = workbook({ Lista: [["Nombre", "Nombre", "Dorsal", "Sexo"], ["Ana", "Pérez", "1", "F"]] });
  const initial = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  assert.equal(initial.questions.find((question) => question.type === "column" && !question.resolved).rowIds.length, 1);
  const question = initial.questions.find((question) => question.type === "row");
  const excluded = reanalyzeStartList({ sourceWorkbook: initial.sourceWorkbook, plan: initial.plan, decisions: { [question.id]: "row:exclude" }, catalog: catalog() });
  assert.equal(excluded.candidates.length, 0);
  assert.ok(excluded.questions.every((question) => question.type === "row" && question.resolved));
  assert.equal(excluded.summary.balanced, true);
});

test("degraded analysis records only safe diagnostic codes for structural and timeout failures", async () => {
  const input = { buffer: workbook({ Lista: [ordinaryHeader, ordinaryRow] }), filename: "lista.xlsx", catalog: catalog() };
  const invalid = await analyzeStartList({ ...input, planAnalyzer: async () => ({ version: 1, blocks: [{ private: "source data" }] }) });
  assert.equal(invalid.issues[0].diagnosticCode, "invalid_plan");
  const timeout = await analyzeStartList({ ...input, planAnalyzer: async () => { const error = new Error("private provider token"); error.name = "APIConnectionTimeoutError"; throw error; } });
  assert.equal(timeout.issues[0].diagnosticCode, "ai_timeout");
  assert.ok(!JSON.stringify(timeout.issues).includes("private provider token"));
});

test("reads every sheet and keeps physical row/cell identities without losing duplicate headers", async () => {
  const buffer = workbook({
    "10K": [["Listado de participantes"], [], ordinaryHeader, ordinaryRow, [], ["Total", 1]],
    "Otros": [["Nombre", "Dorsal", "Sexo", "Documento", "Documento"], ["Luis", "2", "M", "00123", "987"]],
  });
  const parsed = parseStartListWorkbook({ buffer, filename: "lista.xlsx" });
  assert.equal(parsed.workbook.sheets.length, 2);
  const row = parsed.sourceRows.find((row) => row.sheetIndex === 1 && row.row === 2);
  assert.equal(row.cells.find((cell) => cell.address === "D2").text, "00123");
  assert.equal(row.cells.find((cell) => cell.address === "E2").text, "987");
  assert.match(row.id, /^[a-f0-9]{64}:s2:r2$/);
  const analysis = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  assert.equal(analysis.candidates.length, 2);
  assert.equal(analysis.candidates[0].source.row, 4);
  assert.equal(analysis.candidates[0].evidence.document.cell, "F4");
  assert.equal(analysis.candidates[0].values.document, "00123456");
  assert.equal(analysis.candidates[0].values.birthDate, "1990-12-25");
  assert.equal(analysis.candidates[1].values.document, undefined);
  assert.equal(analysis.summary.balanced, true);
  assert.equal(analysis.unassignedRows.length, 1);
  assert.ok(analysis.excludedRows.some((row) => row.reason === "total"));
});

test("CSV parsing preserves leading zeros and a complete name literally", async () => {
  const buffer = Buffer.from("Apellidos y nombres;Dorsal;Sexo;Prueba;División;DNI\r\nPérez López Ana;0002;F;10K;Libre;00123456\r\n", "utf8");
  const result = await analyzeStartList({ buffer, filename: "lista.csv", catalog: catalog() });
  assert.equal(result.candidates[0].values.fullName, "Pérez López Ana");
  assert.equal(result.candidates[0].values.dorsal, "0002");
  assert.equal(result.candidates[0].values.document, "00123456");
  assert.equal(result.candidates[0].categoryId, 201);
});

test("legacy XLS is supported without requiring conversion by the user", async () => {
  const buffer = workbook({ "10K": [ordinaryHeader, ordinaryRow] }, { bookType: "xls" });
  const result = await analyzeStartList({ buffer, filename: "lista.xls", catalog: catalog() });
  assert.equal(result.candidates[0].values.document, "00123456");
});

test("date parsing is strict and honors both Excel date systems without inventing a birthday", () => {
  assert.equal(normalizeBirthDate("29/02/2024"), "2024-02-29");
  assert.equal(normalizeBirthDate("29/02/2023"), null);
  assert.equal(normalizeBirthDate("12/11/90"), null);
  assert.equal(normalizeBirthDate("35 años"), null);
  assert.equal(normalizeBirthDate("2090-01-01"), null);
  assert.equal(normalizeBirthDate(60), null, "Excel's fictional 1900 leap day must not become a real birth date");
  assert.equal(normalizeBirthDate(1, { date1904: true }), "1904-01-02");
  assert.equal(normalizeBirthDate(1, { date1904: false }), "1900-01-01");
});

test("workbook-formatted dates and identifier display formats retain source evidence", async () => {
  const buffer = workbook({ "10K": [ordinaryHeader, ["Ana", 1, "F", "10K", "Libre", 12345, 35000]] }, { date1904: true, customize(book) {
    book.Sheets["10K"].F2.z = "00000000";
    book.Sheets["10K"].G2.z = "dd/mm/yyyy";
  } });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  assert.equal(result.candidates[0].values.document, "00012345");
  assert.equal(result.candidates[0].values.birthDate, normalizeBirthDate(35000, { date1904: true }));
  assert.ok(result.candidates[0].evidence.birthDate.original.includes("/"));
});

test("normalization uses existing IDs and never automatically chooses an approximate distance", async () => {
  const data = catalog();
  data.events.push({ ...data.events[0], id: 101, name: "10K Ruta", starts: [{ id: 302, name: "Salida ruta" }] });
  const buffer = workbook({ Lista: [ordinaryHeader, ordinaryRow, ["Luis", "2", "M", "10K Trail", "Libre", "02", "2000-01-01"]] });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: data });
  assert.equal(result.candidates[0].eventId, 100);
  assert.equal(result.candidates[0].categoryId, 201);
  assert.equal(result.candidates[0].startId, 301);
  assert.equal(result.candidates[1].eventId, null);
  const question = result.questions.find((item) => item.type === "distance" && !item.resolved);
  assert.equal(question.options[0].id, "event:100");
  const resumed = reanalyzeStartList({ sourceWorkbook: JSON.parse(JSON.stringify(result.sourceWorkbook)), plan: result.plan, catalog: data, decisions: { [question.id]: "event:101" } });
  assert.equal(resumed.candidates[1].eventId, 101);
  assert.equal(resumed.candidates[1].startId, 302);
  assert.equal(resumed.candidates[1].evidence.distance.original, "10K Trail");
  assert.equal(distanceKey("10.5 km"), distanceKey("10500m"));
});

test("unknown gender/category/start decisions are grouped and restricted to current event options", async () => {
  const data = catalog({ starts: [{ id: 301, name: "Primera" }, { id: 302, name: "Segunda" }] });
  const buffer = workbook({ Lista: [[...ordinaryHeader, "Tanda"], ["Ana", "1", "D", "10K", "OPEN", "01", "1990-12-25", "A"], ["Elena", "2", "D", "10K", "OPEN", "02", "1991-12-25", "A"]] });
  const initial = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: data });
  const gender = initial.questions.find((question) => question.type === "gender");
  assert.equal(gender.rowIds.length, 2);
  const withGender = reanalyzeStartList({ sourceWorkbook: initial.sourceWorkbook, catalog: data, plan: initial.plan, decisions: { [gender.id]: "gender:F" } });
  const category = withGender.questions.find((question) => question.type === "category");
  const start = withGender.questions.find((question) => question.type === "start");
  assert.deepEqual(category.options.map((option) => option.id), ["category:201"]);
  const decisions = { [gender.id]: "gender:F", [category.id]: "category:201", [start.id]: "start:302" };
  const resolved = reanalyzeStartList({ sourceWorkbook: initial.sourceWorkbook, catalog: data, plan: initial.plan, decisions });
  assert.equal(resolved.summary.ready, 2);
  assert.ok(resolved.candidates.every((row) => row.categoryId === 201 && row.startId === 302));
  const rejected = reanalyzeStartList({ sourceWorkbook: initial.sourceWorkbook, catalog: data, plan: initial.plan, decisions: { ...decisions, [category.id]: "category:202" } });
  assert.ok(rejected.issues.some((issue) => issue.code === "invalid_decision"));
  assert.equal(rejected.candidates[0].categoryId, null);
});

test("detailed categories preserve supplied labels, require DOB and wait for authoritative classification", async () => {
  const data = catalog({ categoryMode: "detailed", policyVersion: 7 });
  const buffer = workbook({ Lista: [ordinaryHeader, ordinaryRow, ["Luis", "2", "M", "10K", "Libre", "02", ""]] });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: data });
  assert.equal(result.candidates[0].categoryId, null);
  assert.equal(result.candidates[0].policyVersion, 7);
  assert.equal(result.candidates[0].suppliedCategoryName, "Libre");
  assert.equal(result.candidates[0].status, "needs_classification");
  assert.equal(result.candidates[1].status, "pending");
  assert.ok(result.candidates[1].issues.some((issue) => issue.code === "missing_birth_date"));
});

test("basic mode does not require birth dates and empty distance catalogs stay pending", async () => {
  const buffer = workbook({ Lista: [ordinaryHeader, ["Ana", "1", "F", "10K", "Libre", "01", ""]] });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  assert.equal(result.candidates[0].status, "ready");
  const withoutEvents = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: { competitionId: 10, events: [] } });
  assert.equal(withoutEvents.candidates[0].status, "pending");
  assert.ok(withoutEvents.candidates[0].issues.some((issue) => issue.code === "no_configured_distances"));
});

test("both channel and UI policy transition fields block import readiness", async () => {
  const buffer = workbook({ Lista: [ordinaryHeader, ordinaryRow] });
  for (const policy of [{ closed: true }, { pendingOperation: true }, { pendingOperationId: "operation-fixture" }]) {
    const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog(policy) });
    assert.equal(result.candidates[0].status, "pending");
    assert.ok(result.candidates[0].issues.some(issue => issue.code === "category_policy_unavailable"));
  }
});

test("missing/ambiguous column mappings can be answered after a process restart", async () => {
  const buffer = workbook({ Lista: [["Nombre", "Nombre", "Dorsal", "Sexo"], ["Ana", "Pérez", "1", "F"]] });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  const first = result.questions.find((question) => question.type === "column" && question.field === "firstName");
  const last = result.questions.find((question) => question.type === "column" && question.field === "lastName");
  const resumed = reanalyzeStartList({ workbook: JSON.parse(JSON.stringify(result.sourceWorkbook)), catalog: catalog(), plan: result.plan, decisions: { [first.id]: { optionId: "column:1" }, [last.id]: "column:2" } });
  assert.equal(resumed.candidates[0].values.firstName, "Ana");
  assert.equal(resumed.candidates[0].values.lastName, "Pérez");
  assert.equal(resumed.candidates[0].id, result.candidates[0].id);
  assert.equal(resumed.candidates[0].status, "ready");
});

test("AI sees relevant unknown headers, titles and samples across blocks, not personal values", () => {
  const buffer = workbook({ Lista: [
    ["Carrera del Valle · Circuito largo"],
    ["Identidad del corredor", "Número competitivo", "Prueba", "División", "Tanda", "Correo", "Nacimiento"],
    ["Ana Pérez", "000123456", "10K", "Elite", "A", "ana.private@example.org", "1990-12-25"],
    [], ["Segunda tabla de la jornada"],
    ["Identidad del corredor", "Número competitivo", "Prueba", "División", "Tanda", "Correo", "Nacimiento"],
    ["Luis Díaz", "000123457", "21K", "Libre", "B", "luis.private@example.org", "1980-01-01"],
  ] });
  const parsed = parseStartListWorkbook({ buffer, filename: "lista.xlsx" });
  const context = buildStartListAnalysisContext(parsed, catalog());
  const serialized = JSON.stringify(context);
  assert.ok(serialized.includes("Identidad del corredor"));
  assert.ok(serialized.includes("Número competitivo"));
  assert.ok(serialized.includes("Carrera del Valle"));
  assert.ok(serialized.includes("21K"));
  assert.ok(serialized.includes("Elite"));
  assert.ok(!serialized.includes("ana.private@example.org"));
  assert.ok(!serialized.includes("1990-12-25"));
  assert.ok(!serialized.includes("000123456"));
  assert.ok(!serialized.includes("Ana Pérez"));
});

test("AI context preserves structural note labels below a probable header without exposing unrelated text", () => {
  const buffer = workbook({ Notas: [["Notas de prueba"], [], ["Contenido", "Datos totalmente ficticios"], ["Total de filas en el listado", 6], ["Esta hoja", "No contiene participantes"], ["Contacto", "ana.private@example.org"]] });
  const parsed = parseStartListWorkbook({ buffer, filename: "lista.xlsx" });
  const serialized = JSON.stringify(buildStartListAnalysisContext(parsed, catalog()));
  assert.ok(serialized.includes("Total de filas en el listado"));
  assert.ok(serialized.includes("No contiene participantes"));
  assert.ok(!serialized.includes("ana.private@example.org"));
});

test("the full data range is applied deterministically beyond the AI sample", async () => {
  const rows = Array.from({ length: 240 }, (_, index) => [`Persona ${index}`, String(index + 1), "F", "10K", "Libre", String(index + 1000000), "1990-01-01"]);
  const buffer = workbook({ Lista: [ordinaryHeader, ...rows] });
  let sampleRows = 0;
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog(), planAnalyzer: async (context) => {
    sampleRows = context.workbook.sheets[0].samples.length;
    return context.fallbackPlan;
  } });
  assert.ok(sampleRows < 240);
  assert.equal(result.candidates.length, 240);
  assert.equal(result.candidates.at(-1).values.fullName, "Persona 239");
  assert.equal(result.summary.ready, 240);
});

test("AI cannot invent constants, change identities, overlap blocks, or silently discard participants", async () => {
  const buffer = workbook({ Lista: [ordinaryHeader, ordinaryRow] });
  const parsed = parseStartListWorkbook({ buffer, filename: "lista.xlsx" });
  const base = inferStartListPlan(parsed);
  const invented = structuredClone(base);
  invented.blocks[0].fields[0].value = "Persona inventada";
  assert.throws(() => validateStartListPlan(invented, parsed), { code: "invalid_plan" });
  const overlap = structuredClone(base);
  overlap.blocks.push(overlap.blocks[0]);
  assert.throws(() => validateStartListPlan(overlap, parsed), { code: "overlapping_plan_blocks" });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog(), planAnalyzer: async () => {
    const plan = structuredClone(base);
    plan.blocks[0].excludeRows.push({ row: 2, reason: "note" });
    return plan;
  } });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].values.fullName, "Ana Pérez López");
  assert.ok(result.candidates[0].issues.some((issue) => issue.code === "unverified_exclusion"));
  assert.equal(result.summary.balanced, true);
  const fallback = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog(), planAnalyzer: async () => invented });
  assert.ok(fallback.issues.some((issue) => issue.code === "ai_plan_unavailable"));
});

test("duplicate rows remain explicit conflicts rather than overwriting or dropping a person", async () => {
  const buffer = workbook({ Lista: [ordinaryHeader, ordinaryRow, [...ordinaryRow]] });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((row) => row.issues.some((issue) => issue.code === "duplicate_in_file")));
  assert.equal(result.summary.ready, 0);
});

test("stored source references are revalidated before answering a question", async () => {
  const buffer = workbook({ Lista: [ordinaryHeader, ordinaryRow] });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  const changed = structuredClone(result.sourceWorkbook);
  changed.sourceRows[1].id = "other-file-row";
  assert.throws(() => reanalyzeStartList({ workbook: changed, catalog: catalog(), plan: result.plan }), { code: "invalid_source_row" });
});

test("unassigned source rows can only disappear after an explicit row exclusion", async () => {
  const buffer = workbook({ Lista: [["Listado Carrera del Valle"], [], ordinaryHeader, ordinaryRow] });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  assert.equal(result.unassignedRows.length, 1);
  const question = result.questions.find((question) => question.type === "row" && question.rowIds.includes(result.unassignedRows[0].id));
  const reviewed = reanalyzeStartList({ sourceWorkbook: result.sourceWorkbook, catalog: catalog(), plan: result.plan, decisions: { [question.id]: "row:exclude" } });
  assert.equal(reviewed.unassignedRows.length, 0);
  assert.ok(reviewed.excludedRows.some((row) => row.reason === "user_excluded"));
  assert.equal(reviewed.summary.balanced, true);
  assert.equal(reviewed.candidates.length, 1);
});

test("an explicitly retained unmapped row requires real column choices, not invented values", async () => {
  const buffer = workbook({ Lista: [["Atleta sin cabecera", "8", "F"], [], ordinaryHeader, ordinaryRow] });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  const rowQuestion = result.questions.find((question) => question.type === "row" && question.rowIds.includes(result.unassignedRows[0].id));
  const decisions = { [rowQuestion.id]: "row:keep" };
  const kept = reanalyzeStartList({ sourceWorkbook: result.sourceWorkbook, catalog: catalog(), plan: result.plan, decisions });
  const candidate = kept.candidates.find((row) => row.source.row === 1);
  assert.ok(candidate);
  assert.equal(candidate.status, "pending");
  assert.equal(candidate.values.fullName, undefined);
  assert.equal(kept.summary.balanced, true);
});

test("family emails warn while identity documents and race numbers block duplicates", async () => {
  const header = ["Nombre", "Dorsal", "Sexo", "Correo", "Documento"];
  const buffer = workbook({ Lista: [header, ["Ana", "1", "F", "familia@example.org", "111"], ["Elena", "2", "F", "familia@example.org", "222"]] });
  const result = await analyzeStartList({ buffer, filename: "lista.xlsx", catalog: catalog() });
  assert.equal(result.summary.ready, 2);
  assert.ok(result.candidates.every((row) => row.issues.some((issue) => issue.field === "email" && issue.severity === "warning")));
});

test("limits reject malformed files, out-of-bounds sheets and falsified ZIP expansion sizes", () => {
  assert.equal(spreadsheetKind("lista.xlsx"), "xlsx");
  assert.equal(spreadsheetKind("lista.exe", "text/csv"), null);
  assert.throws(() => parseStartListWorkbook({ buffer: Buffer.alloc(0), filename: "lista.csv" }), { code: "empty_file" });
  assert.throws(() => parseStartListWorkbook({ buffer: Buffer.alloc(START_LIST_LIMITS.maxFileBytes + 1), filename: "lista.csv" }), { code: "file_too_large" });
  const tooLarge = workbook({ Lista: [["Nombre", "Dorsal"]] }, { customize(book) {
    book.Sheets.Lista["A10001"] = { t: "s", v: "Fuera del límite" };
    book.Sheets.Lista["!ref"] = "A1:B10001";
  } });
  assert.throws(() => parseStartListWorkbook({ buffer: tooLarge, filename: "lista.xlsx" }), { code: "sheet_too_large" });
  const forged = workbook({ Lista: [ordinaryHeader, ordinaryRow] });
  const directory = forged.indexOf(Buffer.from("504b0102", "hex"));
  assert.ok(directory > 0);
  forged.writeUInt32LE(0, directory + 24);
  assert.throws(() => parseStartListWorkbook({ buffer: forged, filename: "lista.xlsx" }), { code: "invalid_xlsx" });
});
