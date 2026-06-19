const axios = require("axios");
const config = require("../config");
const { normalizeDorsal, normalizeDorsalReferences } = require("../utils/dorsal");

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
  EXOTIMER_GET_INSCRIPTION_BY_REFERENCE_OR_DOCUMENT: {
    roles: ["ORGANIZER", "ATHLETE", "TIMER"],
    risk: SAFE_READ,
    description: "Busca una inscripcion por id/referencia, DNI, correo, telefono o nombre.",
  },
  EXOTIMER_VALIDATE_PAYMENT_EVIDENCE: {
    roles: ["ORGANIZER", "ATHLETE", "TIMER"],
    risk: SAFE_READ,
    description: "Valida si la evidencia de pago coincide con una inscripcion encontrada.",
  },
  EXOTIMER_UPDATE_INSCRIPTION_EMAIL: {
    roles: ["ORGANIZER", "ATHLETE", "TIMER"],
    risk: SAFE_WRITE,
    description: "Corrige el correo de una inscripcion encontrada y conserva el resto del documento.",
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
  EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION: {
    roles: ["ATHLETE", "TIMER"],
    risk: SAFE_WRITE,
    description:
      "Crea una lectura raw manual de META desde evidencia contundente y la asigna al resultado del atleta.",
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

function buildAudit({ method = "GET", path, payload, params, response }) {
  return {
    request: {
      method,
      endpoint: path,
      ...(params ? { params } : {}),
      ...(payload !== undefined ? { payload } : {}),
    },
    response,
  };
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

  const request = {
    method: "POST",
    path: "/api/competition/event/create/",
    data: { competition: competitionId, form },
  };
  const saved = await apiRequest(request);

  return {
    ...buildAudit({ method: request.method, path: request.path, payload: request.data, response: saved }),
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
  const normalizedInput = normalizeDorsalReferences(input);
  const request = {
    path: "/api/inscription/detail-verify/",
    params: {
      competition: pickCompetitionId(normalizedInput),
      dorsal: normalizedInput.dorsal || normalizedInput.bib,
    },
  };
  const response = await apiRequest(request);
  return {
    ...buildAudit({ path: request.path, params: request.params, response }),
    data: response,
  };
}

function normalizeLoose(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}

function normalizeDigits(value) {
  return String(value ?? "").replace(/\D+/g, "");
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function pickInscriptionDocument(inscription = {}) {
  return inscription.document && typeof inscription.document === "object" ? inscription.document : {};
}

function pickParticipant(inscription = {}) {
  return inscription.participant && typeof inscription.participant === "object" ? inscription.participant : {};
}

function inscriptionFullName(inscription = {}) {
  const document = pickInscriptionDocument(inscription);
  const participant = pickParticipant(inscription);
  return [
    document.nombre || document.name || participant.name,
    document.apellidos || document.lastname || document.lastname_mother || participant.lastname,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function requestedInscriptionReference(input = {}) {
  return clean(
    input.inscriptionId ||
      input.inscription_id ||
      input.inscriptionReference ||
      input.reference ||
      input.codigoInscripcion ||
      input.codigo ||
      input.pk
  );
}

function buildInscriptionSearchTerms(input = {}) {
  return {
    reference: requestedInscriptionReference(input),
    document: clean(input.document || input.dni || input.identityDocument),
    email: clean(input.email || input.expectedEmail || input.correctEmail || input.requestedEmail),
    phone: clean(input.phone || input.telefono || input.celular),
    name: clean(input.participantName || input.athleteName || input.name),
  };
}

function scoreInscription(inscription, terms) {
  let score = 0;
  const reasons = [];
  const document = pickInscriptionDocument(inscription);
  const participant = pickParticipant(inscription);

  if (terms.reference) {
    const wanted = normalizeDigits(terms.reference);
    const candidates = [
      inscription.id,
      inscription.pk,
      document.id,
      document.ID,
      document.codigo,
      document.reference,
      document.inscriptionReference,
      document["Codigo/Referencia de inscripcion"],
    ].map(normalizeDigits);
    if (wanted && candidates.includes(wanted)) {
      score += 120;
      reasons.push("reference");
    }
  }

  if (terms.document) {
    const wanted = normalizeDigits(terms.document);
    const current = normalizeDigits(document.dni || document.document || participant.dni);
    if (wanted && current && wanted === current) {
      score += 100;
      reasons.push("document");
    }
  }

  if (terms.email) {
    const wanted = normalizeEmail(terms.email);
    const current = normalizeEmail(document.email || participant.email);
    if (wanted && current && wanted === current) {
      score += 80;
      reasons.push("email");
    }
  }

  if (terms.phone) {
    const wanted = normalizeDigits(terms.phone);
    const current = normalizeDigits(document.phone || document.telefono || document.celular || participant.phone);
    if (wanted && current && (wanted === current || wanted.endsWith(current) || current.endsWith(wanted))) {
      score += 70;
      reasons.push("phone");
    }
  }

  if (terms.name) {
    const wanted = normalizeLoose(terms.name);
    const current = normalizeLoose(inscriptionFullName(inscription));
    if (wanted.length >= 4 && current && (current.includes(wanted) || wanted.includes(current))) {
      score += 45;
      reasons.push("name");
    }
  }

  return { score, reasons };
}

function summarizeInscription(inscription = {}, terms = {}) {
  const document = pickInscriptionDocument(inscription);
  const participant = pickParticipant(inscription);
  const email = clean(document.email || participant.email);
  const expectedEmail = clean(terms.email);
  return {
    id: inscription.id || inscription.pk || null,
    participantId: participant.id || null,
    name: inscriptionFullName(inscription) || null,
    dni: clean(document.dni || document.document || participant.dni) || null,
    email: email || null,
    phone: clean(document.phone || document.telefono || document.celular || participant.phone) || null,
    distance: clean(document.distancia || document.distance) || null,
    category: clean(document.categoria || document.category) || null,
    gender: clean(document.genero || document.gender || participant.genre) || null,
    dorsal: clean(document.dorsal || document._dorsal || document.bib) || null,
    amount: clean(document.precio_inscripcion || document.amount || inscription.amount) || null,
    voucher: inscription.voucher || null,
    voucherState: inscription.state_voucher ?? null,
    coupon: inscription.cupon_usado || null,
    emailMatchesExpected: expectedEmail && email ? normalizeEmail(expectedEmail) === normalizeEmail(email) : null,
    documentData: { ...document },
  };
}

async function getInscriptionByReferenceOrDocument(input = {}) {
  const competitionId = pickCompetitionId(input);
  const terms = buildInscriptionSearchTerms(input);
  if (!Object.values(terms).some(Boolean)) {
    throw new Error("Falta referencia, DNI, correo, telefono o nombre para buscar la inscripcion.");
  }

  const request = { path: `/api/inscription/list/${competitionId}/` };
  const response = await apiRequest(request);
  const rows = asArray(response);
  const scored = rows
    .map((row) => ({ row, ...scoreInscription(row, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0] || null;
  const second = scored[1] || null;
  const ambiguous = Boolean(best && second && best.score === second.score);
  const found = Boolean(best && !ambiguous);

  return {
    ...buildAudit({ path: request.path, response: { count: rows.length, matched: scored.length } }),
    found,
    ambiguous,
    competitionId: Number(competitionId),
    search: terms,
    bestMatch: found ? summarizeInscription(best.row, terms) : null,
    candidates: scored.slice(0, 5).map((item) => ({
      score: item.score,
      reasons: item.reasons,
      inscription: summarizeInscription(item.row, terms),
    })),
  };
}

function pickPaymentEvidence(input = {}) {
  const evidence = input.paymentEvidence && typeof input.paymentEvidence === "object" ? input.paymentEvidence : {};
  return {
    amount: clean(input.paymentAmount || input.amount || evidence.amount),
    operationNumber: clean(input.operationNumber || evidence.operationNumber),
    date: clean(input.paymentDate || evidence.date),
    time: clean(input.paymentTime || evidence.time),
    type: clean(input.paymentType || evidence.type),
    confidence: Number(input.evidenceConfidence ?? evidence.confidence ?? 0),
    summary: clean(input.evidenceSummary || evidence.evidenceSummary || evidence.summary),
    hasStrongEvidence:
      input.hasStrongEvidence === true || evidence.hasStrongEvidence === true || Number(evidence.confidence) >= 0.85,
  };
}

async function validatePaymentEvidence(input = {}) {
  const lookup = await getInscriptionByReferenceOrDocument(input);
  const evidence = pickPaymentEvidence(input);
  const match = lookup.bestMatch;
  const expectedRaw = String(match?.amount || "").replace(/[^\d.]+/g, "");
  const paidRaw = String(evidence.amount || "").replace(/[^\d.]+/g, "");
  const expectedAmount = expectedRaw ? Number(expectedRaw) : null;
  const paidAmount = paidRaw ? Number(paidRaw) : null;
  const amountMatches =
    Number.isFinite(expectedAmount) && expectedAmount > 0 && Number.isFinite(paidAmount) && paidAmount > 0
      ? Math.abs(expectedAmount - paidAmount) < 0.01
      : null;
  const paymentLooksValid = Boolean(
    lookup.found && evidence.hasStrongEvidence && evidence.amount && (amountMatches === true || amountMatches === null)
  );

  return {
    found: lookup.found,
    ambiguous: lookup.ambiguous,
    competitionId: lookup.competitionId,
    inscription: match,
    evidence,
    validation: {
      paymentLooksValid,
      amountMatches,
      expectedAmount: Number.isFinite(expectedAmount) ? expectedAmount : null,
      paidAmount: Number.isFinite(paidAmount) ? paidAmount : null,
      emailMatchesExpected: match?.emailMatchesExpected ?? null,
      currentVoucherState: match?.voucherState ?? null,
      requiresHumanForPaymentApproval: true,
      reason: !lookup.found
        ? "inscription_not_found"
        : !evidence.hasStrongEvidence
          ? "weak_or_missing_payment_evidence"
          : amountMatches === false
            ? "amount_mismatch"
            : "payment_evidence_matches_inscription_but_payment_approval_is_human",
    },
    lookup,
  };
}

async function updateInscriptionEmail(input = {}) {
  const lookup = await getInscriptionByReferenceOrDocument(input);
  if (!lookup.found || !lookup.bestMatch) {
    throw new Error(lookup.ambiguous ? "La busqueda de inscripcion es ambigua." : "No se encontro la inscripcion.");
  }

  const nextEmail = clean(input.newEmail || input.correctEmail || input.requestedEmail || input.email);
  if (!nextEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
    throw new Error("Falta un correo valido para actualizar.");
  }

  const document = {
    ...(lookup.bestMatch.documentData || {}),
    email: nextEmail,
  };
  const request = {
    method: "POST",
    path: "/api/inscription/update-admin/",
    data: {
      competition_id: String(lookup.competitionId),
      pk: String(lookup.bestMatch.id),
      document,
    },
  };
  const response = await apiRequest(request);
  return {
    ...buildAudit({ method: request.method, path: request.path, payload: request.data, response }),
    changed: {
      competitionId: lookup.competitionId,
      inscriptionId: lookup.bestMatch.id,
      beforeEmail: lookup.bestMatch.email,
      afterEmail: nextEmail,
    },
    saved: response,
  };
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
  return normalizeDorsal(input.currentDorsal || input.oldDorsal || input.previousDorsal || input.dorsal || input.bib);
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

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function cleanList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  if (!text) return [];
  if (text.includes(",")) return text.split(",").map(clean).filter(Boolean);
  if (text.includes(" / ")) return text.split(/\s+\/\s+/).map(clean).filter(Boolean);
  if (/\s+y\s+/i.test(text)) return text.split(/\s+y\s+/i).map(clean).filter(Boolean);
  return [text];
}

function deriveLastnameFromFullName(value) {
  const text = clean(value);
  if (!text || text.includes("@")) return undefined;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return undefined;
  if (tokens.length === 2) return tokens[1];
  return tokens.slice(-2).join(" ");
}

function deriveLastnameValue(value) {
  const names = cleanList(value);
  if (!names.length) return undefined;
  const derived = names.map(deriveLastnameFromFullName).filter(Boolean);
  return derived.length === names.length ? derived.join(",") : undefined;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseHms(value) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return { hours, minutes, seconds };
}

function parseDurationSeconds(value) {
  const match = String(value || "").trim().match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  if (match[3] === undefined) return Number(match[1]) * 60 + Number(match[2]);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(remainingSeconds)}`;
}

function parseDateParts(value) {
  const raw = String(value || "").trim();
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };

  match = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) return { day: Number(match[1]), month: Number(match[2]), year: Number(match[3]) };

  return null;
}

function parseLocalDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:([+-]\d{2}:\d{2})|Z)?/);
  if (iso) {
    return {
      date: { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) },
      time: { hours: Number(iso[4]), minutes: Number(iso[5]), seconds: Number(iso[6] || 0) },
      offset: iso[7] || "-05:00",
    };
  }

  const local = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (local) {
    return {
      date: { day: Number(local[1]), month: Number(local[2]), year: Number(local[3]) },
      time: { hours: Number(local[4]), minutes: Number(local[5]), seconds: Number(local[6] || 0) },
      offset: "-05:00",
    };
  }

  return null;
}

function formatRawDateTime(parts) {
  return `${pad2(parts.date.day)}/${pad2(parts.date.month)}/${parts.date.year} ${pad2(parts.time.hours)}:${pad2(parts.time.minutes)}:${pad2(parts.time.seconds)}`;
}

function formatIsoLocal(parts) {
  return `${parts.date.year}-${pad2(parts.date.month)}-${pad2(parts.date.day)}T${pad2(parts.time.hours)}:${pad2(parts.time.minutes)}:${pad2(parts.time.seconds)}${parts.offset || "-05:00"}`;
}

function datePartsToUtcMs(parts) {
  const offset = parts.offset || "-05:00";
  return Date.parse(formatIsoLocal({ ...parts, offset }));
}

function pickEventStartDateTime(detail = {}, input = {}) {
  const salidaName = normalizeText(input.salida || input.outputName || input.startName || detail?.salida || detail?.outputName);
  const salidas = Array.isArray(detail?.event?.configs?.[0]?.salidas) ? detail.event.configs[0].salidas : [];
  const selectedSalida = salidas.find((salida) => {
    const name = normalizeText(salida?.data?.nombre || salida?.name || salida?.nombre);
    return salidaName && name === salidaName;
  }) || salidas[0];

  const salidaDate = selectedSalida?.data?.fecha || selectedSalida?.fecha;
  const parsedSalida = parseLocalDateTime(salidaDate);
  if (parsedSalida) return parsedSalida;

  const salidaRaw = asArray(detail?.raws_asigments).find((raw) => normalizeText(raw?.location) === "salida");
  const parsedRawSalida = parseLocalDateTime(salidaRaw?.hour || salidaRaw?.zulu);
  if (parsedRawSalida) return parsedRawSalida;

  return parseLocalDateTime(input.startDateTime || input.salidaDateTime);
}

function pickCompetitionDate(input = {}, detail = {}) {
  const explicit = parseDateParts(input.eventDate || input.date || input.competitionDate || input.evidenceDate || input.evidenceFinishDate);
  if (explicit) return explicit;

  const eventStart = pickEventStartDateTime(detail, input);
  if (eventStart?.date) return eventStart.date;

  const metaDate = parseLocalDateTime(detail?.hora_meta || detail?.metaHour);
  if (metaDate?.date) return metaDate.date;

  return null;
}

function buildEvidenceFinishDateTime(input = {}, detail = {}) {
  const explicit = parseLocalDateTime(
    input.evidenceFinishDateTime ||
      input.evidenceMetaDateTime ||
      input.horaMetaDateTime ||
      input.finishDateTime ||
      input.metaDateTime
  );
  if (explicit) return explicit;

  const time = parseHms(
    input.evidenceFinishTime ||
      input.evidenceMetaTime ||
      input.horaMeta ||
      input.metaTime ||
      input.finishTime ||
      input.rawTime
  );
  const date = pickCompetitionDate(input, detail);
  if (!date || !time) return null;
  return { date, time, offset: input.timezoneOffset || "-05:00" };
}

function findRawByIdCandidate(value) {
  if (!value) return null;
  if (value.id) return value.id;
  if (value.raw_id) return value.raw_id;
  if (value.rawId) return value.rawId;
  if (value.raw) return findRawByIdCandidate(value.raw);
  if (value.data) return findRawByIdCandidate(value.data);
  if (value.result) return findRawByIdCandidate(value.result);
  if (value.response) return findRawByIdCandidate(value.response);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRawByIdCandidate(item);
      if (found) return found;
    }
  }
  return null;
}

async function findCreatedRawId({ resultId, rawHour, dorsal, competitionId }) {
  const detail = firstDetail(await getResultDetail({ resultId }));
  const rows = [...asArray(detail?.raws), ...asArray(detail?.raws_asigments)];
  const match = rows.find((raw) => {
    const rawDorsal = normalizeDorsal(raw?.dorsal || raw?.bib || raw?.chip);
    const sameDorsal = rawDorsal && String(rawDorsal) === String(dorsal);
    const sameLocation = normalizeText(raw?.location) === "meta";
    const sameCompetition = !raw?.competition || String(raw.competition) === String(competitionId);
    const parsedRaw = parseLocalDateTime(raw?.hour || raw?.zulu);
    const sameHour = parsedRaw && formatRawDateTime(parsedRaw) === rawHour;
    return sameDorsal && sameLocation && sameCompetition && sameHour;
  });
  return match?.id || match?.raw_id || match?.rawId || null;
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
    patch.dorsal = normalizeDorsal(requested);
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
  const explicitParticipantLastname = clean(
    input.participantLastname ?? input.lastnameNew ?? input.lastName ?? input.lastname ?? input.surname ?? patch.participantLastname
  );
  const existingParticipantLastname = clean(participant.lastname ?? detail?.participantLastname ?? detail?.lastname);
  const participantLastname =
    explicitParticipantLastname ??
    existingParticipantLastname ??
    deriveLastnameValue(participantName ?? patch.participantName ?? requestedValue(input) ?? participant.name ?? detail?.participantName);
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
    participantLastname,
    evento_distancia: eventName ?? event.name ?? detail?.evento_distancia ?? detail?.distance,
    genero: gender ?? category.genre ?? detail?.genero ?? detail?.gender,
    categoria: categoryName ?? category.name ?? detail?.categoria ?? detail?.category,
    salida: input.salida ?? input.outputName ?? input.startName ?? detail?.salida ?? detail?.outputName,
  };
}

async function updateResultParticipant(input, mode) {
  const normalizedInput = normalizeDorsalReferences(input);
  const { resultId, detail } = await resolveResultForUpdate(normalizedInput);
  const form = buildResultParticipantForm({ input: normalizedInput, resultId, detail, mode });

  const required = ["dorsal", "participantName", "participantLastname", "evento_distancia", "genero", "categoria"];
  const missing = required.filter((key) => isBlank(form[key]));
  if (missing.length) throw new Error(`Faltan datos del resultado para actualizar: ${missing.join(", ")}`);

  const request = {
    method: "POST",
    path: "/v2/results/update-participant/",
    data: form,
  };
  const saved = await apiRequest(request);

  return {
    ...buildAudit({ method: request.method, path: request.path, payload: request.data, response: saved }),
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
  const request = { path: `/v2/results/validate/${pickCompetitionId(input)}/` };
  const response = await apiRequest(request);
  return {
    ...buildAudit({ path: request.path, response }),
    data: response,
  };
}

async function getRaws(input) {
  const request = { path: `/v2/raws/${pickCompetitionId(input)}/list/` };
  const response = await apiRequest(request);
  return {
    ...buildAudit({ path: request.path, response }),
    data: response,
  };
}

async function createManualRaw(input) {
  const normalizedInput = normalizeDorsalReferences(input);
  const competitionId = pickCompetitionId(normalizedInput);
  const dorsal = normalizedInput.dorsal || normalizedInput.bib;
  if (!dorsal) throw new Error("Falta dorsal.");
  if (!normalizedInput.hour) throw new Error("Falta hour en formato DD/MM/YYYY HH:mm:ss.");

  const request = {
    method: "POST",
    path: "/v2/raws/create/",
    data: {
      dorsal: String(dorsal),
      chip: String(normalizedInput.chip || dorsal),
      hour: normalizedInput.hour,
      zulu: normalizedInput.zulu || normalizedInput.hour,
      location: normalizedInput.location || "META",
      team_computer: normalizedInput.team_computer || `reader_${normalizedInput.location || "META"}_${competitionId}`,
      state: normalizedInput.state ?? false,
      competition: Number(competitionId),
    },
  };
  const response = await apiRequest(request);
  return {
    ...buildAudit({ method: request.method, path: request.path, payload: request.data, response }),
    ...response,
  };
}

async function updateStartTime(input) {
  const competitionId = pickCompetitionId(input);
  const time = input.time || input.startTime;
  if (!/^\d{2}:\d{2}:\d{2}$/.test(String(time || ""))) {
    throw new Error("La hora debe tener formato HH:mm:ss.");
  }

  const request = {
    method: "POST",
    path: "/v2/raws/config/update/",
    data: {
      time,
      name_output: input.name_output || input.outputName || input.salida || input.startName,
      event_name: input.event_name || input.eventName || input.distance,
      competition_id: competitionId,
    },
  };
  const response = await apiRequest(request);
  return {
    ...buildAudit({ method: request.method, path: request.path, payload: request.data, response }),
    data: response,
  };
}

async function editResultTime(input) {
  const required = ["timeDateCurrent", "timeCurrent", "result_id", "name_colum"];
  const missing = required.filter((key) => !input[key]);
  if (missing.length) throw new Error(`Faltan campos: ${missing.join(", ")}`);

  const request = {
    method: "POST",
    path: "/v2/results/edit-times/",
    data: {
      timeDateCurrent: input.timeDateCurrent,
      timeCurrent: input.timeCurrent,
      selectRaw: input.selectRaw,
      result_id: input.result_id,
      name_colum: input.name_colum,
    },
  };
  const response = await apiRequest(request);
  return {
    ...buildAudit({ method: request.method, path: request.path, payload: request.data, response }),
    ...response,
  };
}

function hasStrongTimeEvidence(input = {}) {
  if (input.hasStrongEvidence === true || input.evidenceStrength === "strong" || input.evidenceStrength === "contundente") {
    return true;
  }

  const confidence = Number(input.evidenceConfidence ?? input.confidence);
  if (Number.isFinite(confidence) && confidence >= 0.85) return true;

  const summary = normalizeText([input.evidenceSummary, input.evidence, input.message].filter(Boolean).join(" "));
  const hasObjectiveEvidence = /(imagen|foto|captura|garmin|strava|gps|meta|llegada|evidencia)/.test(summary);
  const hasTime = Boolean(
    input.evidenceFinishDateTime ||
      input.evidenceMetaDateTime ||
      input.evidenceFinishTime ||
      input.evidenceMetaTime ||
      input.horaMeta ||
      input.metaTime ||
      input.finishTime
  );
  return hasObjectiveEvidence && hasTime;
}

function pickOfficialSeconds(input = {}, detail = {}) {
  return (
    parseDurationSeconds(input.currentValue) ??
    parseDurationSeconds(input.currentOfficialTime) ??
    parseDurationSeconds(input.officialTime) ??
    parseDurationSeconds(detail?.tiempo_oficial) ??
    parseDurationSeconds(detail?.officialTime) ??
    parseDurationSeconds(detail?.document?.time_TOTAL)
  );
}

function pickRequestedSeconds(input = {}) {
  return (
    parseDurationSeconds(input.requestedValue) ??
    parseDurationSeconds(input.correctValue) ??
    parseDurationSeconds(input.newValue) ??
    parseDurationSeconds(input.evidenceElapsedTime) ??
    parseDurationSeconds(input.gpsElapsedTime)
  );
}

function buildTimeCorrectionCurrent({ input, detail, finishParts }) {
  const eventStart = pickEventStartDateTime(detail, input);
  if (eventStart) {
    const diffSeconds = Math.max(0, Math.round((datePartsToUtcMs(finishParts) - datePartsToUtcMs(eventStart)) / 1000));
    if (Number.isFinite(diffSeconds)) return formatDuration(diffSeconds);
  }

  const requestedSeconds = pickRequestedSeconds(input);
  if (requestedSeconds != null) return formatDuration(requestedSeconds);

  return input.timeCurrent || input.requestedValue || input.correctValue;
}

async function applyResultTimeEvidenceCorrection(input = {}) {
  const normalizedInput = normalizeDorsalReferences(input);
  const competitionId = pickCompetitionId(normalizedInput);
  const { resultId, detail } = await resolveResultForUpdate(normalizedInput);
  const dorsal = normalizeDorsal(
    normalizedInput.dorsal ||
      normalizedInput.bib ||
      normalizedInput.currentDorsal ||
      detail?.dorsal ||
      detail?.bib ||
      detail?.participant?.dorsal
  );
  if (!dorsal) throw new Error("Falta dorsal para crear el raw de evidencia.");

  const finishParts = buildEvidenceFinishDateTime(normalizedInput, detail);
  if (!finishParts) {
    throw new Error("Falta hora meta de evidencia en formato HH:mm:ss o fecha/hora completa.");
  }

  if (!hasStrongTimeEvidence(normalizedInput)) {
    throw new Error("La evidencia no esta marcada como contundente para corregir el tiempo automaticamente.");
  }

  const timeCurrent = buildTimeCorrectionCurrent({ input: normalizedInput, detail, finishParts });
  if (!timeCurrent) throw new Error("No se pudo calcular el tiempo para asignar la hora meta.");

  const officialSeconds = pickOfficialSeconds(normalizedInput, detail);
  const proposedSeconds = pickRequestedSeconds(normalizedInput) ?? parseDurationSeconds(timeCurrent);
  const minDifferenceSeconds = Number(normalizedInput.minDifferenceSeconds || 120);
  if (officialSeconds == null || proposedSeconds == null) {
    throw new Error("Falta el tiempo oficial o el tiempo propuesto para validar la diferencia.");
  }
  const differenceSeconds = Math.abs(officialSeconds - proposedSeconds);
  if (differenceSeconds < minDifferenceSeconds) {
    throw new Error(`La diferencia con el tiempo oficial es menor a ${minDifferenceSeconds} segundos.`);
  }

  const rawHour = formatRawDateTime(finishParts);
  const rawPayload = {
    competitionId,
    dorsal,
    chip: normalizeDorsal(normalizedInput.chip || detail?.chip || dorsal),
    hour: rawHour,
    zulu: rawHour,
    location: "META",
    team_computer: normalizedInput.team_computer || `reader_META_${competitionId}`,
    state: false,
  };
  const rawResponse = await createManualRaw(rawPayload);
  let rawId = findRawByIdCandidate(rawResponse);
  if (!rawId) {
    rawId = await findCreatedRawId({ resultId, rawHour, dorsal, competitionId });
  }
  if (!rawId) {
    throw new Error("Se creo el raw, pero no se pudo identificar su id para asignarlo al resultado.");
  }

  const editPayload = {
    timeDateCurrent: formatIsoLocal(finishParts),
    timeCurrent,
    selectRaw: rawId,
    result_id: resultId,
    name_colum: normalizedInput.name_colum || normalizedInput.nameColumn || "loc_Meta",
  };
  const editResponse = await editResultTime(editPayload);

  return {
    created: true,
    type: "RESULT_TIME_EVIDENCE_CORRECTION",
    changed: {
      competitionId,
      resultId,
      dorsal,
      beforeOfficial: detail?.tiempo_oficial || detail?.officialTime || null,
      evidenceFinishDateTime: formatIsoLocal(finishParts),
      evidenceRawHour: rawHour,
      createdRawId: rawId,
      assignedColumn: editPayload.name_colum,
      computedTimeCurrent: timeCurrent,
    },
    raw: {
      endpoint: "/v2/raws/create/",
      payload: rawPayload,
      response: rawResponse,
    },
    edit: {
      endpoint: "/v2/results/edit-times/",
      payload: editPayload,
      response: editResponse,
    },
  };
}

async function getConnectedReaders() {
  return apiRequest({ path: "/v2/computers/list/active-channels/" });
}

function createResultCorrectionCase(input) {
  const normalizedInput = normalizeDorsalReferences(input);
  return {
    created: true,
    type: "RESULT_CORRECTION_CASE",
    requiredReview: true,
    details: {
      competitionId: normalizedInput.competitionId || normalizedInput.competition_id || null,
      competitionName: normalizedInput.competitionName || null,
      dorsal: normalizedInput.dorsal || normalizedInput.bib || null,
      athleteName: normalizedInput.athleteName || normalizedInput.name || null,
      requestedCorrection: normalizedInput.requestedCorrection || normalizedInput.message || null,
      evidence: normalizedInput.evidence || null,
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
  EXOTIMER_GET_INSCRIPTION_BY_REFERENCE_OR_DOCUMENT: getInscriptionByReferenceOrDocument,
  EXOTIMER_VALIDATE_PAYMENT_EVIDENCE: validatePaymentEvidence,
  EXOTIMER_UPDATE_INSCRIPTION_EMAIL: updateInscriptionEmail,
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
  EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION: applyResultTimeEvidenceCorrection,
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
  return handler(normalizeDorsalReferences(input));
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
