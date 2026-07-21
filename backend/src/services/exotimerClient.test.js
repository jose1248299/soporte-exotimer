const test = require("node:test");
const assert = require("node:assert/strict");

test("las acciones conservan el contrato y usan los endpoints Race Line v1", async () => {
  const calls = [];
  const competition = {
    id: 530,
    name: "Competencia migrada",
    slug: "competencia-migrada-782",
    status: "finished",
    start_date: "2026-07-01T08:00:00Z",
  };
  const event = {
    id: 900,
    competition_id: 530,
    name: "10K",
    start_at: "2026-07-01T08:00:00Z",
    categories: [
      {
        id: 901,
        category_id: 902,
        category: { id: 902, name: "GENERAL", gender_rule: "Mixto" },
      },
    ],
    extra_data: {},
  };
  const result = {
    id: 1000,
    competition_id: 530,
    event_id: 900,
    category_id: 902,
    participant_display_name: "Ana Perez",
    participant_snapshot_payload: { first_name: "Ana", last_name: "Perez" },
    event_name: "10K",
    category_name: "GENERAL",
    gender: "Femenino",
    dorsal: 1086,
    chip: "1086",
    salida: "10K",
    state: "finalizado",
    official_time_ms: 3600000,
    document: {},
    raw_assignments: [],
  };
  const ticket = {
    id: 1100,
    competition_id: 530,
    title: "General",
    price: 50,
    currency: "PEN",
    event_ids: [900],
  };

  const raceline = require("./racelineClient");
  raceline.apiRequest = async (request) => {
    calls.push(request);
    const { method = "GET", path } = request;

    if (path === "/catalog/api/v1/competitions/") return [competition];
    if (path === "/catalog/api/v1/events/") return [event];
    if (path === "/catalog/api/v1/events/900") return event;
    if (path === "/catalog/api/v1/competitions/530/combine-data/") {
      return { ...competition, events: [event] };
    }
    if (path === "/registration/api/v1/tickets/") return [ticket];
    if (path === "/timing/api/v1/results/admin/") return [result];
    if (path === "/timing/api/v1/results/detail/1000/") {
      return { item: result, result, participant: { name: "Ana", lastname: "Perez" } };
    }
    if (path === "/timing/api/v1/raws/config/salidas/530/") return {};
    if (path === "/timing/api/v1/raws/by-competition/530/") return [];
    if (path === "/timing/api/v1/results/validate/530/") return { total_results: 1 };
    if (path === "/timing/api/v1/devices/active-channels") return [];
    if (method === "PATCH" && path === "/timing/api/v1/results/1000") return { ...result, ...request.data };
    if (method === "PATCH" && path === "/registration/api/v1/tickets/1100") {
      return { ...ticket, ...request.data };
    }
    if (method === "POST" && path === "/timing/api/v1/raws/") {
      return { raw: { id: 1200, ...request.data } };
    }
    if (method === "PATCH" && path === "/timing/api/v1/configs/start-waves/time") {
      return { id: 1300, ...request.data };
    }
    if (method === "POST" && path === "/timing/api/v1/results/edit-times/") {
      return { id: request.data.result_id };
    }
    throw new Error(`Request inesperado: ${method} ${path}`);
  };
  raceline.apiMultipartRequest = async (request) => {
    calls.push(request);
    return {};
  };

  delete require.cache[require.resolve("./exotimerClient")];
  const { executeAction } = require("./exotimerClient");

  const match = await executeAction("SYSTEM_USER", "EXOTIMER_FIND_COMPETITION", {
    competitionId: 782,
  });
  assert.equal(match.match.id, 530);
  assert.equal(match.match.legacyId, 782);

  const results = await executeAction("SYSTEM_USER", "EXOTIMER_GET_RESULTS", {
    competitionId: 782,
  });
  assert.equal(results[0].id, 1000);
  assert.ok(
    calls.some(
      (call) =>
        call.path === "/timing/api/v1/results/admin/" &&
        call.params?.competition_id === 530
    )
  );

  await executeAction("SYSTEM_USER", "EXOTIMER_UPDATE_RESULT_DORSAL", {
    competitionId: 782,
    dorsal: 1086,
    newDorsal: 1186,
  });
  const resultPatch = calls.find(
    (call) => call.method === "PATCH" && call.path === "/timing/api/v1/results/1000"
  );
  assert.deepEqual(resultPatch.data, { dorsal: 1186, chip: "1186" });

  await executeAction("SYSTEM_USER", "EXOTIMER_UPDATE_EVENT_TICKET", {
    competitionId: 782,
    eventId: 900,
    ticketId: 1100,
    price: 65,
  });
  const ticketPatch = calls.find(
    (call) => call.method === "PATCH" && call.path === "/registration/api/v1/tickets/1100"
  );
  assert.deepEqual(ticketPatch.data, { price: 65 });

  await executeAction("SYSTEM_USER", "EXOTIMER_UPDATE_RESULT_EVENT_CATEGORY", {
    competitionId: 782,
    dorsal: 1086,
    newDistance: "10K",
    newCategory: "GENERAL",
    newGender: "Femenino",
  });
  const categoryPatch = calls
    .filter((call) => call.method === "PATCH" && call.path === "/timing/api/v1/results/1000")
    .at(-1);
  assert.equal(categoryPatch.data.event_id, 900);
  assert.equal(categoryPatch.data.category_id, 902);

  await executeAction("SYSTEM_USER", "EXOTIMER_CREATE_MANUAL_RAW", {
    competitionId: 782,
    dorsal: 1086,
    hour: "01/07/2026 09:00:00",
  });
  const rawCreate = calls.find(
    (call) => call.method === "POST" && call.path === "/timing/api/v1/raws/"
  );
  assert.equal(rawCreate.data.competition_id, 530);

  await executeAction("SYSTEM_USER", "EXOTIMER_UPDATE_START_TIME", {
    competitionId: 782,
    eventName: "10K",
    startName: "10K",
    time: "08:00:00",
  });
  assert.ok(
    calls.some(
      (call) =>
        call.method === "PATCH" &&
        call.path === "/timing/api/v1/configs/start-waves/time" &&
        call.data.competition_id === 530
    )
  );

  await executeAction("SYSTEM_USER", "EXOTIMER_EDIT_RESULT_TIME", {
    timeDateCurrent: "2026-07-01T09:00:00-05:00",
    timeCurrent: "01:00:00",
    selectRaw: 1200,
    result_id: 1000,
    name_colum: "loc_Meta",
  });
  assert.ok(
    calls.some(
      (call) =>
        call.method === "POST" && call.path === "/timing/api/v1/results/edit-times/"
    )
  );

  assert.equal(
    calls.some((call) => /\/(?:v2|v3)\//.test(call.path) || call.path === "/api/token/"),
    false
  );
});
