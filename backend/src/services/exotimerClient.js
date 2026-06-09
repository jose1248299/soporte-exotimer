const axios = require("axios");
const config = require("../config");

const SAFE_READ = "safe_read";
const SAFE_WRITE = "safe_write";
const NEEDS_CONFIRMATION = "needs_confirmation";

const ACTIONS = {
  EXOTIMER_LIST_COMPETITIONS: {
    roles: ["TIMER", "ORGANIZER", "ATHLETE", "BUYER"],
    risk: SAFE_READ,
    description: "Lista competencias disponibles.",
  },
  EXOTIMER_FIND_COMPETITION: {
    roles: ["TIMER", "ORGANIZER", "ATHLETE", "BUYER"],
    risk: SAFE_READ,
    description: "Busca una competencia por nombre o id.",
  },
  EXOTIMER_GET_COMPETITION_EVENTS: {
    roles: ["TIMER", "ORGANIZER"],
    risk: SAFE_READ,
    description: "Consulta eventos, distancias, salidas, categorias, puntos y tickets.",
  },
  EXOTIMER_GET_TICKETS: {
    roles: ["ORGANIZER", "ATHLETE", "BUYER"],
    risk: SAFE_READ,
    description: "Consulta tickets de una competencia.",
  },
  EXOTIMER_UPDATE_EVENT_TICKET: {
    roles: ["ORGANIZER"],
    risk: NEEDS_CONFIRMATION,
    description: "Actualiza titulo, precio, moneda o fechas de un ticket.",
  },
  EXOTIMER_GET_INSCRIPTION: {
    roles: ["ORGANIZER", "ATHLETE"],
    risk: SAFE_READ,
    description: "Verifica una inscripcion por competencia y dorsal.",
  },
  EXOTIMER_GET_RESULTS: {
    roles: ["TIMER", "ATHLETE"],
    risk: SAFE_READ,
    description: "Consulta resultados de una competencia.",
  },
  EXOTIMER_GET_RESULT_DETAIL: {
    roles: ["TIMER", "ATHLETE"],
    risk: SAFE_READ,
    description: "Consulta detalle de uno o varios resultados.",
  },
  EXOTIMER_CREATE_RESULT_CORRECTION_CASE: {
    roles: ["ATHLETE"],
    risk: SAFE_WRITE,
    description: "Registra una solicitud de correccion para revision humana.",
  },
  EXOTIMER_UPDATE_RESULT_PARTICIPANT_DATA: {
    roles: ["ATHLETE", "TIMER"],
    risk: SAFE_WRITE,
    description: "Actualiza datos personales del participante en un resultado.",
  },
  EXOTIMER_UPDATE_RESULT_DORSAL: {
    roles: ["ATHLETE", "TIMER"],
    risk: SAFE_WRITE,
    description: "Actualiza el numero de dorsal de un participante en un resultado.",
  },
  EXOTIMER_UPDATE_RESULT_EVENT_CATEGORY: {
    roles: ["ATHLETE", "TIMER"],
    risk: SAFE_WRITE,
    description: "Actualiza distancia, genero y/o categoria de un resultado.",
  },
  EXOTIMER_VALIDATE_PRE_RACE: {
    roles: ["TIMER"],
    risk: SAFE_READ,
    description: "Ejecuta validacion pre-carrera de chips, dorsales y generos.",
  },
  EXOTIMER_GET_RAWS: {
    roles: ["TIMER"],
    risk: SAFE_READ,
    description: "Consulta lecturas raw de una competencia.",
  },
  EXOTIMER_CREATE_MANUAL_RAW: {
    roles: ["TIMER"],
    risk: NEEDS_CONFIRMATION,
    description: "Crea una lectura raw manual.",
  },
  EXOTIMER_UPDATE_START_TIME: {
    roles: ["TIMER"],
    risk: NEEDS_CONFIRMATION,
    description: "Actualiza la hora de salida usada para calculos.",
  },
  EXOTIMER_EDIT_RESULT_TIME: {
    roles: ["TIMER"],
    risk: NEEDS_CONFIRMATION,
    description: "Edita el tiempo de un resultado en un punto de control.",
  },
  EXOTIMER_GET_CONNECTED_READERS: {
    roles: ["TIMER"],
    risk: SAFE_READ,
    description: "Consulta readers/canales activos.",
  },
  BUYER_CREATE_PRICE_INQUIRY: {
    roles: ["BUYER"],
    risk: SAFE_WRITE,
    description: "Registra una consulta comercial para seguimiento de ventas.",
  },
};

