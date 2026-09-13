const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalizeResultInput, applyAthleteReviewPolicy, requestedChangeAlreadySatisfied } = require("./athleteReview");
const { inspectAthleteResultPreflight, mergeActionInput } = require("./supportProcessor");

const actions = [{ id: 471, status: "EXECUTED", name: "EXOTIMER_UPDATE_RESULT_DORSAL", output: {
  changed: { competitionId: 615, resultId: 177810, before: { dorsal: 465 }, after: { dorsal: 466, chip: "466" } },
} }, { id: 472, status: "FAILED", name: "EXOTIMER_UPDATE_RESULT_DORSAL", error: "No existe 465" }];

test("el siguiente cambio usa dorsal nuevo y resultId aunque un reintento posterior haya fallado", () => {
  const input = canonicalizeResultInput({ competitionId: 615, dorsal: "466", currentDorsal: "465", oldDorsal: "465", newDorsal: "466", requestedValue: "01:07:00" }, actions, "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION");
  assert.equal(input.resultId, 177810);
  assert.equal(input.currentDorsal, "466");
  assert.equal(input.oldDorsal, undefined);
  assert.equal(input.newDorsal, undefined);
  assert.equal(input.requestedValue, "01:07:00");
});

test("no traslada un resultId entre competencias ni atletas del equipo", () => {
  for (const input of [{ competitionId: 616, dorsal: "465" }, { competitionId: 615, dorsal: "467" }]) {
    assert.deepEqual(canonicalizeResultInput(input, actions), input);
  }
});

test("un nuevo evento o dorsal no hereda resultId, dorsal anterior ni evidencia de otro atleta", () => {
  const previous = { competitionId: 615, dorsal: "465", currentDorsal: "465", resultId: 177810, gpsElapsedTime: "01:07:00" };
  for (const next of [{ competitionId: 616, dorsal: "465" }, { competitionId: 615, dorsal: "467" }]) {
    assert.deepEqual(mergeActionInput(previous, next), next);
  }
});

test("un tiempo publicado no cierra un reclamo de tiempo incorrecto", async () => {
  const detail = { id: 178616, dorsal: 119, official_time_ms: 6299000, event_name: "10K" };
  const result = await inspectAthleteResultPreflight({ userType: "ATHLETE", text: "Sigo esperando que corrijan mi tiempo incorrecto",
    classification: { userType: "ATHLETE", action: "EXOTIMER_CREATE_RESULT_CORRECTION_CASE", actionInput: { competitionId: 626, dorsal: "119", requestedValue: "01:41:00" } },
    execute: async (_role, name) => name === "EXOTIMER_GET_RESULTS" ? [detail] : detail });
  assert.equal(result.resolution, null);
  assert.equal(result.classification.needsHuman, false);
});

const reviewContext = { competitionId: 615, result: { resultId: 178262, dorsal: 921, athleteName: "Victoria", athleteLastname: "Ale Garcia", distance: "10K", officialTime: null },
  timing: { assignments: [{ id: 65046, point_control: "loc_Salida", hour: "2026-09-13T07:04:31" }] } };
const watchClaim = { userType: "ATHLETE", action: null, remainingRequests: ["Esperar evidencia de tiempo", "Corregir nombre"],
  actionInput: { competitionId: 615, dorsal: "921", athleteName: "Victoria Ale Garcia", currentDistance: "10K", requestedValue: "01:06:00", requestedCorrection: "Agregar tiempo" } };

test("acepta reloj declarado con identidad y salida verificadas, conservando otros pendientes", () => {
  const output = applyAthleteReviewPolicy(watchClaim, reviewContext, [{ direction: "INBOUND", content: "Mi reloj marco 1:06" }], []);
  assert.equal(output.action, "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION");
  assert.equal(output.actionInput.trustAthleteEvidence, true);
  assert.deepEqual(output.remainingRequests, ["Corregir nombre"]);
});

test("no promueve un tiempo ambiguo ni una identidad incompatible ni evidencia de una respuesta del bot", () => {
  for (const [classification, history] of [
    [{ ...watchClaim, actionInput: { ...watchClaim.actionInput, requestedValue: "1:06" } }, [{ direction: "INBOUND", content: "Mi reloj" }]],
    [{ ...watchClaim, actionInput: { ...watchClaim.actionInput, athleteName: "Otra Persona" } }, [{ direction: "INBOUND", content: "Mi reloj" }]],
    [watchClaim, [{ direction: "OUTBOUND", content: "Manda foto de reloj" }]],
  ]) assert.equal(applyAthleteReviewPolicy(classification, reviewContext, history, []).action, null);
});

test("distancia contradictoria solicita aclaracion al atleta y no deriva a humano", () => {
  const output = applyAthleteReviewPolicy({ ...watchClaim, action: "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION", actionInput: { ...watchClaim.actionInput, currentDistance: "21K" } }, reviewContext, [], []);
  assert.equal(output.action, null);
  assert.equal(output.needsHuman, false);
  assert.equal(output.actionInput.evidenceConflict, "distance_mismatch");
});

test("un tiempo en disputa ofrece Video Finish sin cerrarlo por tener tiempo publicado", () => {
  const output = applyAthleteReviewPolicy({ ...watchClaim, actionInput: { ...watchClaim.actionInput, requestedCorrection: "El tiempo no coincide con mi llegada" } },
    { ...reviewContext, result: { ...reviewContext.result, officialTime: "01:44:59", finishTime: "2026-09-13T08:56:12Z" } }, [], []);
  assert.equal(output.action, "EXOTIMER_CHECK_VIDEO_FINISH_AVAILABILITY");
  assert.equal(output.actionInput.approximateTime, "08:56:12");
  assert.equal(output.remainingRequests.length, 1);
});

test("un cambio de categoria satisfecho solo cierra si no quedan otras solicitudes", () => {
  const classification = { ...watchClaim, remainingRequests: [], actionInput: { ...watchClaim.actionInput, targetField: "categoria", requestedValue: "40-49" } };
  const context = { ...reviewContext, result: { ...reviewContext.result, category: "40-49" } };
  assert.equal(requestedChangeAlreadySatisfied(classification, context, []), true);
  assert.equal(requestedChangeAlreadySatisfied({ ...classification, remainingRequests: ["Tiempo faltante"] }, context, []), false);
});
