const test = require("node:test");
const assert = require("node:assert/strict");
const {
  actionIdempotencyKey,
  competitionPlanOverrides,
  enforceVerifiedActionReply,
  inspectAthleteResultPreflight,
  mergeActionInput,
  resultHasPublishedTime,
  summarizeResultForClosure,
} = require("./supportProcessor");
const {
  normalizeWhatsappRecipient,
  resolveWhatsappIdentity,
  whatsappConversationRecipient,
} = require("../utils/whatsapp");

test("resuelve telefono y BSUID cuando Meta entrega ambos identificadores", () => {
  const identity = resolveWhatsappIdentity({
    contacts: [
      {
        wa_id: "51999999999",
        user_id: "PE.123456789",
      },
    ],
    messages: [
      {
        from: "51999999999",
        from_user_id: "PE.123456789",
      },
    ],
  });

  assert.deepEqual(identity, {
    phone: "51999999999",
    whatsappUserId: "PE.123456789",
    recipient: "51999999999",
  });
});

test("usa from_user_id sin deformarlo cuando Meta oculta el telefono", () => {
  const identity = resolveWhatsappIdentity({
    contacts: [{ user_id: "PE.1622159666096358" }],
    messages: [{ from_user_id: "PE.1622159666096358" }],
  });

  assert.deepEqual(identity, {
    phone: null,
    whatsappUserId: "PE.1622159666096358",
    recipient: "PE.1622159666096358",
  });
  assert.equal(
    normalizeWhatsappRecipient("PE.1622159666096358"),
    "PE.1622159666096358"
  );
});

test("los envios prefieren el BSUID estable y conservan telefonos tradicionales", () => {
  assert.equal(
    whatsappConversationRecipient({
      phone: "51999999999",
      whatsappUserId: "PE.123456789",
    }),
    "PE.123456789"
  );
  assert.equal(
    whatsappConversationRecipient({ phone: "+51 999 999 999" }),
    "51999999999"
  );
});

test("una correccion de tiempo no verificada nunca se comunica como exitosa", () => {
  const reply = enforceVerifiedActionReply({
    reply: "Tu tiempo ya fue corregido. Refresca la pagina para verlo.",
    classification: {
      action: "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION",
      actionInput: { requestedValue: "01:06:01" },
    },
    actionResult: {
      created: true,
      changed: { requestedOfficialTime: "01:06:01" },
      verification: {
        verified: false,
        officialTime: "01:11:02",
      },
    },
  });

  assert.match(reply, /no coincide todavia/i);
  assert.match(reply, /01:06:01/);
  assert.match(reply, /01:11:02/);
  assert.match(reply, /revision humana/i);
  assert.doesNotMatch(reply, /ya fue corregido/i);
});

test("una correccion de tiempo verificada conserva la respuesta generada", () => {
  const original = "Tu tiempo fue corregido a 01:06:01.";
  const reply = enforceVerifiedActionReply({
    reply: original,
    classification: {
      action: "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION",
    },
    actionResult: {
      created: true,
      verification: { verified: true, officialTime: "01:06:01" },
    },
  });

  assert.equal(reply, original);
});

test("un nuevo documento limpia identificadores heredados de otra persona", () => {
  const merged = mergeActionInput(
    {
      document: "74881111",
      email: "karen@example.com",
      phone: "904861276",
      competitionId: 543,
    },
    {
      document: "76322316",
      participantName: "Anny Tamayo Rojas",
    }
  );

  assert.equal(merged.document, "76322316");
  assert.equal(merged.participantName, "Anny Tamayo Rojas");
  assert.equal(merged.email, undefined);
  assert.equal(merged.phone, undefined);
  assert.equal(merged.competitionId, 543);
});

test("la idempotencia ignora confirmacion y metadatos de politica", () => {
  const base = {
    competitionId: 543,
    document: "76322316",
    confirmed: false,
  };
  assert.equal(
    actionIdempotencyKey("EXOTIMER_SEND_INSCRIPTION_CONFIRMATION_WHATSAPP", base),
    actionIdempotencyKey("EXOTIMER_SEND_INSCRIPTION_CONFIRMATION_WHATSAPP", {
      ...base,
      confirmed: true,
      policy: { enabled: true },
    })
  );
});

test("recupera campos editados de un plan reconstruido por IA", () => {
  const overrides = competitionPlanOverrides({
    competition: {
      name: "PIURA SUN TRAIL 2026",
      date: "2026-09-13",
      startAt: "2026-09-13T07:00:00-05:00",
      city: "Piura",
      sport: "Trail Running",
      organizer: "Sin Asignar",
    },
    events: [{ name: "8K" }, { name: "15K" }],
    tickets: [{ title: "8K", price: 55 }],
  });

  assert.equal(overrides.city, "Piura");
  assert.equal(overrides.startTime, "07:00");
  assert.equal(overrides.events.length, 2);
  assert.equal(overrides.tickets[0].price, 55);
});