let cachedAccessToken = config.exotimer.token || null;

function assertClientConfig() {
  if (!config.exotimer.baseUrl) {
    throw new Error("Falta configurar EXOTIMER_API_BASE_URL");
  }
}

async function loginExotimer() {
  if (!config.exotimer.user || !config.exotimer.password) {
    if (cachedAccessToken) return cachedAccessToken;
    throw new Error("Falta configurar EXOTIMER_API_TOKEN o EXOTIMER_API_USER/EXOTIMER_API_PASSWORD");
  }

  const { data } = await axios.post(
    `${config.exotimer.baseUrl}/api/token/`,
    {
      user_firebase: config.exotimer.user,
      password: config.exotimer.password,
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    }
  );

  const token = data?.access || data?.token || data?.jwt;
  if (!token) throw new Error("Exotimer no devolvio access token.");
  cachedAccessToken = token;
  return cachedAccessToken;
}

async function getAccessToken() {
  if (cachedAccessToken) return cachedAccessToken;
  return loginExotimer();
}

function canExecuteAction(userType, actionName) {
  const action = ACTIONS[actionName];
  return Boolean(action && action.roles.includes(userType));
}

function getActionRisk(actionName) {
  return ACTIONS[actionName]?.risk || NEEDS_CONFIRMATION;
}

function requiresConfirmation(actionName) {
  return getActionRisk(actionName) === NEEDS_CONFIRMATION;
}

function assertCanExecute(userType, actionName) {
  if (!ACTIONS[actionName]) throw new Error(`Accion no soportada: ${actionName}`);
  if (!canExecuteAction(userType, actionName)) {
    throw new Error(`El usuario ${userType} no tiene permiso para ejecutar ${actionName}`);
  }
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 2);
}

function competitionScore(competition, query) {
  const name = normalizeText(competition.name);
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 0;
  if (name.includes(normalizedQuery)) return 100;

  const queryTokens = tokenize(query);
  const nameTokens = new Set(tokenize(competition.name));
  if (!queryTokens.length) return 0;

  const matched = queryTokens.filter((token) => nameTokens.has(token)).length;
  const coverage = matched / queryTokens.length;
  return coverage >= 0.6 ? Math.round(coverage * 90) : 0;
}

function pickCompetitionId(input) {
  const id = input.competitionId || input.competition_id || input.competition;
  if (!id) throw new Error("Falta competitionId.");
  return String(id);
}

function makeLocalId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

async function apiRequest({ method = "GET", path, data, params, headers, retryOnAuth = true }) {
  assertClientConfig();
  const token = await getAccessToken();

  try {
    const { data: responseData } = await axios.request({
      baseURL: config.exotimer.baseUrl,
      url: path,
      method,
      data,
      params,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(headers || {}),
      },
      timeout: 20000,
    });

    return responseData;
  } catch (error) {
    if (retryOnAuth && error.response?.status === 401) {
      cachedAccessToken = null;
      await loginExotimer();
      return apiRequest({ method, path, data, params, headers, retryOnAuth: false });
    }

    throw error;
  }
}

async function listCompetitions() {
  return apiRequest({ path: "/v2/competitions/list/" });
}

function flattenCompetitions(data) {
  if (Array.isArray(data)) return data;
  return [
    ...(Array.isArray(data?.future_competitions) ? data.future_competitions : []),
    ...(Array.isArray(data?.past_competitions) ? data.past_competitions : []),
    ...(Array.isArray(data?.all_competitions) ? data.all_competitions : []),
  ].filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
}

