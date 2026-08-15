const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyMessage } = require("./ai");
const { parseVideoFinishFindingMessage } = require("../utils/videoFinish");

const findingMessage = `Hola, encontre mi llegada usando la busqueda asistida de Video Finish.

[HALLAZGO GENERADO POR FINISHER DATA]
Origen: recuperacion autoservicio de resultado
ID Evento: 591
Evento: Carrera de prueba 10K
Fecha: 15/08/2026
URL de busqueda: https://finisherdata.com/eventos/carrera_de_prueba_10k/videofinish?id_event=591&recuperar=1
Nombre completo: Ana Perez
Dorsal declarado: 002
Distancia declarada: 10K
Hora aproximada indicada: 10:30:00
Hora marcada en el evento: 10:36:07
Timestamp exacto de camara: 2026-08-15T15:36:12.000Z
Inicio de la grabacion revisada: 2026-08-15T15:35:52.000Z
Detalle visual: Se observa a la atleta con dorsal 2 cruzando la meta.`;

test("parsea el hallazgo Video Finish y normaliza el dorsal", () => {
  const parsed = parseVideoFinishFindingMessage(findingMessage);

  assert.equal(parsed.competitionId, "591");
  assert.equal(parsed.dorsal, "2");
  assert.equal(parsed.participantName, "Ana Perez");
  assert.equal(parsed.videoFinishDistance, "10K");
  assert.equal(parsed.videoFinishCameraTimestamp, "2026-08-15T15:36:12.000Z");
  assert.equal(parsed.evidencePolicy, "VIDEO_FINISH_SELF_SERVICE");
});

test("clasifica el hallazgo sin depender de una interpretacion libre de IA", async () => {
  const classification = await classifyMessage({
    text: findingMessage,
    forcedTimer: false,
  });

  assert.equal(classification.userType, "ATHLETE");
  assert.equal(
    classification.action,
    "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION"
  );
  assert.equal(classification.actionInput.dorsal, "2");
  assert.equal(classification.needsHuman, false);
});

test("comprueba disponibilidad y valida la hora de meta sin exponer la URL temporal", async () => {
  const calls = [];
  let corrected = false;
  const competition = {
    id: 591,
    name: "Carrera de prueba 10K",
    slug: "carrera-de-prueba-10k-591",
    status: "finished",
    start_date: "2026-08-15T06:00:00-05:00",
    description: { gapVideo: 5 },
  };
  const result = {
    id: 801,
    competition_id: 591,
    event_id: 700,
    event_name: "10K",
    participant_display_name: "Ana Perez",
    dorsal: 2,
    chip: "2",
    state: "finalizado",
  };

  const raceline = require("./racelineClient");
  const videoFinishClient = require("./videoFinishClient");
  const originalApiRequest = raceline.apiRequest;
  const originalRecoveryRequest = videoFinishClient.requestRecoveryRecording;

  raceline.apiRequest = async (request) => {
    calls.push(request);
    if (request.path === "/catalog/api/v1/competitions/") {
      return [competition];
    }
    if (request.path === "/catalog/api/v1/competitions/591/full") {
      return { ...competition, events: [] };
    }
    if (request.path === "/results/api/v1/results/") {
      return [{ id: 801, state: "finalizado" }];
    }
    if (request.path === "/timing/api/v1/devices/competitions/591/camera") {
      return { active: true, provider_camera_id: "camera-591" };
    }
    if (request.path === "/timing/api/v1/results/admin/") {
      return [result];
    }
    if (request.path === "/timing/api/v1/results/detail/801/") {
      return {
        item: {
          ...result,
          official_time_ms: corrected ? 5767000 : 0,
          finish_at: corrected ? "2026-08-15T15:36:07.000Z" : null,
          raw_assignments: [
            {
              key: "loc_Salida",
              raw_id: 901,
              read_at: "2026-08-15T14:00:00.000Z",
              raw: {
                id: 901,
                dorsal: 2,
                chip: "2",
                location: "SALIDA",
                read_at: "2026-08-15T14:00:00.000Z",
              },
            },
          ],
        },
      };
    }
    if (request.path === "/catalog/api/v1/events/700") {
      return {
        id: 700,
        name: "10K",
        extra_data: {
          admin_form: { configs: { type_salidas: "tiempo_chip" } },
        },
      };
    }
    if (request.path === "/timing/api/v1/raws/config/salidas/591/") {
      return {};
    }
    if (request.method === "POST" && request.path === "/timing/api/v1/raws/") {
      return { raw: { id: 902, ...request.data } };
    }
    if (
      request.method === "POST" &&
      request.path === "/timing/api/v1/results/edit-times/"
    ) {
      corrected = true;
      return { id: request.data.result_id };
    }
    throw new Error(`Request inesperado: ${request.path}`);
  };
  videoFinishClient.requestRecoveryRecording = async ({ competitionId, time }) => {
    calls.push({ path: "recovery-recording", competitionId, time });
    return {
      status: 200,
      data: {
        url: "https://video-provider.example/temporary-recording-token",
        targetAt: "2026-08-15T15:36:12.000Z",
        recordingStart: "2026-08-15T15:35:52.000Z",
        leadSeconds: 20,
      },
    };
  };

  delete require.cache[require.resolve("./exotimerClient")];
  const { executeAction } = require("./exotimerClient");

  try {
    const availability = await executeAction(
      "ATHLETE",
      "EXOTIMER_CHECK_VIDEO_FINISH_AVAILABILITY",
      { competitionId: 591, approximateTime: "10:30:00" }
    );
    assert.equal(availability.available, true);
    assert.match(availability.publicRecoveryUrl, /id_event=591/);
    assert.doesNotMatch(JSON.stringify(availability), /temporary-recording-token/);

    const validation = await executeAction(
      "ATHLETE",
      "EXOTIMER_VALIDATE_VIDEO_FINISH_FINDING",
      parseVideoFinishFindingMessage(findingMessage)
    );
    assert.equal(validation.valid, true);
    assert.equal(validation.readyForCorrection, true);
    assert.equal(validation.resultId, 801);
    assert.equal(
      validation.correctedFinishDateTime,
      "2026-08-15T10:36:07-05:00"
    );
    assert.ok(
      calls.some(
        (call) =>
          call.path === "recovery-recording" && call.time === "10:36:07"
      )
    );
    assert.doesNotMatch(JSON.stringify(validation), /temporary-recording-token/);

    const correction = await executeAction(
      "ATHLETE",
      "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION",
      parseVideoFinishFindingMessage(findingMessage)
    );
    assert.equal(correction.evidencePolicy, "VIDEO_FINISH_SELF_SERVICE");
    assert.equal(correction.verification.verified, true);
    assert.equal(correction.changed.computedTimeCurrent, "01:36:07");
    assert.equal(correction.start.preserved, true);
    assert.equal(correction.start.rawId, 901);
    assert.equal(
      calls.filter(
        (call) =>
          call.method === "POST" && call.path === "/timing/api/v1/raws/"
      ).length,
      1
    );
    assert.equal(
      calls.find(
        (call) =>
          call.method === "POST" && call.path === "/timing/api/v1/raws/"
      ).data.hour,
      "15/08/2026 10:36:07"
    );
    assert.doesNotMatch(JSON.stringify(correction), /temporary-recording-token/);
  } finally {
    raceline.apiRequest = originalApiRequest;
    videoFinishClient.requestRecoveryRecording = originalRecoveryRequest;
    delete require.cache[require.resolve("./exotimerClient")];
  }
});
