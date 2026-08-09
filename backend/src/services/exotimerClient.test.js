const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMessage } = require("./ai");

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
    if (path === "/registration/api/v1/inscriptions/") return [];
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

  const inscription = await executeAction(
    "SYSTEM_USER",
    "EXOTIMER_GET_INSCRIPTION",
    {
      competitionId: 782,
      dorsal: 1086,
    }
  );
  assert.equal(inscription.found, false);
  assert.equal(inscription.resultFound, true);
  assert.equal(inscription.timingResult.id, 1000);
  assert.ok(
    calls.some(
      (call) => call.path === "/registration/api/v1/inscriptions/"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.path === "/registration/api/v1/inscriptions/" &&
        call.params?.competition_id === 782
    )
  );
  assert.equal(
    calls.some(
      (call) =>
        call.path === "/registration/api/v1/inscriptions/detail-verify/"
    ),
    false
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

test("las busquedas de inscripcion no mezclan identidades incompatibles", async () => {
  const calls = [];
  const raceline = require("./racelineClient");
  raceline.apiRequest = async (request) => {
    calls.push(request);
    if (request.path === "/registration/api/v1/inscriptions/") {
      return [
        {
          id: 30683,
          competition_id: 543,
          document: {
            nombre: "Karen",
            apellidos: "Tamayo",
            dni: "74881111",
            email: "karentamayo981@gmail.com",
            phone: "904861276",
          },
        },
        {
          id: 30705,
          competition_id: 543,
          document: {
            nombre: "Anny",
            apellidos: "Tamayo Rojas",
            dni: "76322316",
            email: "tamayorojasanny@gmail.com",
            phone: "999111222",
          },
        },
      ];
    }
    throw new Error(`Request inesperado: ${request.path}`);
  };

  delete require.cache[require.resolve("./exotimerClient")];
  const { executeAction } = require("./exotimerClient");
  const conflicting = await executeAction(
    "ATHLETE",
    "EXOTIMER_GET_INSCRIPTION_BY_REFERENCE_OR_DOCUMENT",
    {
      competitionId: 543,
      document: "7632316",
      email: "karentamayo981@gmail.com",
    }
  );
  assert.equal(conflicting.found, false);
  assert.ok(conflicting.candidates[0].conflicts.includes("document"));

  const exact = await executeAction(
    "ATHLETE",
    "EXOTIMER_GET_INSCRIPTION_BY_REFERENCE_OR_DOCUMENT",
    {
      competitionId: 543,
      document: "76322316",
    }
  );
  assert.equal(exact.found, true);
  assert.equal(exact.bestMatch.id, 30705);
  assert.ok(
    calls.every(
      (call) => call.params?.competition_id === 543
    )
  );
});

test("preview no escribe y apply crea categorias, tickets, pagos y timing verificable", async () => {
  const calls = [];
  const createdTickets = [];
  let createdCompetition = null;
  const raceline = require("./racelineClient");

  raceline.apiRequest = async (request) => {
    calls.push(request);
    const { method = "GET", path } = request;

    if (path === "/catalog/api/v1/countries") {
      return [{ id: 1, name: "peru" }];
    }
    if (path === "/catalog/api/v1/cities") {
      return [{ id: 1, name: "lima", country_id: 1 }];
    }
    if (path === "/catalog/api/v1/sports/") {
      return [{ id: 1, name: "running" }];
    }
    if (path === "/identity/api/v1/organizations/") {
      return [{ id: 9407, name: "Triatlon GT" }];
    }
    if (path === "/catalog/api/v1/competitions/") {
      return createdCompetition ? [createdCompetition] : [];
    }

    if (
      method === "POST" &&
      path === "/catalog/api/v1/competitions/setup"
    ) {
      const events = request.data.events.map((event, eventIndex) => ({
        ...event,
        id: 1668 + eventIndex,
        competition_id: 561,
        categories: event.categories.map((row, categoryIndex) => ({
          id: 7000 + eventIndex * 100 + categoryIndex,
          event_id: 1668 + eventIndex,
          category_id: 2619 + eventIndex * 100 + categoryIndex,
          category: {
            ...row.category,
            id: 2619 + eventIndex * 100 + categoryIndex,
          },
        })),
      }));
      createdCompetition = {
        ...request.data.competition,
        id: 561,
        banner_url: null,
        bases_url: null,
        owners: request.data.competition.owners.map((owner, index) => ({
          ...owner,
          id: index + 1,
          competition_id: 561,
        })),
        events,
      };
      return {
        competition: createdCompetition,
        timing_configs: events.map((event) => ({
          event_id: event.id,
          status: "created",
        })),
      };
    }

    if (path === "/catalog/api/v1/competitions/561/full") {
      return createdCompetition;
    }
    if (path === "/registration/api/v1/tickets/") {
      if (method === "POST") {
        const ticket = {
          id: 976 + createdTickets.length,
          ...request.data,
        };
        createdTickets.push(ticket);
        return ticket;
      }
      return createdTickets;
    }
    if (
      method === "PATCH" &&
      /^\/registration\/api\/v1\/tickets\/\d+$/.test(path)
    ) {
      const id = Number(path.split("/").at(-1));
      const index = createdTickets.findIndex((ticket) => ticket.id === id);
      createdTickets[index] = {
        ...createdTickets[index],
        ...request.data,
      };
      return createdTickets[index];
    }
    if (path === "/timing/api/v1/raws/config/salidas/561/") {
      return Object.fromEntries(
        createdCompetition.events.map((event, index) => [
          event.id,
          {
            id: index + 1,
            event_id: event.id,
            start_waves: [
              {
                name: `${event.name} - salida general`,
                starts_at: event.start_at,
              },
            ],
          },
        ])
      );
    }
    throw new Error(`Request inesperado: ${method} ${path}`);
  };
  raceline.apiMultipartRequest = async (request) => {
    calls.push(request);
    return {};
  };

  delete require.cache[require.resolve("./exotimerClient")];
  const { executeAction } = require("./exotimerClient");
  const input = {
    competitionName: "Hybrid Race Test",
    eventDate: "2026-11-14",
    startTime: "06:00",
    venueName: "Complejo Deportivo Costa Verde",
    city: "Lima",
    country: "Peru",
    sport: "Running",
    organizer: "Triatlon GT",
    publish: true,
    registrationDeadline: "2026-10-21",
    events: [
      {
        name: "INDIVIDUAL",
        distanceMeters: 8000,
        categories: [
          { name: "OPEN MUJER", genderRule: "Femenino" },
          { name: "OPEN HOMBRE", genderRule: "Masculino" },
          { name: "PRO HOMBRE", genderRule: "Masculino" },
        ],
      },
      {
        name: "DUPLAS",
        distanceMeters: 8000,
        categories: [
          {
            name: "OPEN DUPLA HOMBRE/HOMBRE",
            genderRule: "Masculino",
          },
          {
            name: "OPEN DUPLA MUJER/MUJER",
            genderRule: "Femenino",
          },
          { name: "OPEN DUPLA MIXTA", genderRule: "Mixto" },
          {
            name: "PRO DUPLA HOMBRE/HOMBRE",
            genderRule: "Masculino",
          },
          { name: "PRO DUPLA MIXTA", genderRule: "Mixto" },
        ],
      },
    ],
    tickets: [
      {
        title: "Individual Open",
        price: 170,
        eventName: "INDIVIDUAL",
        categoryNames: ["OPEN"],
      },
      {
        title: "Individual Pro",
        price: 170,
        eventName: "INDIVIDUAL",
        categoryNames: ["PRO"],
      },
      {
        title: "Duplas Open",
        price: 340,
        eventName: "DUPLAS",
        categoryNames: ["OPEN DUPLA"],
        teamSize: 2,
      },
      {
        title: "Duplas Pro",
        price: 340,
        eventName: "DUPLAS",
        categoryNames: ["PRO DUPLA"],
        teamSize: 2,
      },
    ],
    payment: {
      type: "voucher",
      bank: "Interbank",
      account: "0573340081703",
      cci: "00305701334008170376",
    },
  };

  const preview = await executeAction(
    "TIMER",
    "EXOTIMER_PREVIEW_COMPETITION_SETUP",
    input
  );
  assert.equal(preview.readyToApply, true);
  assert.equal(preview.summary.eventCount, 2);
  assert.equal(preview.summary.categoryCount, 8);
  assert.equal(preview.summary.ticketCount, 2);
  assert.deepEqual(
    preview.plan.tickets.map((ticket) => ticket.title),
    ["Individual", "Duplas"]
  );
  assert.equal(
    calls.some((call) => ["POST", "PATCH"].includes(call.method)),
    false
  );

  const recoveredPreview = await executeAction(
    "TIMER",
    "EXOTIMER_PREVIEW_COMPETITION_SETUP",
    {
      plan: {
        ...preview.plan,
        version: 999,
        competition: {
          ...preview.plan.competition,
          city: "Lima",
          sport: "Running",
          organizer: "Triatlon GT",
        },
      },
    }
  );
  assert.equal(recoveredPreview.readyToApply, true);
  assert.equal(recoveredPreview.plan.events.length, 2);
  assert.equal(recoveredPreview.plan.tickets.length, 2);

  const ambiguousPreview = await executeAction(
    "TIMER",
    "EXOTIMER_PREVIEW_COMPETITION_SETUP",
    {
      ...input,
      competitionName: "Hybrid Race sin categorias por nivel",
      events: input.events.map((event) =>
        event.name === "DUPLAS"
          ? {
              ...event,
              categories: [
                { name: "DUPLAS Masculino", genderRule: "Masculino" },
                { name: "DUPLAS Femenino", genderRule: "Femenino" },
                { name: "DUPLAS Mixto", genderRule: "Mixto" },
              ],
            }
          : event
      ),
      tickets: input.tickets.map((ticket) =>
        ticket.eventName === "DUPLAS"
          ? {
              ...ticket,
              categoryNames: [
                "DUPLAS Masculino",
                "DUPLAS Femenino",
                "DUPLAS Mixto",
              ],
            }
          : ticket
      ),
    }
  );
  assert.equal(ambiguousPreview.readyToApply, false);
  assert.equal(ambiguousPreview.summary.categoryCount, 6);
  assert.equal(ambiguousPreview.summary.ticketCount, 2);
  assert.ok(
    ambiguousPreview.plan.missingFields.includes("categoryTierDefinitions")
  );

  const continuedPreview = await executeAction(
    "TIMER",
    "EXOTIMER_PREVIEW_COMPETITION_SETUP",
    {
      plan: preview.plan,
      payment: {
        ...preview.plan.payment,
        details:
          "Interbank\nCuenta: 0573340081703\nCCI: 00305701334008170376",
      },
    }
  );
  assert.equal(continuedPreview.plan.events.length, 2);
  assert.equal(continuedPreview.plan.tickets.length, 2);
  assert.equal(continuedPreview.plan.competition.organizer.id, 9407);

  const result = await executeAction(
    "TIMER",
    "EXOTIMER_APPLY_COMPETITION_SETUP",
    {
      confirmed: true,
      plan: continuedPreview.plan,
    }
  );
  assert.equal(result.competitionId, 561);
  assert.equal(result.complete, true);
  assert.equal(result.needsRepair, false);
  assert.equal(createdTickets.length, 2);

  const setup = calls.find(
    (call) =>
      call.method === "POST" &&
      call.path === "/catalog/api/v1/competitions/setup"
  );
  assert.equal(setup.data.competition.status, "published");
  assert.equal(setup.data.events.length, 2);
  assert.equal(setup.data.events[0].categories.length, 3);
  assert.equal(setup.data.events[1].categories.length, 5);
  assert.deepEqual(
    setup.data.events[0].categories.map(
      (row) => row.category.gender_rule
    ),
    ["Femenino", "Masculino", "Masculino"]
  );

  const duplasTicket = createdTickets.find(
    (ticket) => ticket.title === "Duplas"
  );
  assert.equal(duplasTicket.price, 340);
  assert.equal(duplasTicket.metadata_json.team_size, 2);
  assert.equal(duplasTicket.event_bindings[0].category_ids.length, 5);
  assert.equal(result.verification.checks.paymentMatches, true);
  assert.equal(result.verification.checks.eventsComplete, true);
  assert.equal(result.verification.checks.ticketsComplete, true);
  assert.ok(
    result.tickets.every(
      (ticket) =>
        ticket.eventBindingMatches && ticket.categoryBindingsMatch
    )
  );

  const resumed = await executeAction(
    "TIMER",
    "EXOTIMER_APPLY_COMPETITION_SETUP",
    {
      confirmed: true,
      plan: continuedPreview.plan,
    }
  );
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.complete, true);
  assert.equal(createdTickets.length, 2);
  assert.equal(
    calls.filter(
      (call) =>
        call.method === "POST" &&
        call.path === "/catalog/api/v1/competitions/setup"
    ).length,
    1
  );
});