async function findCompetition(input) {
  const query = normalizeText(input.competitionName || input.name || input.query);
  const rawQuery = input.competitionName || input.name || input.query;
  const wantedId = input.competitionId || input.competition_id;
  const data = await listCompetitions();
  const competitions = flattenCompetitions(data);

  if (wantedId) {
    const foundById = competitions.find((item) => String(item.id) === String(wantedId));
    if (foundById) return { match: foundById, candidates: [foundById] };
  }

  if (!query) return { match: null, candidates: competitions.slice(0, 10) };

  const candidates = competitions
    .map((item) => ({ item, score: competitionScore(item, rawQuery || query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, matchScore: score }));
  const [best, second] = candidates;
  const ambiguous = Boolean(best && second && best.matchScore === second.matchScore);
  return { match: ambiguous ? null : best || null, candidates: candidates.slice(0, 10), ambiguous };
}

async function getCompetitionEvents(input) {
  const competitionId = pickCompetitionId(input);
  return apiRequest({ path: `/v2/competitions/events/${competitionId}/` });
}

async function getTickets(input) {
  const competitionId = pickCompetitionId(input);
  return apiRequest({ path: `/api/inscription/ticket/list/${competitionId}/` });
}

function toEventFormData(event) {
  return {
    ...event,
    id: event.id,
    sharedStateProps: {
      child1Forms: event.configs?.locations || [],
      child2Forms: event.configs?.sections || [],
      child3Forms: event.configs?.salidas || [],
      child4Forms: Array.isArray(event.category_details)
        ? event.category_details.map((category) => ({ id: String(makeLocalId()), data: category }))
        : [],
    },
    eventFormProps: {
      nombre: event.name,
      cam_details: event.cam_details,
      tickets: event.tickets || [],
    },
  };
}

function matchByIdOrName(list, id, name, label) {
  if (id != null) {
    const byId = list.find((item) => String(item.id) === String(id));
    if (byId) return byId;
  }

  const normalized = normalizeText(name);
  if (normalized) {
    const byName = list.find((item) => normalizeText(item.name || item.title || item.eventFormProps?.nombre).includes(normalized));
    if (byName) return byName;
  }

  throw new Error(`No se encontro ${label}.`);
}

function applyTicketPatch(ticket, input) {
  const patch = {};
  if (input.title != null || input.ticketTitleNew != null) patch.title = String(input.title ?? input.ticketTitleNew);
  if (input.amount != null || input.price != null) patch.amount = String(input.amount ?? input.price);
  if (input.currency != null) patch.currency = String(input.currency).toUpperCase();
  if (input.startDate != null) patch.startDate = String(input.startDate);
  if (input.endDate != null || input.dateExpired != null) patch.endDate = String(input.endDate ?? input.dateExpired);

  if (Object.keys(patch).length === 0) {
    throw new Error("No hay cambios de ticket para aplicar.");
  }

  if (patch.amount != null && Number(patch.amount) < 0) {
    throw new Error("El precio del ticket no puede ser negativo.");
  }

  const next = { ...ticket, ...patch };
  if (next.startDate && next.endDate && new Date(next.endDate) < new Date(next.startDate)) {
    throw new Error("La fecha de expiracion no puede ser menor que la fecha de inicio.");
  }

  return { next, patch };
}

async function updateEventTicket(input) {
  const competitionId = pickCompetitionId(input);
  const events = await getCompetitionEvents({ competitionId });
  const event = matchByIdOrName(events, input.eventId, input.eventName || input.distance, "evento/distancia");
  const tickets = event.tickets || [];
  const ticket = matchByIdOrName(tickets, input.ticketId, input.ticketTitle || input.ticketName, "ticket");
  const { next, patch } = applyTicketPatch(ticket, input);

  const form = events.map((item) => {
    const eventFormData = toEventFormData(item);
    if (String(item.id) !== String(event.id)) return eventFormData;

    return {
      ...eventFormData,
      eventFormProps: {
        ...eventFormData.eventFormProps,
        tickets: tickets.map((candidate) => (String(candidate.id) === String(ticket.id) ? next : candidate)),
      },
    };
  });

  const saved = await apiRequest({
    method: "POST",
    path: "/api/competition/event/create/",
    data: { competition: competitionId, form },
  });

  return {
    saved,
    changed: {
      competitionId,
      event: { id: event.id, name: event.name },
      ticketBefore: ticket,
      ticketAfter: next,
      patch,
    },
  };
}

async function getInscription(input) {
  return apiRequest({
    path: "/api/inscription/detail-verify/",
    params: {
      competition: pickCompetitionId(input),
      dorsal: input.dorsal || input.bib,
    },
  });
}

async function getResults(input) {
  return apiRequest({
    method: "POST",
    path: "/v2/results/list/",
    data: { competition_id: Number(pickCompetitionId(input)) },
  });
}

async function getResultDetail(input) {
  const ids = Array.isArray(input.resultIds) ? input.resultIds : [input.resultId || input.id].filter(Boolean);
  if (!ids.length) throw new Error("Falta resultId.");
  return apiRequest({ path: `/v2/results/detail/${ids.map(String).join(",")}/` });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.rows)) return value.rows;
  if (value?.results && typeof value.results === "object") return asArray(value.results);
  if (value?.data && typeof value.data === "object") return asArray(value.data);
  if (value && typeof value === "object") return [value];
  return [];
}

