const test = require("node:test");
const assert = require("node:assert/strict");

test("revalida gun time con la salida vigente sin duplicar el raw y sin confundir duracion GPS", async () => {
  const raceline = require("./racelineClient");
  const original = raceline.apiRequest;
  const writes = [];
  const result = {
    id: 177504, competition_id: 615, event_id: 1766, event_name: "21K", dorsal: 61, chip: "61",
    participant_display_name: "Gianluca Ravina Vidal", official_time_ms: 8802000,
    finish_at: "2026-09-13T09:30:31Z", state: "finalizado",
    raw_assignments: [
      { key: "loc_Salida", raw_id: 65099, read_at: "2026-09-13T07:04:42.737", raw: { id: 65099, read_at: "2026-09-13T07:04:42.737Z", zulu_at: "2026-09-13T12:04:42.737Z", location: "SALIDA" } },
      { key: "loc_Meta", raw_id: 76473, read_at: "2026-09-13T09:30:31", raw: { id: 76473, read_at: "2026-09-13T09:30:31Z", location: "META" } },
    ],
  };
  raceline.apiRequest = async ({ path, method = "GET", data }) => {
    if (method !== "GET") { writes.push({ path, data }); throw new Error("No debe escribir"); }
    if (path === "/catalog/api/v1/competitions/") return [{ id: 615, name: "Run & Fun" }];
    if (path === "/timing/api/v1/results/detail/177504/") return { item: result };
    if (path === "/catalog/api/v1/events/1766") return { id: 1766, name: "21K", start_at: "2026-09-13T12:04:00Z",
      extra_data: { admin_form: { configs: { type_salidas: "cronometro", salidas: [{ data: { nombre: "21K", fecha: "13/09/2026, 07:04:00" } }] } } } };
    if (path === "/timing/api/v1/raws/config/salidas/615/") return { 1766: { salidas: [{ data: { nombre: "21K", fecha: "13/09/2026, 07:03:49" } }] } };
    throw new Error(`Unexpected ${path}`);
  };
  delete require.cache[require.resolve("./exotimerClient")];
  try {
    const { executeAction } = require("./exotimerClient");
    const input = { competitionId: 615, resultId: 177504, dorsal: "61", athleteName: "Gianluca Ravina Vidal",
      requestedValue: "02:26:31", gpsElapsedTime: "02:26:31", evidenceFinishDateTime: "2026-09-13T09:30:31-05:00",
      trustAthleteEvidence: true, evidenceSummary: "Garmin con duracion y fecha del evento" };
    for (let n = 0; n < 2; n++) {
      const output = await executeAction("ATHLETE", "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION", input);
      assert.equal(output.verification.verified, true);
      assert.equal(output.verification.officialTime, "02:26:42");
      assert.equal(output.idempotentReplay, true);
      assert.equal(output.changed.reusedRawId, 76473);
    }
    await assert.rejects(executeAction("ATHLETE", "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION", { ...input, distance: "10K" }), /distancia declarada/);
    assert.equal(writes.length, 0);
  } finally {
    raceline.apiRequest = original;
    delete require.cache[require.resolve("./exotimerClient")];
  }
});