test("normaliza tiempos y campos de resultados Race Line v1", () => {
  const result = {
    id: 165106,
    dorsal: 239,
    chip: "239",
    participant_display_name: "Maria Isabel Hernandez Ramirez",
    event_name: "25K",
    category_name: "18-39",
    gender: "Femenino",
    state: "finalizado",
    official_time_ms: 15918740,
    finish_at: "2026-07-26T12:25:18.740000Z",
  };

  assert.equal(resultHasPublishedTime(result), true);
  assert.deepEqual(summarizeResultForClosure(result), {
    resultId: 165106,
    dorsal: 239,
    chip: "239",
    athleteName: "Maria Isabel Hernandez Ramirez",
    athleteLastname: null,
    distance: "25K",
    gender: "Femenino",
    category: "18-39",
    officialTime: "04:25:19",
    finishTime: "2026-07-26T12:25:18.740000Z",
    state: "finalizado",
  });
});

test("el preflight concluye un reclamo de resultado que ya existe", async () => {
  const calls = [];
  const listResult = {
    id: 165106,
    dorsal: 239,
    chip: "239",
    participant_display_name: "Maria Isabel Hernandez Ramirez",
    event_name: "25K",
    category_name: "18-39",
    gender: "Masculino",
    state: "finalizado",
    official_time_ms: 15918740,
    finish_at: "2026-07-26T12:25:18.740000Z",
  };
  const execute = async (_userType, action, input) => {
    calls.push({ action, input });
    if (action === "EXOTIMER_GET_RESULTS") return [listResult];
    if (action === "EXOTIMER_GET_RESULT_DETAIL") {
      return {
        ...listResult,
        participant: {
          name: "Maria Isabel",
          lastname: "Hernandez Ramirez",
        },
        event: {
          name: "25K",
          category: { name: "18-39", genre: "Masculino" },
        },
        tiempo_oficial: "04:25:19",
        hora_meta: listResult.finish_at,
      };
    }
    throw new Error(`Accion inesperada: ${action}`);
  };

  const classification = {
    userType: "ATHLETE",
    action: "EXOTIMER_CREATE_RESULT_CORRECTION_CASE",
    intent: "resultado no publicado",
    summary: "La atleta indica que su resultado sigue sin aparecer.",
    needsHuman: true,
    actionInput: {
      competitionId: 62,
      dorsal: "239",
      athleteName: "Isabel Hernandez Ramirez",
      requestedCorrection: "Crear participante nuevo",
    },
  };
  const preflight = await inspectAthleteResultPreflight({
    supportCase: { competitionId: 62 },
    classification,
    text: "Sigo esperando y mi resultado no sale en la plataforma",
    userType: "ATHLETE",
    execute,
  });

  assert.equal(preflight.classification.action, null);
  assert.equal(preflight.classification.needsHuman, false);
  assert.equal(preflight.resolution.type, "RESULT_ALREADY_UPDATED");
  assert.equal(preflight.resolution.result.officialTime, "04:25:19");
  assert.equal(preflight.audit.request.endpoint, "/timing/api/v1/results/admin/");
  assert.deepEqual(
    calls.map((call) => call.action),
    ["EXOTIMER_GET_RESULTS", "EXOTIMER_GET_RESULT_DETAIL"]
  );
});

test("el preflight promueve evidencia acumulada cuando el resultado no tiene tiempo", async () => {
  const result = {
    id: 167001,
    dorsal: 7,
    chip: "7",
    participant_display_name: "Alex Reyes Chinchay",
    event_name: "21K",
    category_name: "LIBRE",
    gender: "Masculino",
    state: "sin_salida",
    official_time_ms: null,
    finish_at: null,
  };
  const execute = async (_userType, action) => {
    if (action === "EXOTIMER_GET_RESULTS") return [result];
    if (action === "EXOTIMER_GET_RESULT_DETAIL") return result;
    throw new Error(`Accion inesperada: ${action}`);
  };
  const classification = {
    userType: "ATHLETE",
    action: "EXOTIMER_CREATE_RESULT_CORRECTION_CASE",
    summary:
      "Evidencia GPS Adidas con 21.42 km, 02:09:54 y hora de inicio 07:05.",
    needsHuman: true,
    actionInput: {
      competitionId: 569,
      dorsal: "7",
      athleteName: "Alex Reyes",
      requestedCorrection: "Crear participante nuevo",
      requestedValue: "02:09:54",
      gpsElapsedTime: "02:09:54",
      activityStartDateTime: "07:05",
      evidencePolicy: "TRUST_ATHLETE_EVIDENCE",
      trustAthleteEvidence: true,
      evidenceSummary:
        "Capturas de Adidas y GPS con distancia, duracion y recorrido de la carrera.",
    },
  };

  const preflight = await inspectAthleteResultPreflight({
    supportCase: { competitionId: 569 },
    classification,
    text: "Adjunto las capturas adicionales",
    userType: "ATHLETE",
    execute,
  });

  assert.equal(preflight.promoted, true);
  assert.equal(
    preflight.classification.action,
    "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION"
  );
  assert.equal(preflight.classification.needsHuman, false);
  assert.equal(preflight.classification.actionInput.resultId, 167001);
  assert.equal(preflight.audit.response.decision, "promote_time_evidence_correction");
});