function firstDetail(value) {
  if (value?.result) return firstDetail(value.result);
  if (value?.detail) return firstDetail(value.detail);
  if (value?.data && typeof value.data === "object" && !Array.isArray(value.data)) return firstDetail(value.data);
  const rows = asArray(value);
  if (rows.length) return rows[0];
  return value;
}

function pickResultId(row) {
  return row?.id || row?.result_id || row?.resultId || row?.pk;
}

function pickLookupDorsal(input = {}) {
  return input.currentDorsal || input.oldDorsal || input.previousDorsal || input.dorsal || input.bib;
}

async function resolveResultForUpdate(input = {}) {
  const directId = input.resultId || input.result_id || input.id;
  if (directId) {
    const detail = firstDetail(await getResultDetail({ resultId: directId }));
    return { resultId: directId, detail };
  }

  const dorsal = pickLookupDorsal(input);
  if (!dorsal) throw new Error("Falta dorsal o resultId para ubicar el resultado.");

  const rows = asArray(await getResults(input));
  const matches = rows.filter((row) => {
    const rowDorsal = row?.dorsal ?? row?.bib ?? row?.participant?.dorsal;
    return String(rowDorsal) === String(dorsal);
  });

  if (!matches.length) throw new Error(`No se encontro resultado con dorsal ${dorsal}.`);
  if (matches.length > 1) throw new Error(`Se encontraron varios resultados con dorsal ${dorsal}.`);

  const resultId = pickResultId(matches[0]);
  if (!resultId) throw new Error("El resultado encontrado no incluye id.");

  const detail = firstDetail(await getResultDetail({ resultId }));
  return { resultId, detail };
}

function numberOrString(value) {
  if (value === undefined || value === null || value === "") return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : String(value);
}

function clean(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value).trim();
}

function requestedValue(input = {}) {
  return clean(
    input.requestedValue ??
      input.correctValue ??
      input.newValue ??
      input.valorCorrecto ??
      input.valor_solicitado ??
      input.value
  );
}

function targetIncludes(input = {}, words = []) {
  const target = normalizeText(
    [
      input.targetField,
      input.field,
      input.campo,
      input.caseType,
      input.tipoCaso,
      input.requestedCorrection,
      input.message,
    ]
      .filter(Boolean)
      .join(" ")
  );
  return words.some((word) => target.includes(normalizeText(word)));
}

function applyRequestedValueByMode(input = {}, patch = {}, mode) {
  const requested = requestedValue(input);
  if (!requested) return patch;

  if (mode === "dorsal" || targetIncludes(input, ["dorsal", "bib"])) {
    patch.dorsal = requested;
  }

  if (mode === "event_category") {
    if (targetIncludes(input, ["distancia", "evento"])) patch.evento_distancia = requested;
    if (targetIncludes(input, ["genero", "sexo"])) patch.genero = requested;
    if (targetIncludes(input, ["categoria"])) patch.categoria = requested;
  }

  if (mode === "participant_data") {
    if (targetIncludes(input, ["nombre"]) && !targetIncludes(input, ["apellido"])) patch.participantName = requested;
    if (targetIncludes(input, ["apellido"])) patch.participantLastname = requested;
  }

  return patch;
}