test("la confirmacion del Timer reutiliza exactamente el plan validado", async () => {
  const plan = {
    version: 1,
    readyToApply: true,
    fingerprint: "setup-test",
    competition: { name: "Hybrid Race" },
    events: [{ key: "individual", name: "Individual" }],
    tickets: [{ title: "Individual Open", price: 170 }],
  };

  const classification = await classifyMessage({
    text: "Confirmo, procede con la creacion",
    forcedTimer: true,
    previousClassification: {
      action: "EXOTIMER_PREVIEW_COMPETITION_SETUP",
      actionInput: { plan },
    },
    history: [],
  });

  assert.equal(classification.action, "EXOTIMER_APPLY_COMPETITION_SETUP");
  assert.equal(classification.actionInput.confirmed, true);
  assert.strictEqual(classification.actionInput.plan, plan);
  assert.equal(classification.needsHuman, false);
});

test("la correccion GPS usa la salida oficial y verifica la respuesta v1", async () => {
  const calls = [];
  const competition = {
    id: 569,
    name: "Media Maraton de Chiclayo 2026",
    slug: "media-maraton-de-chiclayo-2026",
    start_date: "2026-07-29T12:05:52Z",
  };
  const event = {
    id: 1699,
    competition_id: 569,
    name: "21K",
    start_at: "2026-07-29T12:05:52Z",
    extra_data: {},
    categories: [],
  };
  let result = {
    id: 167001,
    competition_id: 569,
    event_id: 1699,
    category_id: 2747,
    participant_display_name: "Alex Reyes Chinchay",
    participant_snapshot_payload: {
      first_name: "Alex",
      last_name: "Reyes Chinchay",
    },
    event_name: "21K",
    category_name: "LIBRE",
    gender: "Masculino",
    dorsal: 7,
    chip: "7",
    salida: "21K",
    state: "sin_salida",
    official_time_ms: null,
    finish_at: null,
    document: { time_TOTAL: "00:00:00" },
    raw_assignments: [],
  };

  const raceline = require("./racelineClient");
  raceline.apiRequest = async (request) => {
    calls.push(request);
    const { method = "GET", path } = request;
    if (path === "/catalog/api/v1/competitions/") return [competition];
    if (path === "/catalog/api/v1/events/1699") return event;
    if (path === "/timing/api/v1/raws/config/salidas/569/") return {};
    if (path === "/timing/api/v1/results/admin/") return [result];
    if (path === "/timing/api/v1/results/detail/167001/") {
      return { item: result };
    }
    if (method === "POST" && path === "/timing/api/v1/raws/") {
      return { id: 29599, ...request.data };
    }
    if (
      method === "POST" &&
      path === "/timing/api/v1/results/edit-times/"
    ) {
      result = {
        ...result,
        state: "finalizado",
        official_time_ms: 7794000,
        finish_at: "2026-07-29T14:15:46Z",
        document: {
          time_TOTAL: "02:09:54",
          loc_Meta: 29599,
        },
      };
      return { id: 167001, updated: true };
    }
    throw new Error(`Request inesperado: ${method} ${path}`);
  };

  delete require.cache[require.resolve("./exotimerClient")];
  const { executeAction } = require("./exotimerClient");
  const output = await executeAction(
    "ATHLETE",
    "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION",
    {
      competitionId: 569,
      dorsal: 7,
      athleteName: "Alex Reyes",
      requestedValue: "02:09:54",
      gpsElapsedTime: "02:09:54",
      evidenceFinishTime: "02:09:54",
      activityStartDateTime: "07:05",
      evidencePolicy: "TRUST_ATHLETE_EVIDENCE",
      trustAthleteEvidence: true,
      evidenceSummary:
        "Capturas de Adidas y GPS con distancia 21.42 km, duracion y recorrido.",
    }
  );

  const rawCreate = calls.find(
    (call) => call.method === "POST" && call.path === "/timing/api/v1/raws/"
  );
  const editTime = calls.find(
    (call) =>
      call.method === "POST" &&
      call.path === "/timing/api/v1/results/edit-times/"
  );
  assert.equal(rawCreate.data.hour, "29/07/2026 09:15:46");
  assert.equal(editTime.data.timeCurrent, "02:09:54");
  assert.equal(
    editTime.data.timeDateCurrent,
    "2026-07-29T09:15:46-05:00"
  );
  assert.equal(output.verification.verified, true);
  assert.equal(output.verification.officialTime, "02:09:54");
  assert.equal(output.changed.after.state, "finalizado");
});