function buildResultParticipantForm({ input, resultId, detail, mode }) {
  const participant = detail?.participant || {};
  const event = detail?.event || {};
  const category = event?.category || detail?.category || {};
  const patch = applyRequestedValueByMode(input, {}, mode);

  const nextDorsal = input.newDorsal ?? input.dorsalNew ?? input.correctDorsal ?? patch.dorsal;
  const participantName = clean(input.participantName ?? input.athleteName ?? input.nameNew ?? input.firstName ?? patch.participantName);
  const participantLastname = clean(
    input.participantLastname ?? input.lastnameNew ?? input.lastName ?? input.lastname ?? input.surname ?? patch.participantLastname
  );
  const eventName = clean(input.newDistance ?? input.distanceNew ?? input.evento_distancia ?? input.distance ?? input.eventName ?? patch.evento_distancia);
  const gender = clean(input.newGender ?? input.genderNew ?? input.genero ?? input.gender ?? input.genre ?? patch.genero);
  const categoryName = clean(input.newCategory ?? input.categoryNew ?? input.categoria ?? input.category ?? input.categoryName ?? patch.categoria);

  return {
    result_id: resultId,
    selectedIds: [resultId],
    id_competicion: Number(pickCompetitionId(input)),
    dorsal: numberOrString(nextDorsal ?? detail?.dorsal ?? detail?.bib),
    chip: numberOrString(input.chip ?? detail?.chip ?? nextDorsal ?? detail?.dorsal ?? detail?.bib),
    participantName: participantName ?? participant.name ?? detail?.participantName ?? detail?.athleteName,
    participantLastname: participantLastname ?? participant.lastname ?? detail?.participantLastname ?? detail?.lastname,
    evento_distancia: eventName ?? event.name ?? detail?.evento_distancia ?? detail?.distance,
    genero: gender ?? category.genre ?? detail?.genero ?? detail?.gender,
    categoria: categoryName ?? category.name ?? detail?.categoria ?? detail?.category,
    salida: input.salida ?? input.outputName ?? input.startName ?? detail?.salida ?? detail?.outputName,
  };
}

async function updateResultParticipant(input, mode) {
  const { resultId, detail } = await resolveResultForUpdate(input);
  const form = buildResultParticipantForm({ input, resultId, detail, mode });

  const required = ["dorsal", "participantName", "participantLastname", "evento_distancia", "genero", "categoria"];
  const missing = required.filter((key) => form[key] === undefined || form[key] === null || form[key] === "");
  if (missing.length) throw new Error(`Faltan datos del resultado para actualizar: ${missing.join(", ")}`);

  const saved = await apiRequest({
    method: "POST",
    path: "/v2/results/update-participant/",
    data: form,
  });

  return {
    saved,
    changed: {
      competitionId: pickCompetitionId(input),
      resultId,
      mode,
      before: {
        dorsal: detail?.dorsal ?? detail?.bib,
        participantName: detail?.participant?.name ?? detail?.participantName ?? detail?.athleteName,
        participantLastname: detail?.participant?.lastname ?? detail?.participantLastname ?? detail?.lastname,
        evento_distancia: detail?.event?.name ?? detail?.evento_distancia ?? detail?.distance,
        genero: detail?.event?.category?.genre ?? detail?.genero ?? detail?.gender,
        categoria: detail?.event?.category?.name ?? detail?.categoria ?? detail?.category,
      },
      after: form,
    },
  };
}

async function updateResultParticipantData(input) {
  return updateResultParticipant(input, "participant_data");
}

async function updateResultDorsal(input) {
  return updateResultParticipant(input, "dorsal");
}

async function updateResultEventCategory(input) {
  return updateResultParticipant(input, "event_category");
}

async function validatePreRace(input) {
  return apiRequest({ path: `/v2/results/validate/${pickCompetitionId(input)}/` });
}

async function getRaws(input) {
  return apiRequest({ path: `/v2/raws/${pickCompetitionId(input)}/list/` });
}

async function createManualRaw(input) {
  const competitionId = pickCompetitionId(input);
  const dorsal = input.dorsal || input.bib;
  if (!dorsal) throw new Error("Falta dorsal.");
  if (!input.hour) throw new Error("Falta hour en formato DD/MM/YYYY HH:mm:ss.");

  return apiRequest({
    method: "POST",
    path: "/v2/raws/create/",
    data: {
      dorsal: String(dorsal),
      chip: String(input.chip || dorsal),
      hour: input.hour,
      zulu: input.zulu || input.hour,
      location: input.location || "META",
      team_computer: input.team_computer || `reader_${input.location || "META"}_${competitionId}`,
      state: input.state ?? false,
      competition: Number(competitionId),
    },
  });
}