test("tiempo_chip crea y asigna salida individual antes de corregir la meta", async () => {
  const calls = [];
  const competition = {
    id: 585,
    name: "Carrera tiempo chip",
    slug: "carrera-tiempo-chip",
    start_date: "2026-08-09T13:27:58Z",
  };
  const event = {
    id: 1718,
    competition_id: 585,
    name: "10K",
    start_at: "2026-08-09T13:27:58Z",
    extra_data: {
      admin_form: {
        configs: {
          type_salidas: "tiempo_chip",
          salidas: [
            {
              data: {
                nombre: "10K",
                fecha: "09/08/2026, 08:27:58",
              },
            },
          ],
        },
      },
    },
    categories: [],
  };
  let result = {
    id: 172579,
    competition_id: 585,
    event_id: 1718,
    participant_display_name: "Claudia Garcia Silva",
    participant_snapshot_payload: {
      first_name: "Claudia",
      last_name: "Garcia Silva",
    },
    event_name: "10K",
    category_name: "GENERAL",
    gender: "Femenino",
    dorsal: 1362,
    chip: "1362",
    salida: "10K",
    state: "en_carrera",
    official_time_ms: null,
    finish_at: null,
    document: { time_TOTAL: "00:00:00" },
    raw_assignments: [],
  };
  let nextRawId = 30001;

  const raceline = require("./racelineClient");
  raceline.apiRequest = async (request) => {
    calls.push(request);
    const { method = "GET", path } = request;
    if (path === "/catalog/api/v1/competitions/") return [competition];
    if (path === "/catalog/api/v1/events/1718") return event;
    if (path === "/timing/api/v1/raws/config/salidas/585/") return {};
    if (path === "/timing/api/v1/results/admin/") return [result];
    if (path === "/timing/api/v1/results/detail/172579/") {
      return { item: result };
    }
    if (method === "POST" && path === "/timing/api/v1/raws/") {
      return { id: nextRawId++, ...request.data };
    }
    if (
      method === "POST" &&
      path === "/timing/api/v1/results/edit-times/"
    ) {
      const rawId = request.data.selectRaw;
      const location = request.data.name_colum === "loc_Salida" ? "SALIDA" : "META";
      const assignment = {
        key: request.data.name_colum,
        raw_id: rawId,
        raw: {
          id: rawId,
          dorsal: "1362",
          chip: "1362",
          read_at: request.data.timeDateCurrent,
          location,
        },
      };
      result = {
        ...result,
        raw_assignments: [
          ...result.raw_assignments.filter(
            (row) => row.key !== request.data.name_colum
          ),
          assignment,
        ],
      };
      if (request.data.name_colum === "loc_Meta") {
        result = {
          ...result,
          state: "finalizado",
          official_time_ms: 3961000,
          finish_at: "2026-08-09T09:39:00-05:00",
          document: {
            ...result.document,
            time_TOTAL: "01:06:01",
            loc_Meta: rawId,
          },
        };
      }
      return { id: 172579, updated: true };
    }
    throw new Error(`Request inesperado: ${method} ${path}`);
  };

  delete require.cache[require.resolve("./exotimerClient")];
  const { executeAction } = require("./exotimerClient");
  const output = await executeAction(
    "ATHLETE",
    "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION",
    {
      competitionId: 585,
      dorsal: 1362,
      athleteName: "Claudia Garcia Silva",
      requestedValue: "01:06:01",
      evidenceElapsedTime: "01:06:01",
      evidenceFinishDateTime: "2026-08-09T09:39:00-05:00",
      evidencePolicy: "TRUST_ATHLETE_EVIDENCE",
      trustAthleteEvidence: true,
      hasStrongEvidence: true,
      evidenceSummary:
        "Reloj, dorsal, medalla e identidad compatibles con el evento.",
    }
  );

  const rawCreates = calls.filter(
    (call) => call.method === "POST" && call.path === "/timing/api/v1/raws/"
  );
  const timeEdits = calls.filter(
    (call) =>
      call.method === "POST" &&
      call.path === "/timing/api/v1/results/edit-times/"
  );
  assert.equal(rawCreates.length, 2);
  assert.equal(rawCreates[0].data.location, "SALIDA");
  assert.equal(rawCreates[0].data.hour, "09/08/2026 08:32:59");
  assert.equal(rawCreates[1].data.location, "META");
  assert.equal(rawCreates[1].data.hour, "09/08/2026 09:39:00");
  assert.equal(timeEdits[0].data.name_colum, "loc_Salida");
  assert.equal(timeEdits[0].data.timeCurrent, "00:05:01");
  assert.equal(timeEdits[1].data.name_colum, "loc_Meta");
  assert.equal(timeEdits[1].data.timeCurrent, "01:06:01");
  assert.equal(output.timingMode, "tiempo_chip");
  assert.equal(output.start.created, true);
  assert.equal(output.verification.verified, true);
  assert.equal(output.verification.officialTime, "01:06:01");
});