async function updateStartTime(input) {
  const competitionId = pickCompetitionId(input);
  const time = input.time || input.startTime;
  if (!/^\d{2}:\d{2}:\d{2}$/.test(String(time || ""))) {
    throw new Error("La hora debe tener formato HH:mm:ss.");
  }

  return apiRequest({
    method: "POST",
    path: "/v2/raws/config/update/",
    data: {
      time,
      name_output: input.name_output || input.outputName || input.salida || input.startName,
      event_name: input.event_name || input.eventName || input.distance,
      competition_id: competitionId,
    },
  });
}

async function editResultTime(input) {
  const required = ["timeDateCurrent", "timeCurrent", "result_id", "name_colum"];
  const missing = required.filter((key) => !input[key]);
  if (missing.length) throw new Error(`Faltan campos: ${missing.join(", ")}`);

  return apiRequest({
    method: "POST",
    path: "/v2/results/edit-times/",
    data: {
      timeDateCurrent: input.timeDateCurrent,
      timeCurrent: input.timeCurrent,
      selectRaw: input.selectRaw,
      result_id: input.result_id,
      name_colum: input.name_colum,
    },
  });
}

async function getConnectedReaders() {
  return apiRequest({ path: "/v2/computers/list/active-channels/" });
}

function createResultCorrectionCase(input) {
  return {
    created: true,
    type: "RESULT_CORRECTION_CASE",
    requiredReview: true,
    details: {
      competitionId: input.competitionId || input.competition_id || null,
      competitionName: input.competitionName || null,
      dorsal: input.dorsal || input.bib || null,
      athleteName: input.athleteName || input.name || null,
      requestedCorrection: input.requestedCorrection || input.message || null,
      evidence: input.evidence || null,
    },
  };
}

function createBuyerInquiry(input) {
  return {
    created: true,
    type: "BUYER_PRICE_INQUIRY",
    requiredReview: true,
    details: {
      message: input.message || null,
      eventDate: input.eventDate || null,
      city: input.city || null,
      sport: input.sport || null,
      participants: input.participants || null,
    },
  };
}

const HANDLERS = {
  EXOTIMER_LIST_COMPETITIONS: listCompetitions,
  EXOTIMER_FIND_COMPETITION: findCompetition,
  EXOTIMER_GET_COMPETITION_EVENTS: getCompetitionEvents,
  EXOTIMER_GET_TICKETS: getTickets,
  EXOTIMER_UPDATE_EVENT_TICKET: updateEventTicket,
  EXOTIMER_GET_INSCRIPTION: getInscription,
  EXOTIMER_GET_RESULTS: getResults,
  EXOTIMER_GET_RESULT_DETAIL: getResultDetail,
  EXOTIMER_CREATE_RESULT_CORRECTION_CASE: createResultCorrectionCase,
  EXOTIMER_UPDATE_RESULT_PARTICIPANT_DATA: updateResultParticipantData,
  EXOTIMER_UPDATE_RESULT_DORSAL: updateResultDorsal,
  EXOTIMER_UPDATE_RESULT_EVENT_CATEGORY: updateResultEventCategory,
  EXOTIMER_VALIDATE_PRE_RACE: validatePreRace,
  EXOTIMER_GET_RAWS: getRaws,
  EXOTIMER_CREATE_MANUAL_RAW: createManualRaw,
  EXOTIMER_UPDATE_START_TIME: updateStartTime,
  EXOTIMER_EDIT_RESULT_TIME: editResultTime,
  EXOTIMER_GET_CONNECTED_READERS: getConnectedReaders,
  BUYER_CREATE_PRICE_INQUIRY: createBuyerInquiry,
};

async function executeAction(userType, actionName, input = {}, options = {}) {
  if (!options.allowByPolicy) {
    assertCanExecute(userType, actionName);
  } else if (!ACTIONS[actionName]) {
    throw new Error(`Accion no soportada: ${actionName}`);
  }
  const handler = HANDLERS[actionName];
  if (!handler) throw new Error(`No hay handler para ${actionName}`);
  return handler(input);
}

module.exports = {
  ACTIONS,
  SAFE_READ,
  SAFE_WRITE,
  NEEDS_CONFIRMATION,
  canExecuteAction,
  executeAction,
  getActionRisk,
  requiresConfirmation,
  loginExotimer,
};
