const config = require("../config");
const prisma = require("../lib/prisma");
const { normalizeDorsal, normalizeDorsalReferences } = require("../utils/dorsal");
const { apiMultipartRequest, apiRequest, loginRaceline } = require("./racelineClient");
const { sendDocumentMessage } = require("./waba");

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
  EXOTIMER_UPDATE_INSCRIPTION_EVENT_CATEGORY: {
    roles: ["ORGANIZER", "ATHLETE", "TIMER"],
    risk: SAFE_WRITE,
    description: "Corrige distancia, genero o categoria de una inscripcion encontrada y conserva el resto del documento.",
  },
  EXOTIMER_RESEND_INSCRIPTION_CONFIRMATION: {
    roles: ["ORGANIZER", "ATHLETE", "TIMER"],
    risk: SAFE_READ,
    description: "Consulta la confirmacion existente y prepara la alternativa de entrega por WhatsApp.",
  },
  EXOTIMER_SEND_INSCRIPTION_CONFIRMATION_WHATSAPP: {
    roles: ["ORGANIZER", "ATHLETE", "TIMER"],
    risk: SAFE_WRITE,
    description: "Envia por WhatsApp el QR/comprobante de confirmacion de una inscripcion existente.",
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
  EXOTIMER_CREATE_COMPETITION_FROM_BASES: {
    roles: ["TIMER"],
    risk: NEEDS_CONFIRMATION,
    description:
      "Crea una competencia desde bases, afiche o datos estructurados, y opcionalmente configura distancias y salidas.",
  },
  EXOTIMER_CREATE_COMPETITION_FROM_CHAT: {
    roles: ["TIMER"],
    risk: NEEDS_CONFIRMATION,
    description:
      "Crea una competencia desde datos escritos en la conversacion, y opcionalmente configura distancias y salidas.",
  },
  BUYER_CREATE_PRICE_INQUIRY: {
    roles: ["BUYER"],
    risk: SAFE_WRITE,
    description: "Registra una consulta comercial para seguimiento de ventas.",
  },
};

const loginExotimer = loginRaceline;

function canExecuteAction(userType, actionName) {
  const action = ACTIONS[actionName];
  if (action && userType === "SYSTEM_USER") return true;
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

function optionScore(option, query) {
  const normalizedOption = normalizeText(option);
  const normalizedQuery = normalizeText(query);
  if (!normalizedOption || !normalizedQuery) return 0;
  if (normalizedOption === normalizedQuery) return 100;
  if (normalizedOption.includes(normalizedQuery) || normalizedQuery.includes(normalizedOption)) return 85;
  const compactOption = normalizedOption.replace(/[^a-z0-9]+/g, "");
  const compactQuery = normalizedQuery.replace(/[^a-z0-9]+/g, "");
  if (compactOption && compactQuery && (compactOption === compactQuery)) return 100;
  if (
    compactOption.length >= 3 &&
    compactQuery.length >= 3 &&
    (compactOption.startsWith(compactQuery) || compactQuery.startsWith(compactOption))
  ) {
    return 82;
  }

  const queryTokens = tokenize(query);
  const optionTokens = new Set(tokenize(option));
  if (!queryTokens.length) return 0;

  const matched = queryTokens.filter((token) => optionTokens.has(token)).length;
  return Math.round((matched / queryTokens.length) * 80);
}

function resolveOption(options, query, label, { minScore = 55 } = {}) {
  const cleanQuery = clean(query);
  if (!cleanQuery) return { value: null, score: 0, query: cleanQuery };
  const candidates = [...new Set(options.filter(Boolean).map(String))]
    .map((option) => ({ value: option, score: optionScore(option, cleanQuery) }))
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < minScore) {
    throw new Error(`No se encontro una opcion valida de ${label} para "${cleanQuery}".`);
  }
  const second = candidates[1];
  if (second && second.score === best.score && normalizeText(second.value) !== normalizeText(best.value)) {
    throw new Error(`La opcion de ${label} "${cleanQuery}" es ambigua.`);
  }
  return { ...best, query: cleanQuery };
}

function resolveGenderOption(query) {
  if (!clean(query)) return { value: null, score: 0, query: "" };
  const normalized = normalizeText(query);
  if (["f", "fem", "femenino", "female", "mujer", "damas"].includes(normalized)) {
    return { value: "Femenino", score: 100, query: clean(query) };
  }
  if (["m", "masc", "masculino", "male", "hombre", "varones"].includes(normalized)) {
    return { value: "Masculino", score: 100, query: clean(query) };
  }
  return resolveOption(["Femenino", "Masculino"], query, "genero", { minScore: 70 });
}

function isGenericCategoryRequest(value) {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  return (
    normalized.includes("correspondiente") ||
    normalized.includes("segun edad") ||
    normalized.includes("por edad") ||
    normalized.includes("categoria correcta") ||
    normalized.includes("categoria que corresponde")
  );
}

function normalizeCombinationEntries(combinations = {}) {
  const entries = [];
  const pushEntry = (distance, category, gender, raw) => {
    const categoryName = clean(category);
    if (!clean(distance) || !categoryName) return;
    entries.push({
      distance: clean(distance),
      category: categoryName,
      gender: clean(gender),
      raw,
    });
  };

  if (Array.isArray(combinations?.events)) {
    for (const event of combinations.events) {
      const categories = Array.isArray(event.categories) ? event.categories : [];
      for (const eventCategory of categories) {
        const category = eventCategory?.category || eventCategory;
        pushEntry(
          event.name,
          category?.name,
          category?.gender_rule || category?.gender || category?.genre,
          {
            event,
            eventId: event.id,
            eventCategoryId: eventCategory?.id || null,
            categoryId: category?.id || eventCategory?.category_id || null,
            category,
          }
        );
      }
    }
    return entries;
  }

  for (const [distance, value] of Object.entries(combinations || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          pushEntry(distance, item, null, item);
        } else if (item && typeof item === "object") {
          pushEntry(
            distance,
            item.name || item.nombre || item.category || item.categoria || item.title,
            item.genre || item.genero || item.gender || item.sex,
            item
          );
        }
      }
      continue;
    }

    if (value && typeof value === "object") {
      const nested = value.categories || value.categorias || value.category_details || value.items || value.options;
      if (Array.isArray(nested)) {
        for (const item of nested) {
          if (typeof item === "string") {
            pushEntry(distance, item, value.genre || value.genero || value.gender, item);
          } else if (item && typeof item === "object") {
            pushEntry(
              distance,
              item.name || item.nombre || item.category || item.categoria || item.title,
              item.genre || item.genero || item.gender || value.genre || value.genero || value.gender,
              item
            );
          }
        }
        continue;
      }

      for (const [maybeGender, categories] of Object.entries(value)) {
        if (!Array.isArray(categories)) continue;
        const gender = normalizeText(maybeGender).includes("fem")
          ? "Femenino"
          : normalizeText(maybeGender).includes("masc")
            ? "Masculino"
            : maybeGender;
        for (const category of categories) {
          if (typeof category === "string") {
            pushEntry(distance, category, gender, category);
          } else if (category && typeof category === "object") {
            pushEntry(
              distance,
              category.name || category.nombre || category.category || category.categoria || category.title,
              category.genre || category.genero || category.gender || gender,
              category
            );
          }
        }
      }
    }
  }

  return entries;
}

function parseCategoryAgeRange(categoryName) {
  const text = normalizeText(categoryName).replace(/\s+/g, " ");
  const range = text.match(/(\d{1,2})\s*(?:-|a|hasta)\s*(\d{1,2})/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (Number.isFinite(min) && Number.isFinite(max)) return { min: Math.min(min, max), max: Math.max(min, max) };
  }

  const plus = text.match(/(\d{1,2})\s*(?:\+|a mas|o mas|mas)/);
  if (plus) {
    const min = Number(plus[1]);
    if (Number.isFinite(min)) return { min, max: Infinity };
  }

  const under = text.match(/(?:hasta|menor(?:es)? de|sub)\s*(\d{1,2})/);
  if (under) {
    const max = Number(under[1]);
    if (Number.isFinite(max)) return { min: 0, max };
  }

  return null;
}

function resolveCategoryByAge(categoryOptions, age, gender, { distance, currentCategory } = {}) {
  const numericAge = Number(age);
  if (!Number.isFinite(numericAge) || numericAge <= 0) return null;
  const normalizedGender = normalizeText(gender);
  const matches = categoryOptions
    .filter((item) => {
      if (!item.gender || !normalizedGender) return true;
      return normalizeText(item.gender) === normalizedGender;
    })
    .map((item) => ({ ...item, range: parseCategoryAgeRange(item.category) }))
    .filter((item) => item.range && numericAge >= item.range.min && numericAge <= item.range.max);

  const unique = [...new Map(matches.map((item) => [normalizeText(`${item.category}|${item.gender || ""}`), item])).values()];
  if (unique.length === 1) {
    return { value: unique[0].category, score: 100, query: String(age), resolvedBy: "participantAge", gender: unique[0].gender || null };
  }
  if (unique.length > 1) {
    const distanceText = normalizeText(distance);
    const currentHasDistance = distanceText && normalizeText(currentCategory).includes(distanceText);
    const styleMatches = unique.filter((item) => {
      const categoryHasDistance = distanceText && normalizeText(item.category).includes(distanceText);
      return currentHasDistance ? categoryHasDistance : !categoryHasDistance;
    });
    if (styleMatches.length === 1) {
      return {
        value: styleMatches[0].category,
        score: 95,
        query: String(age),
        resolvedBy: "participantAgeAndCurrentCategoryStyle",
        gender: styleMatches[0].gender || null,
      };
    }
  }
  if (unique.length > 1) {
    throw new Error(`La edad ${numericAge} coincide con varias categorias posibles.`);
  }
  return null;
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

async function requestAllPages(path, params = {}, limit = 500) {
  const rows = [];
  for (let offset = 0; offset < 100000; offset += limit) {
    const page = asArray(await apiRequest({ path, params: { ...params, limit, offset } }));
    rows.push(...page);
    if (page.length < limit) break;
  }
  return rows;
}

function legacyCompetitionId(competition = {}) {
  const match = String(competition.slug || "").match(/-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function mapCompetition(competition = {}) {
  return {
    ...competition,
    date: competition.start_date?.slice?.(0, 10) || competition.date || null,
    end_date: competition.end_date?.slice?.(0, 10) || competition.end_date || null,
    banner: competition.banner_url || competition.banner || null,
    country: competition.country_id ?? competition.country ?? null,
    city: competition.city_id ?? competition.city ?? null,
    sport: competition.sport_id ?? competition.sport ?? null,
    legacyId: legacyCompetitionId(competition),
  };
}

let competitionCache = { expiresAt: 0, rows: [] };

async function listCompetitionRows({ force = false } = {}) {
  if (!force && competitionCache.expiresAt > Date.now()) return competitionCache.rows;

  const statuses = [null, "draft", "published", "finished", "cancelled"];
  const lists = await Promise.all(
    statuses.map((status) =>
      requestAllPages(
        "/catalog/api/v1/competitions/",
        status ? { status_filter: status } : {}
      ).catch(() => [])
    )
  );
  const byId = new Map();
  lists.flat().forEach((competition) => byId.set(String(competition.id), mapCompetition(competition)));
  competitionCache = { expiresAt: Date.now() + 60000, rows: [...byId.values()] };
  return competitionCache.rows;
}

async function listCompetitions() {
  const competitions = await listCompetitionRows();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const future_competitions = [];
  const past_competitions = [];

  competitions.forEach((competition) => {
    const date = competition.date ? new Date(`${competition.date}T00:00:00`) : null;
    (date && date < today ? past_competitions : future_competitions).push(competition);
  });

  return { future_competitions, past_competitions, all_competitions: competitions };
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

    const foundByLegacyId = competitions.find(
      (item) => String(item.legacyId ?? legacyCompetitionId(item)) === String(wantedId)
    );
    if (foundByLegacyId) {
      return {
        match: foundByLegacyId,
        candidates: [foundByLegacyId],
        resolvedFromLegacyId: true,
      };
    }
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

async function resolveCompetitionInput(input = {}) {
  if (input._competitionResolved) return input;
  const requestedCompetitionId = input.competitionId || input.competition_id || input.competition;
  const resolution = await findCompetition({
    competitionId: requestedCompetitionId,
    competitionName: input.competitionName || input.eventCompetitionName,
  });

  if (!resolution.match) {
    if (resolution.ambiguous) throw new Error("La competencia indicada es ambigua.");
    throw new Error(`No se encontro la competencia ${requestedCompetitionId || input.competitionName || "solicitada"}.`);
  }

  return {
    ...input,
    competitionId: resolution.match.id,
    competition_id: resolution.match.id,
    _competitionResolved: true,
    _requestedCompetitionId: requestedCompetitionId || null,
    _resolvedCompetition: resolution.match,
  };
}

async function getCompetitionEvents(input) {
  const resolvedInput = await resolveCompetitionInput(input);
  const competitionId = pickCompetitionId(resolvedInput);
  const [events, tickets] = await Promise.all([
    requestAllPages("/catalog/api/v1/events/", { competition_id: Number(competitionId) }),
    requestAllPages("/registration/api/v1/tickets/", { competition_id: Number(competitionId) }),
  ]);

  return events.map((event) => ({
    ...event,
    configs: event.extra_data?.admin_form?.configs || event.extra_data?.configs || null,
    category_details: event.category_details || event.extra_data?.admin_form?.category_details || [],
    tickets: tickets
      .filter((ticket) => {
        const eventIds = [
          ...(Array.isArray(ticket.event_ids) ? ticket.event_ids : []),
          ...(Array.isArray(ticket.event_bindings) ? ticket.event_bindings.map((item) => item.event_id) : []),
        ];
        return eventIds.length === 0 || eventIds.some((id) => String(id) === String(event.id));
      })
      .map(normalizeTicket),
  }));
}

async function getTickets(input) {
  const resolvedInput = await resolveCompetitionInput(input);
  const competitionId = pickCompetitionId(resolvedInput);
  const tickets = await requestAllPages("/registration/api/v1/tickets/", {
    competition_id: Number(competitionId),
  });
  return tickets.map(normalizeTicket);
}

function normalizeTicket(ticket = {}) {
  return {
    ...ticket,
    amount: ticket.price ?? ticket.amount,
    startDate: ticket.starts_at ?? ticket.startDate,
    endDate: ticket.ends_at ?? ticket.endDate,
  };
}

async function getCompetitionCatalogs() {
  const [countries, cities, sports, organizers] = await Promise.all([
    requestAllPages("/catalog/api/v1/countries"),
    requestAllPages("/catalog/api/v1/cities", {}, 500),
    requestAllPages("/catalog/api/v1/sports/"),
    requestAllPages("/identity/api/v1/organizations/"),
  ]);

  return {
    countries: Array.isArray(countries) ? countries : [],
    cities: Array.isArray(cities) ? cities : [],
    sports: Array.isArray(sports) ? sports : [],
    organizers: Array.isArray(organizers) ? organizers : [],
  };
}

function bestCatalogMatch(items, query, getLabel, label, { minScore = 55, fallback } = {}) {
  const cleanQuery = clean(query);
  if (!cleanQuery && fallback) return fallback();
  if (!cleanQuery) throw new Error(`Falta ${label}.`);

  const candidates = items
    .map((item) => ({ item, score: optionScore(getLabel(item), cleanQuery) }))
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < minScore) {
    if (fallback) return fallback();
    throw new Error(`No se encontro ${label} para "${cleanQuery}".`);
  }

  const second = candidates[1];
  if (second && second.score === best.score && normalizeText(getLabel(second.item)) !== normalizeText(getLabel(best.item))) {
    throw new Error(`${label} "${cleanQuery}" es ambiguo.`);
  }

  return best.item;
}

function parseCompetitionDate(value) {
  const text = clean(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return text;

  const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (numeric) {
    const [, dd, mm, yyyy] = numeric;
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  const months = {
    ene: "01",
    enero: "01",
    feb: "02",
    febrero: "02",
    mar: "03",
    marzo: "03",
    abr: "04",
    abril: "04",
    may: "05",
    mayo: "05",
    jun: "06",
    junio: "06",
    jul: "07",
    julio: "07",
    ago: "08",
    agosto: "08",
    sep: "09",
    set: "09",
    septiembre: "09",
    oct: "10",
    octubre: "10",
    nov: "11",
    noviembre: "11",
    dic: "12",
    diciembre: "12",
  };
  const named = normalizeText(text).match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  if (named && months[named[2]]) {
    return `${named[3]}-${months[named[2]]}-${String(named[1]).padStart(2, "0")}`;
  }

  throw new Error(`Fecha de competencia no reconocida: ${text}. Usa YYYY-MM-DD o DD/MM/YYYY.`);
}

function formatDateTimePayload(date, time = "08:00") {
  const [yyyy, mm, dd] = date.split("-");
  const parts = String(time || "08:00").match(/(\d{1,2}):?(\d{2})?/);
  const hh = parts ? String(parts[1]).padStart(2, "0") : "08";
  const min = parts && parts[2] ? String(parts[2]).padStart(2, "0") : "00";
  return `${dd}/${mm}/${yyyy}, ${hh}:${min}:00`;
}

function normalizeDistance(input) {
  if (typeof input === "object" && input) {
    const name = clean(input.name || input.distance || input.distancia || input.label);
    const km = clean(input.km || input.distanceKm || input.value);
    return normalizeDistance(name || km);
  }

  const text = clean(input);
  if (!text) return null;
  const match = text.replace(",", ".").match(/(\d+(?:\.\d+)?)\s*(k|km)?/i);
  if (!match) return { name: text.toUpperCase(), meters: "0" };
  const km = Number(match[1]);
  const display = Number.isInteger(km) ? String(km) : String(km).replace(".", ",");
  return { name: `${display}K`, meters: String(Math.round(km * 1000)) };
}

function normalizeDistances(input) {
  const source = Array.isArray(input) ? input : cleanList(input);
  const distances = source.map(normalizeDistance).filter(Boolean);
  const unique = [...new Map(distances.map((item) => [normalizeText(item.name), item])).values()];
  if (!unique.length) throw new Error("Faltan distancias para configurar.");
  return unique;
}

function makeEventUid() {
  return `_${Math.random().toString(36).slice(2, 11)}`;
}

function buildSimpleDistanceEvents({ competitionId, distances, date, startTime = "08:00", createCategories = false, genders }) {
  const start = formatDateTimePayload(date, startTime);
  const rangeInit = formatDateTimePayload(date, "05:00");
  const rangeFinish = formatDateTimePayload(date, "17:00");
  const categoryGenders = genders || { masculino: true, femenino: true, mixto: false };

  return distances.map((distance, index) => ({
    id: Date.now() + index,
    eventFormProps: {
      nombre: distance.name,
      cam_details: null,
      tickets: [],
    },
    sharedStateProps: {
      child1Forms: [
        {
          id: makeEventUid(),
          data: {
            nombre: "Salida",
            localizacion: "SALIDA",
            tiempoMinimo: "0",
            tiempoMinimoVuelta: "0",
            tipo: "Salida",
            distancia: "0",
            tipoSalida: "cronometro",
            readers: [{ id: 0, mac: `reader_SALIDA_${competitionId}`, model: null, status: null, mask_name: null, organizer: 0, install_date: null, last_connection: null, firmware_version: null }],
            rangeInit,
            rangeFinish,
          },
        },
        {
          id: makeEventUid(),
          data: {
            nombre: "Meta",
            localizacion: "META",
            tiempoMinimo: "0",
            tiempoMinimoVuelta: "0",
            tipo: "Meta",
            distancia: distance.meters,
            readers: [{ id: 0, mac: `reader_META_${competitionId}`, model: null, status: null, mask_name: null, organizer: 0, install_date: null, last_connection: null, firmware_version: null }],
            rangeInit,
            rangeFinish,
          },
        },
      ],
      child2Forms: [
        {
          id: makeEventUid(),
          data: {
            nombre: "General",
            tipoMedia: "min/km",
            tramos: [{ minValue: 0, maxValue: 1 }],
            official: true,
          },
        },
      ],
      child3Forms: [
        {
          id: makeEventUid(),
          data: {
            nombre: distance.name,
            fecha: start,
          },
        },
      ],
      child4Forms: createCategories
        ? [
            {
              id: makeEventUid(),
              data: {
                nombre: `${distance.name} GENERAL`,
                generos: categoryGenders,
              },
            },
          ]
        : [],
    },
  }));
}

function slugify(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

function formatCompetitionDateTime(date, time = "08:00") {
  const match = String(time || "08:00").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const hour = match ? String(match[1]).padStart(2, "0") : "08";
  const minute = match ? match[2] : "00";
  const second = match?.[3] || "00";
  return `${date}T${hour}:${minute}:${second}-05:00`;
}

function buildCompetitionSetupEvents({ competitionSlug, distances, date, startTime = "08:00", createCategories = false }) {
  const startsAt = formatCompetitionDateTime(date, startTime);
  const rangeStartAt = formatCompetitionDateTime(date, "05:00");
  const rangeEndAt = formatCompetitionDateTime(date, "23:59");

  return distances.map((distance, index) => {
    const clientKey = slugify(distance.name) || `distance-${index + 1}`;
    return {
      client_key: clientKey,
      name: distance.name,
      start_at: startsAt,
      distance_meters: Number(distance.meters) || null,
      is_active: true,
      categories: createCategories
        ? [
            {
              category: {
                name: `${distance.name} GENERAL`,
                gender_rule: "Mixto",
                is_active: true,
              },
              is_enabled: true,
            },
          ]
        : [],
      routes: [{ name: "principal", is_primary: true }],
      timing_config: {
        type_salidas: "cronometro",
        start_waves: [{ client_key: "general", name: distance.name, starts_at: startsAt, sort_order: 0 }],
        checkpoints: [
          {
            client_key: "start",
            sequence: 0,
            name: "Salida",
            kind: "start",
            location_code: "SALIDA",
            distance_meters: 0,
            range_start_at: rangeStartAt,
            range_end_at: rangeEndAt,
            readers: [{ mac: `reader_SALIDA_${competitionSlug}`, active: true }],
          },
          {
            client_key: "finish",
            sequence: 1,
            name: "Meta",
            kind: "finish",
            location_code: "META",
            distance_meters: Number(distance.meters) || null,
            range_start_at: rangeStartAt,
            range_end_at: rangeEndAt,
            readers: [{ mac: `reader_META_${competitionSlug}`, active: true }],
          },
        ],
        structured_sections: [],
      },
      extra_data: { source: "soporte-exotimer" },
    };
  });
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
  if (input.amount != null || input.price != null) patch.price = Number(input.amount ?? input.price);
  if (input.currency != null) patch.currency = String(input.currency).toUpperCase();
  if (input.startDate != null) patch.starts_at = String(input.startDate);
  if (input.endDate != null || input.dateExpired != null) patch.ends_at = String(input.endDate ?? input.dateExpired);

  if (Object.keys(patch).length === 0) {
    throw new Error("No hay cambios de ticket para aplicar.");
  }

  if (patch.price != null && patch.price < 0) {
    throw new Error("El precio del ticket no puede ser negativo.");
  }

  const next = { ...ticket, ...patch };
  if (next.starts_at && next.ends_at && new Date(next.ends_at) < new Date(next.starts_at)) {
    throw new Error("La fecha de expiracion no puede ser menor que la fecha de inicio.");
  }

  return { next, patch };
}

async function updateEventTicket(input) {
  const resolvedInput = await resolveCompetitionInput(input);
  const competitionId = pickCompetitionId(resolvedInput);
  const events = await getCompetitionEvents(resolvedInput);
  const event = input.eventId || input.eventName || input.distance
    ? matchByIdOrName(events, input.eventId, input.eventName || input.distance, "evento/distancia")
    : null;
  const tickets = event?.tickets || (await getTickets(resolvedInput));
  const ticket = matchByIdOrName(tickets, input.ticketId, input.ticketTitle || input.ticketName, "ticket");
  const { next, patch } = applyTicketPatch(ticket, input);

  const request = {
    method: "PATCH",
    path: `/registration/api/v1/tickets/${ticket.id}`,
    data: patch,
  };
  const saved = await apiRequest(request);

  return {
    ...buildAudit({ method: request.method, path: request.path, payload: request.data, response: saved }),
    saved,
    changed: {
      competitionId,
      event: event ? { id: event.id, name: event.name } : null,
      ticketBefore: ticket,
      ticketAfter: normalizeTicket(saved || next),
      patch,
    },
  };
}

async function getMessageBannerFile(input = {}) {
  const messageId = Number(input.messageId || input.message_id);
  if (!Number.isInteger(messageId)) return null;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      contentType: true,
      mediaData: true,
      mediaMimeType: true,
      mediaFilename: true,
    },
  });

  if (!message?.mediaData || !String(message.mediaMimeType || "").startsWith("image/")) return null;
  const extension = String(message.mediaMimeType).includes("png") ? "png" : "jpg";
  return {
    buffer: Buffer.from(message.mediaData),
    mimeType: message.mediaMimeType || "image/jpeg",
    filename: message.mediaFilename || `bases-${message.id}.${extension}`,
  };
}

async function createCompetitionFromBases(input = {}) {
  const extracted = input.mediaAnalysis?.extracted || input.imageAnalysis?.extracted || {};
  const competitionName = clean(
    input.competitionName ||
      input.name ||
      input.eventName ||
      extracted.competitionName ||
      extracted.eventName ||
      extracted.name
  );
  const date = parseCompetitionDate(
    input.date ||
      input.eventDate ||
      input.competitionDate ||
      extracted.eventDate ||
      extracted.date ||
      extracted.competitionDate
  );
  const countryHint = clean(input.country || input.countryName || extracted.country || extracted.countryName) || "Perú";
  const cityHint = clean(input.city || input.cityName || extracted.city || extracted.cityName);
  const sportHint = clean(input.sport || input.sportName || extracted.sport || extracted.sportName) || "Trail Run";
  const organizerHint = clean(input.organizer || input.organizerName || extracted.organizer || extracted.organizerName);
  const allowUnassignedOrganizer =
    input.allowUnassignedOrganizer === true ||
    input.useUnassignedOrganizer === true ||
    input.organizer === "Sin Asignar" ||
    normalizeText(organizerHint).includes("sin asignar");
  const distances = normalizeDistances(
    input.distances ||
      input.distanceOptions ||
      input.distance ||
      input.distancia ||
      extracted.distances ||
      extracted.distanceOptions ||
      extracted.distance
  );

  if (!competitionName) throw new Error("Falta nombre de competencia.");
  if (!date) throw new Error("Falta fecha de competencia.");
  if (!cityHint) throw new Error("Falta ciudad de competencia.");

  const catalogs = await getCompetitionCatalogs();
  const country = bestCatalogMatch(catalogs.countries, countryHint, (item) => item.pais || item.name || item.codigo, "pais");
  const cityCandidates = catalogs.cities.filter(
    (item) => !country?.id || (!item.country_id && !item.pais) || String(item.country_id || item.pais) === String(country.id)
  );
  const city = bestCatalogMatch(cityCandidates.length ? cityCandidates : catalogs.cities, cityHint, (item) => item.city || item.name, "ciudad");
  const sport = bestCatalogMatch(catalogs.sports, sportHint, (item) => item.name, "deporte");
  const organizer = bestCatalogMatch(catalogs.organizers, organizerHint, (item) => item.name, "organizador", {
    minScore: 65,
    fallback: allowUnassignedOrganizer
      ? () => catalogs.organizers.find((item) => normalizeText(item.name) === "sin asignar" || normalizeText(item.name).includes("sin asignar"))
      : undefined,
  });
  if (!organizer) throw new Error("No se encontro organizador. Indica un organizador valido o autoriza usar Sin Asignar.");

  const banner = input.useMessageImageAsBanner === false ? null : await getMessageBannerFile(input);
  const website = clean(input.website || input.web || extracted.website || extracted.web);
  const description = {
    face: false,
    extra: {},
    sheet: "",
    waLink: "",
    buyPhoto: false,
    gapVideo: 0,
    type_pay: "voucher",
    photoLink: "#",
    public_key: null,
    trackingEnd: "",
    access_token: null,
    collector_id: null,
    trackingInit: "",
    application_fee: 15,
    payments_details: website ? `Web: ${website}` : "",
    type_competition: "evento",
    campeonato_nacional: false,
    taller: {
      faq: [],
      costo: "",
      cupos: "",
      fecha: "",
      lugar: "",
      nivel: "",
      title: "",
      banner: "",
      galeria: [],
      incluye: [],
      resumen: "",
      reviews: [],
      contacto: {},
      duracion: "",
      horarios: [],
      objetivos: [],
      cupos_text: "",
      dirigido_a: [],
      requisitos: [],
      condiciones: [],
      payments_details: "",
      ticketDescriptions: {},
    },
  };

  const competitionSlug = slugify(`${competitionName}-${date}`);
  const shouldConfigureDistances = input.configureDistances !== false;
  const setupPayload = {
    competition: {
      name: competitionName,
      slug: competitionSlug,
      start_date: formatCompetitionDateTime(date, input.startTime || input.start || extracted.startTime || "08:00"),
      country_id: Number(country.id),
      city_id: Number(city.id),
      sport_id: Number(sport.id),
      status: "draft",
      visibility: "public",
      description,
      owners: [{ organization_id: Number(organizer.id), role: "owner", is_primary: true }],
    },
    events: shouldConfigureDistances
      ? buildCompetitionSetupEvents({
          competitionSlug,
          distances,
          date,
          startTime: input.startTime || input.start || extracted.startTime || "08:00",
          createCategories: input.createCategories === true,
        })
      : [],
  };
  const setupRequest = {
    method: "POST",
    path: "/catalog/api/v1/competitions/setup",
    params: { create_timing_configs: true },
    data: setupPayload,
  };
  const createResponse = await apiRequest(setupRequest);
  const competitionId = createResponse?.competition?.id || createResponse?.id;
  if (!competitionId) throw new Error("ExoTimer no devolvio id de competencia creada.");

  let bannerResponse = null;
  if (banner) {
    bannerResponse = await apiMultipartRequest({
      method: "POST",
      path: `/catalog/api/v1/competitions/${competitionId}/media/banner_url`,
      files: { media: banner },
    });
  }

  competitionCache.expiresAt = 0;
  const detail = await apiRequest({ path: `/catalog/api/v1/competitions/${competitionId}/full` });
  let salidas = null;
  try {
    salidas = await apiRequest({ path: `/timing/api/v1/raws/config/salidas/${competitionId}/` });
  } catch {
    salidas = null;
  }

  return {
    created: true,
    competitionId: Number(competitionId),
    competition: {
      id: detail?.id || Number(competitionId),
      name: detail?.name || competitionName,
      date: detail?.start_date?.slice?.(0, 10) || date,
      country: country.name || country.pais,
      city: city.name || city.city,
      sport: sport.name,
      organizer: organizer.name,
      config: createResponse?.timing_configs ?? null,
      banner: detail?.banner_url || bannerResponse?.banner_url || null,
    },
    distances: distances.map((item) => item.name),
    startTime: input.startTime || input.start || extracted.startTime || "08:00",
    categoriesCreated: input.createCategories === true,
    eventCreateResponse: createResponse,
    salidas,
    audit: {
      request: {
        method: setupRequest.method,
        endpoint: setupRequest.path,
        params: setupRequest.params,
        payload: setupPayload,
      },
      response: createResponse,
      catalogs: {
        country,
        city,
        sport,
        organizer,
      },
      usedMessageImageAsBanner: Boolean(banner),
      bannerResponse,
    },
  };
}

async function createCompetitionFromChat(input = {}) {
  return createCompetitionFromBases({
    ...input,
    useMessageImageAsBanner: false,
    creationSource: "chat",
  });
}

async function getInscription(input) {
  const normalizedInput = await resolveCompetitionInput(normalizeDorsalReferences(input));
  const request = {
    path: "/registration/api/v1/inscriptions/detail-verify/",
    params: {
      competition: pickCompetitionId(normalizedInput),
      competition_id: Number(pickCompetitionId(normalizedInput)),
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
  if (inscription.participant && typeof inscription.participant === "object") return inscription.participant;
  if (inscription.participant_payload && typeof inscription.participant_payload === "object") {
    return inscription.participant_payload;
  }
  return {};
}

function inscriptionFullName(inscription = {}) {
  const document = pickInscriptionDocument(inscription);
  const participant = pickParticipant(inscription);
  return [
    document.nombre || document.name || participant.first_name || participant.name,
    document.apellidos || document.lastname || document.lastname_mother || participant.last_name || participant.lastname,
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
    const current = normalizeDigits(
      document.dni || document.document || document.document_number || participant.dni || participant.document_number
    );
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
  const ticket = inscription.ticket && typeof inscription.ticket === "object" ? inscription.ticket : null;
  const event = inscription.event && typeof inscription.event === "object" ? inscription.event : null;
  const email = clean(document.email || participant.email);
  const expectedEmail = clean(terms.email);
  return {
    id: inscription.id || inscription.pk || null,
    participantId: participant.id || null,
    participantUserFirebase:
      clean(participant.user_firebase || participant.userFirebase || participant.user_uid || participant.uid) || null,
    ticketId: ticket?.id || inscription.ticket_id || (typeof inscription.ticket === "number" ? inscription.ticket : null),
    eventId: event?.id || inscription.event_id || (typeof inscription.event === "number" ? inscription.event : null),
    categoryId: inscription.category_id || event?.category_id || null,
    commerceOrderId: inscription.commerce_order_id || null,
    name: inscriptionFullName(inscription) || null,
    dni: clean(
      document.dni || document.document || document.document_number || participant.dni || participant.document_number
    ) || null,
    email: email || null,
    phone: clean(document.phone || document.telefono || document.celular || participant.phone) || null,
    distance: clean(inscription.event_name || document.distancia || document.distance) || null,
    category: clean(inscription.category_name || document.categoria || document.category) || null,
    gender: clean(inscription.gender || document.genero || document.gender || participant.gender || participant.genre) || null,
    dorsal: clean(inscription.dorsal || document.dorsal || document._dorsal || document.bib) || null,
    amount: clean(
      inscription.pricing_snapshot?.total_amount ||
        inscription.pricing_snapshot?.price ||
        document.precio_inscripcion ||
        document.amount ||
        inscription.amount
    ) || null,
    voucher: inscription.voucher || null,
    voucherState: inscription.status || inscription.state_voucher || null,
    paidAt: inscription.paid_at || null,
    coupon: inscription.coupon_code || inscription.cupon_usado || null,
    emailMatchesExpected: expectedEmail && email ? normalizeEmail(expectedEmail) === normalizeEmail(email) : null,
    documentData: { ...document },
    participantData: { ...participant },
  };
}

async function getInscriptionByReferenceOrDocument(input = {}) {
  const resolvedInput = await resolveCompetitionInput(input);
  const competitionId = pickCompetitionId(resolvedInput);
  const terms = buildInscriptionSearchTerms(input);
  if (!Object.values(terms).some(Boolean)) {
    throw new Error("Falta referencia, DNI, correo, telefono o nombre para buscar la inscripcion.");
  }

  const request = {
    path: "/registration/api/v1/inscriptions/",
    params: { competition_id: Number(competitionId), limit: 500, offset: 0 },
  };
  const response = await requestAllPages(request.path, { competition_id: Number(competitionId) });
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
    ...buildAudit({ path: request.path, params: request.params, response: { count: rows.length, matched: scored.length } }),
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
  let commerceOrder = null;
  let commercePayments = [];
  if (match?.commerceOrderId) {
    [commerceOrder, commercePayments] = await Promise.all([
      apiRequest({ path: `/commerce/api/v1/orders/${match.commerceOrderId}` }).catch(() => null),
      requestAllPages("/commerce/api/v1/orders/payments/", { order_id: Number(match.commerceOrderId) }).catch(() => []),
    ]);
  }
  const expectedRaw = String(match?.amount || "").replace(/[^\d.]+/g, "");
  const paidRaw = String(evidence.amount || "").replace(/[^\d.]+/g, "");
  const expectedAmount = expectedRaw ? Number(expectedRaw) : null;
  const paidAmount = paidRaw ? Number(paidRaw) : null;
  const amountMatches =
    Number.isFinite(expectedAmount) && expectedAmount > 0 && Number.isFinite(paidAmount) && paidAmount > 0
      ? Math.abs(expectedAmount - paidAmount) < 0.01
      : null;
  const approvedPayment = commercePayments.find((payment) =>
    ["approved", "paid", "succeeded", "completed"].includes(normalizeText(payment.status))
  );
  const commercePaid = Boolean(
    match?.paidAt ||
      approvedPayment ||
      ["paid", "confirmed", "completed"].includes(normalizeText(commerceOrder?.status))
  );
  const paymentLooksValid = Boolean(
    lookup.found &&
      (commercePaid || (evidence.hasStrongEvidence && evidence.amount && (amountMatches === true || amountMatches === null)))
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
      commerceOrderId: match?.commerceOrderId || null,
      commerceOrderStatus: commerceOrder?.status || null,
      commercePaymentStatus: approvedPayment?.status || commercePayments[0]?.status || null,
      commercePaid,
      requiresHumanForPaymentApproval: !commercePaid,
      reason: !lookup.found
        ? "inscription_not_found"
        : commercePaid
          ? "payment_confirmed_by_commerce"
        : !evidence.hasStrongEvidence
          ? "weak_or_missing_payment_evidence"
          : amountMatches === false
            ? "amount_mismatch"
            : "payment_evidence_matches_inscription_but_payment_approval_is_human",
    },
    commerce: {
      order: commerceOrder,
      payments: commercePayments,
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
  const participantPayload = {
    ...(lookup.bestMatch.participantData || {}),
    email: nextEmail,
  };
  const request = {
    method: "PATCH",
    path: `/registration/api/v1/inscriptions/${lookup.bestMatch.id}`,
    data: { document, participant_payload: participantPayload },
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

async function getInscriptionCombineData(competitionId) {
  const request = {
    method: "GET",
    path: `/catalog/api/v1/competitions/${competitionId}/combine-data/`,
  };
  const response = await apiRequest(request);
  return {
    ...buildAudit({ method: request.method, path: request.path, response }),
    combinations: response && typeof response === "object" && !Array.isArray(response) ? response : {},
  };
}

async function updateInscriptionEventCategory(input = {}) {
  const lookup = await getInscriptionByReferenceOrDocument(input);
  if (!lookup.found || !lookup.bestMatch) {
    throw new Error(lookup.ambiguous ? "La busqueda de inscripcion es ambigua." : "No se encontro la inscripcion.");
  }

  const before = lookup.bestMatch;
  const combineData = await getInscriptionCombineData(lookup.competitionId);
  const combinations = combineData.combinations;
  const entries = normalizeCombinationEntries(combinations);
  const distanceOptions = [...new Set(entries.map((entry) => entry.distance).filter(Boolean))];

  const targetField = normalizeText(input.targetField || input.field || "");
  const requestedValue = clean(input.requestedValue || input.newValue);
  const requestedDistance = clean(
    input.newDistance ||
      input.distanceNew ||
      input.distancia ||
      input.distance ||
      input.requestedDistance ||
      (targetField.includes("distancia") || targetField.includes("distance") ? requestedValue : null)
  );
  const requestedGender = clean(
    input.newGender ||
      input.genderNew ||
      input.genero ||
      input.gender ||
      input.requestedGender ||
      (targetField.includes("genero") || targetField.includes("gender") ? requestedValue : null)
  );
  const requestedCategory = clean(
    input.newCategory ||
      input.categoryNew ||
      input.categoria ||
      input.category ||
      input.requestedCategory ||
      (targetField.includes("categoria") || targetField.includes("category") ? requestedValue : null)
  );
  if (!requestedDistance && !requestedGender && !requestedCategory) {
    throw new Error("Falta distancia, genero o categoria para actualizar la inscripcion.");
  }

  const resolvedDistance = requestedDistance
    ? resolveOption(distanceOptions, requestedDistance, "distancia")
    : resolveOption(distanceOptions, before.distance, "distancia");
  const distanceEntries = entries.filter(
    (entry) => normalizeText(entry.distance) === normalizeText(resolvedDistance.value)
  );
  const categoryOptions = distanceEntries.map((entry) => entry.category);
  const resolvedCategory = requestedCategory
    ? resolveOption(categoryOptions, requestedCategory, "categoria")
    : resolveOption(categoryOptions, before.category, "categoria");
  const resolvedGender = requestedGender ? resolveGenderOption(requestedGender) : { value: before.gender, score: 100 };
  const resolvedEntry = distanceEntries.find(
    (entry) =>
      normalizeText(entry.category) === normalizeText(resolvedCategory.value) &&
      (!entry.gender ||
        normalizeText(entry.gender) === "mixto" ||
        normalizeText(entry.gender) === normalizeText(resolvedGender.value))
  );
  if (!resolvedEntry?.raw?.eventId || !resolvedEntry?.raw?.categoryId) {
    throw new Error("No se pudieron resolver los IDs reales de evento y categoria.");
  }

  const document = {
    ...(before.documentData || {}),
    distancia: resolvedDistance.value,
    genero: resolvedGender.value,
    categoria: resolvedCategory.value,
  };

  const request = {
    method: "PATCH",
    path: `/registration/api/v1/inscriptions/${before.id}`,
    data: {
      event_id: Number(resolvedEntry.raw.eventId),
      event_name: resolvedDistance.value,
      category_id: Number(resolvedEntry.raw.categoryId),
      category_name: resolvedCategory.value,
      gender: resolvedGender.value,
      document,
    },
  };
  const response = await apiRequest(request);
  const verification = await getInscriptionByReferenceOrDocument({
    competitionId: lookup.competitionId,
    inscriptionId: before.id,
    document: before.dni,
    dni: before.dni,
    email: before.email,
    phone: before.phone,
    participantName: before.name,
  });
  const after = verification.bestMatch;
  if (
    !after ||
    normalizeText(after.distance) !== normalizeText(resolvedDistance.value) ||
    normalizeText(after.category) !== normalizeText(resolvedCategory.value) ||
    normalizeText(after.gender) !== normalizeText(resolvedGender.value)
  ) {
    throw new Error("La inscripcion se guardo, pero la verificacion posterior no coincide con la combinacion solicitada.");
  }

  return {
    ...buildAudit({ method: request.method, path: request.path, payload: request.data, response }),
    combineData,
    resolvedCombination: {
      distance: resolvedDistance,
      category: resolvedCategory,
      gender: resolvedGender,
      eventId: resolvedEntry.raw.eventId,
      categoryId: resolvedEntry.raw.categoryId,
    },
    changed: {
      competitionId: lookup.competitionId,
      inscriptionId: before.id,
      before: {
        eventId: before.eventId,
        distance: before.distance,
        category: before.category,
        gender: before.gender,
      },
      after: after
        ? {
            eventId: after.eventId,
            distance: after.distance,
            category: after.category,
            gender: after.gender,
          }
        : null,
    },
    saved: response,
    verification,
  };
}

async function resendInscriptionConfirmation(input = {}) {
  const lookup = await getInscriptionByReferenceOrDocument(input);
  if (!lookup.found || !lookup.bestMatch) {
    throw new Error(lookup.ambiguous ? "La busqueda de inscripcion es ambigua." : "No se encontro la inscripcion.");
  }

  const match = lookup.bestMatch;
  const request = {
    method: "GET",
    path: `/registration/api/v1/inscriptions/${match.id}/confirmation`,
  };
  const response = await apiRequest(request);

  return {
    ...buildAudit({ method: request.method, path: request.path, response }),
    resent: false,
    confirmationRetrieved: true,
    emailResent: false,
    emailResendUnavailable: true,
    inscription: {
      id: match.id,
      competitionId: lookup.competitionId,
      participantId: match.participantId,
      ticketId: match.ticketId,
      eventId: match.eventId,
      email: match.email,
      name: match.name,
    },
    confirmation: response,
    lookup,
  };
}

function pickWhatsAppRecipient(input = {}, match = {}) {
  const value = input.whatsappTo || input.to || input.deliveryPhone || input.whatsappPhone || input.conversationPhone || match.phone || input.phone;
  if (!clean(value)) throw new Error("Falta numero WhatsApp destino.");
  return clean(value);
}

function buildInscriptionConfirmationCaption({ match, response, competitionName }) {
  const inscription = response?.inscription || response || {};
  return [
    `Hola ${match.name || response?.participant_name || "participante"}, te compartimos la confirmacion de tu inscripcion:`,
    "",
    `Evento: ${competitionName || match.competitionName || "Evento"}`,
    `Participante: ${match.name || response?.participant_name || "No especificado"}`,
    `DNI: ${match.dni || response?.dni || "No especificado"}`,
    `Distancia: ${match.distance || inscription.event_name || "No especificado"}`,
    `Categoria: ${match.category || inscription.category_name || "No especificado"}`,
    `Genero: ${match.gender || inscription.gender || "No especificado"}`,
    `Inscripcion: #${match.id || inscription.id || "No especificado"}`,
    `Codigo de confirmacion: ${response?.confirmation_code || "No especificado"}`,
    "",
    "Presenta este QR/comprobante para validar tu inscripcion cuando sea necesario.",
  ].filter((line) => line !== "").join("\n");
}

async function sendInscriptionConfirmationWhatsApp(input = {}) {
  const result = await resendInscriptionConfirmation(input);
  const match = result.lookup.bestMatch;
  const recipient = pickWhatsAppRecipient(input, match);
  const confirmation = result.confirmation || result.response;
  const pdfUrl = `${config.raceline.baseUrl}/registration/api/v1/inscriptions/${match.id}/confirmation.pdf`;

  const caption = buildInscriptionConfirmationCaption({
    match,
    response: confirmation,
    competitionName: input.competitionName,
  });
  const sent = await sendDocumentMessage(
    recipient,
    pdfUrl,
    caption,
    `confirmacion-inscripcion-${match.id}.pdf`
  );

  return {
    ...result,
    whatsappSent: true,
    whatsapp: {
      to: recipient,
      type: "document",
      pdfUrl,
      caption,
      providerResponse: sent,
      providerMessageId: sent?.messages?.[0]?.id || null,
    },
  };
}

async function getResults(input) {
  const resolvedInput = await resolveCompetitionInput(input);
  return requestAllPages("/timing/api/v1/results/admin/", {
    competition_id: Number(pickCompetitionId(resolvedInput)),
  });
}

function splitDisplayName(value) {
  const words = clean(value)?.split(/\s+/).filter(Boolean) || [];
  if (words.length <= 1) return { name: words[0] || null, lastname: null };
  return { name: words[0], lastname: words.slice(1).join(" ") };
}

function normalizeResultDetail(response, catalogEvent = null, startGroups = null) {
  const row = response?.item || response?.result || asArray(response?.items || response?.results)[0] || response;
  const participantPayload =
    response?.participant ||
    row?.participant_snapshot ||
    row?.participant_snapshot_payload ||
    row?.athlete ||
    row?.athlete_payload ||
    {};
  const displayName = splitDisplayName(
    participantPayload.display_name || row?.participant_display_name
  );
  const participantName =
    participantPayload.first_name || participantPayload.name || displayName.name;
  const participantLastname =
    participantPayload.last_name || participantPayload.lastname || displayName.lastname;
  const responseEvent = response?.event || {};
  const category = responseEvent.category || {};
  const eventName = row?.event_name || responseEvent.name || catalogEvent?.name || null;
  const eventId = row?.event_id || responseEvent.id || catalogEvent?.id || null;
  const legacyConfigs =
    catalogEvent?.extra_data?.admin_form?.configs || catalogEvent?.extra_data?.configs || null;
  const matchingStartGroup = startGroups && typeof startGroups === "object"
    ? startGroups[String(eventId)] ||
      Object.values(startGroups).find(
        (group) =>
          String(group?.event_id || group?.id || "") === String(eventId || "") ||
          normalizeText(group?.event_name) === normalizeText(eventName)
      )
    : null;
  const configs = legacyConfigs
    ? [{ id: eventId, ...legacyConfigs }]
    : matchingStartGroup
      ? [{ id: eventId, salidas: matchingStartGroup.salidas || matchingStartGroup.start_waves || [] }]
      : [];
  const rawAssignments = asArray(row?.raw_assignments || response?.raw_assignments).map((assignment) => ({
    id: assignment.raw_id || assignment.raw?.id || assignment.id,
    raw_id: assignment.raw_id || assignment.raw?.id || assignment.id,
    dorsal: assignment.raw?.dorsal || row?.dorsal,
    chip: assignment.raw?.chip || row?.chip,
    hour: assignment.raw?.read_at || assignment.read_at,
    zulu: assignment.raw?.zulu_at || assignment.read_at,
    location: assignment.raw?.location || assignment.location || assignment.name,
    competition: row?.competition_id,
    point_control: assignment.key || assignment.point_control,
  }));

  return {
    ...row,
    participant: {
      ...participantPayload,
      id: participantPayload.id || row?.person_id || row?.participant_snapshot_id || null,
      name: participantName,
      lastname: participantLastname,
    },
    participantName,
    participantLastname,
    dorsal: row?.dorsal,
    chip: row?.chip,
    salida: response?.salida || row?.salida,
    tiempo_oficial: row?.official_time_ms == null ? null : formatDuration(row.official_time_ms / 1000),
    hora_meta: row?.finish_at || null,
    competition: row?.competition_id,
    event: {
      ...catalogEvent,
      ...responseEvent,
      id: eventId,
      name: eventName,
      category: {
        ...category,
        id: row?.category_id || category.id || null,
        name: row?.category_name || category.name || null,
        genre: row?.gender || category.genre || category.gender_rule || null,
      },
      configs,
    },
    raws: [...asArray(response?.raw_candidates), ...rawAssignments],
    raws_asigments: rawAssignments,
    raws_assignments: rawAssignments,
  };
}

async function getResultDetail(input) {
  const ids = Array.isArray(input.resultIds) ? input.resultIds : [input.resultId || input.id].filter(Boolean);
  if (!ids.length) throw new Error("Falta resultId.");
  const response = await apiRequest({
    path: `/timing/api/v1/results/detail/${ids.map(String).join(",")}/`,
  });
  const rows = asArray(response?.items || response?.results || response?.item || response?.result || response);
  const normalized = await Promise.all(
    rows.map(async (row, index) => {
      const envelope = rows.length === 1 ? response : { item: row };
      const resultRow = envelope?.item || envelope?.result || row;
      const [catalogEvent, startGroups] = await Promise.all([
        resultRow?.event_id
          ? apiRequest({ path: `/catalog/api/v1/events/${resultRow.event_id}` }).catch(() => null)
          : null,
        resultRow?.competition_id
          ? apiRequest({ path: `/timing/api/v1/raws/config/salidas/${resultRow.competition_id}/` }).catch(() => null)
          : null,
      ]);
      return normalizeResultDetail(index === 0 ? envelope : { item: row }, catalogEvent, startGroups);
    })
  );
  return normalized.length === 1 ? normalized[0] : normalized;
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

function utcMsToDateParts(ms, offset = "-05:00") {
  const sign = offset.startsWith("-") ? -1 : 1;
  const match = offset.match(/[+-](\d{2}):?(\d{2})?/);
  const offsetMinutes = match ? sign * (Number(match[1]) * 60 + Number(match[2] || 0)) : -300;
  const local = new Date(ms + offsetMinutes * 60000);
  return {
    date: {
      year: local.getUTCFullYear(),
      month: local.getUTCMonth() + 1,
      day: local.getUTCDate(),
    },
    time: {
      hours: local.getUTCHours(),
      minutes: local.getUTCMinutes(),
      seconds: local.getUTCSeconds(),
    },
    offset,
  };
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

  const elapsedSeconds = parseDurationSeconds(input.gpsElapsedTime || input.evidenceElapsedTime || input.requestedValue);
  const eventStart = pickEventStartDateTime(detail, input);
  if (eventStart && elapsedSeconds != null && input.preferActivityStartForGps !== true) {
    return utcMsToDateParts(datePartsToUtcMs(eventStart) + elapsedSeconds * 1000, eventStart.offset || input.timezoneOffset || "-05:00");
  }

  const activityStart = parseLocalDateTime(input.activityStartDateTime || input.activityStartTime || input.gpsStartDateTime);
  if (activityStart && elapsedSeconds != null) {
    return utcMsToDateParts(datePartsToUtcMs(activityStart) + elapsedSeconds * 1000, activityStart.offset || input.timezoneOffset || "-05:00");
  }

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

function isTrustAthleteEvidenceEnabled(input = {}) {
  return (
    input.trustAthleteEvidence === true ||
    input.TRUST_ATHLETE_EVIDENCE === true ||
    String(input.evidencePolicy || input.policyMode || "").toUpperCase() === "TRUST_ATHLETE_EVIDENCE"
  );
}

function buildAthleteEvidenceTrustAssessment(input = {}, detail = {}) {
  const summary = normalizeText([input.evidenceSummary, input.evidence, input.message, input.requestedCorrection].filter(Boolean).join(" "));
  const hasCompetition = Boolean(input.competitionId || input.competition_id || input.competition);
  const hasStructuredClaim = Boolean(hasCompetition && (input.dorsal || input.bib || input.currentDorsal) && (input.athleteName || input.participantName));
  const hasDorsalEvidence = Boolean(
    input.dorsalEvidence === true ||
      input.hasDorsalPhoto === true ||
      /(dorsal|bib|numero).{0,40}(visible|claro|meta|salida|foto|oficial)|foto.{0,50}dorsal/.test(summary)
  );
  const hasFinishOrParticipationEvidence = Boolean(
    input.finishEvidence === true ||
      input.hasFinishPhoto === true ||
      /(meta|llegada|finish|cruzando|cruzo|oficial).{0,60}(dorsal|foto|visible|arco|evento)/.test(summary)
  );
  const hasGpsEvidence = Boolean(
    input.gpsElapsedTime ||
      input.evidenceElapsedTime ||
      input.activityStartDateTime ||
      input.gpsStartDateTime ||
      /(gps|strava|garmin|coros|reloj|actividad|ruta|distancia|desnivel)/.test(summary)
  );
  const hasTimeEvidence = Boolean(
    input.evidenceFinishDateTime ||
      input.evidenceMetaDateTime ||
      input.evidenceFinishTime ||
      input.evidenceMetaTime ||
      input.horaMeta ||
      input.metaTime ||
      input.finishTime ||
      input.requestedValue ||
      input.gpsElapsedTime ||
      input.evidenceElapsedTime
  );
  const hasDateOrEventContext = Boolean(
    input.activityStartDateTime ||
      input.eventDate ||
      input.competitionDate ||
      input.competitionName ||
      /(fecha|dia|evento|utcb|carrera|competencia|compatible|coherente)/.test(summary)
  );
  const currentMissing = indicatesMissingOfficialTime(input, detail);

  const signals = [
    hasStructuredClaim && "structured_claim",
    hasDorsalEvidence && "dorsal_evidence",
    hasFinishOrParticipationEvidence && "finish_or_participation_evidence",
    hasGpsEvidence && "gps_or_watch_evidence",
    hasTimeEvidence && "time_evidence",
    hasDateOrEventContext && "date_or_event_context",
    currentMissing && "missing_current_time",
  ].filter(Boolean);

  return {
    enabled: isTrustAthleteEvidenceEnabled(input),
    accepted: isTrustAthleteEvidenceEnabled(input) && hasStructuredClaim && hasTimeEvidence && signals.length >= 4,
    signals,
    summary: input.evidenceSummary || input.requestedCorrection || null,
  };
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
  const nextChip =
    mode === "dorsal"
      ? input.chip ?? input.newChip ?? nextDorsal ?? detail?.chip ?? detail?.dorsal ?? detail?.bib
      : input.chip ?? input.newChip ?? detail?.chip ?? nextDorsal ?? detail?.dorsal ?? detail?.bib;

  return {
    result_id: resultId,
    selectedIds: [resultId],
    id_competicion: Number(pickCompetitionId(input)),
    dorsal: numberOrString(nextDorsal ?? detail?.dorsal ?? detail?.bib),
    chip: numberOrString(nextChip),
    participantName: participantName ?? participant.name ?? detail?.participantName ?? detail?.athleteName,
    participantLastname,
    evento_distancia: eventName ?? event.name ?? detail?.evento_distancia ?? detail?.distance,
    genero: gender ?? category.genre ?? detail?.genero ?? detail?.gender,
    categoria: categoryName ?? category.name ?? detail?.categoria ?? detail?.category,
    salida: input.salida ?? input.outputName ?? input.startName ?? detail?.salida ?? detail?.outputName,
  };
}

function getRequestedResultEventValues(input = {}) {
  const targetField = normalizeText(input.targetField || input.field || "");
  const genericRequestedValue = requestedValue(input);
  return {
    distance: clean(
      input.newDistance ||
        input.distanceNew ||
        input.evento_distancia ||
        input.distance ||
        input.requestedDistance ||
        (targetField.includes("distancia") || targetField.includes("distance") || targetField.includes("evento")
          ? genericRequestedValue
          : null)
    ),
    gender: clean(
      input.newGender ||
        input.genderNew ||
        input.genero ||
        input.gender ||
        input.genre ||
        input.requestedGender ||
        (targetField.includes("genero") || targetField.includes("gender") || targetField.includes("sexo") ? genericRequestedValue : null)
    ),
    category: clean(
      input.newCategory ||
        input.categoryNew ||
        input.categoria ||
        input.category ||
        input.categoryName ||
        input.requestedCategory ||
        (targetField.includes("categoria") || targetField.includes("category") ? genericRequestedValue : null)
    ),
  };
}

async function resolveResultEventCombination(input, detail, form) {
  const competitionId = pickCompetitionId(input);
  const combineData = await getInscriptionCombineData(competitionId);
  const entries = normalizeCombinationEntries(combineData.combinations);
  const distanceOptions = [...new Set(entries.map((item) => item.distance).filter(Boolean))];
  if (!distanceOptions.length) {
    throw new Error("No se pudieron cargar combinaciones reales de distancia/categoria para esta competencia.");
  }

  const requested = getRequestedResultEventValues(input);
  const before = {
    distance: detail?.event?.name ?? detail?.evento_distancia ?? detail?.distance ?? form.evento_distancia,
    gender: detail?.event?.category?.genre ?? detail?.genero ?? detail?.gender ?? form.genero,
    category: detail?.event?.category?.name ?? detail?.categoria ?? detail?.category ?? form.categoria,
  };

  const resolvedDistance = requested.distance
    ? resolveOption(distanceOptions, requested.distance, "distancia")
    : resolveOption(distanceOptions, before.distance, "distancia");
  const distanceEntries = entries.filter((item) => normalizeText(item.distance) === normalizeText(resolvedDistance.value));

  const resolvedGender = requested.gender ? resolveGenderOption(requested.gender) : { value: before.gender, score: 100, query: before.gender };
  const requestedCategoryIsGeneric = isGenericCategoryRequest(requested.category);
  const categoryOptions = distanceEntries
    .filter(
      (item) =>
        !resolvedGender.value ||
        !item.gender ||
        normalizeText(item.gender) === "mixto" ||
        normalizeText(item.gender) === normalizeText(resolvedGender.value)
    )
    .map((item) => item.category);

  let resolvedCategory = null;
  if (requested.category && !requestedCategoryIsGeneric) {
    resolvedCategory = resolveOption(categoryOptions, requested.category, "categoria");
  } else if (requestedCategoryIsGeneric) {
    resolvedCategory = resolveCategoryByAge(distanceEntries, input.participantAge || input.age || input.edad, resolvedGender.value, {
      distance: resolvedDistance.value,
      currentCategory: before.category,
    });
    if (!resolvedCategory) {
      throw new Error("No se pudo resolver una categoria real del evento a partir de la edad indicada.");
    }
  }
  if (!resolvedCategory) {
    resolvedCategory = resolveOption(categoryOptions, before.category, "categoria");
  }
  const resolvedEntry = distanceEntries.find(
    (item) =>
      normalizeText(item.category) === normalizeText(resolvedCategory.value) &&
      (!item.gender ||
        normalizeText(item.gender) === "mixto" ||
        normalizeText(item.gender) === normalizeText(resolvedGender.value))
  );
  if (!resolvedEntry?.raw?.eventId || !resolvedEntry?.raw?.categoryId) {
    throw new Error("No se pudieron resolver los IDs reales de evento y categoria para el resultado.");
  }

  return {
    combineData,
    resolvedCombination: {
      distance: resolvedDistance,
      gender: resolvedGender,
      category: resolvedCategory,
      available: {
        distances: distanceOptions,
        categories: categoryOptions,
      },
      eventId: resolvedEntry.raw.eventId,
      categoryId: resolvedEntry.raw.categoryId,
    },
    formPatch: {
      evento_distancia: resolvedDistance.value,
      genero: resolvedGender.value,
      categoria: resolvedCategory.value,
      event_id: Number(resolvedEntry.raw.eventId),
      category_id: Number(resolvedEntry.raw.categoryId),
    },
  };
}

function summarizeResultDetail(detail) {
  return {
    dorsal: detail?.dorsal ?? detail?.bib,
    participantName: detail?.participant?.name ?? detail?.participantName ?? detail?.athleteName,
    participantLastname: detail?.participant?.lastname ?? detail?.participantLastname ?? detail?.lastname,
    evento_distancia: detail?.event?.name ?? detail?.evento_distancia ?? detail?.distance,
    genero: detail?.event?.category?.genre ?? detail?.genero ?? detail?.gender,
    categoria: detail?.event?.category?.name ?? detail?.categoria ?? detail?.category,
  };
}

async function updateResultParticipant(input, mode) {
  const normalizedInput = await resolveCompetitionInput(normalizeDorsalReferences(input));
  const { resultId, detail } = await resolveResultForUpdate(normalizedInput);
  const form = buildResultParticipantForm({ input: normalizedInput, resultId, detail, mode });
  let resolvedEvent = null;

  if (mode === "event_category") {
    resolvedEvent = await resolveResultEventCombination(normalizedInput, detail, form);
    Object.assign(form, resolvedEvent.formPatch);
  }

  const participantDisplayName = [form.participantName, form.participantLastname].filter(Boolean).join(" ").trim();
  const payload = {};
  if (mode === "dorsal") {
    payload.dorsal = Number(form.dorsal);
    payload.chip = String(form.chip);
  }
  if (mode === "participant_data") {
    if (!participantDisplayName) throw new Error("Falta nombre o apellido para actualizar el participante.");
    payload.participant_display_name = participantDisplayName;
    payload.athlete_payload = {
      ...(detail?.athlete_payload || {}),
      name: form.participantName || null,
      lastname: form.participantLastname || null,
      first_name: form.participantName || null,
      last_name: form.participantLastname || null,
      display_name: participantDisplayName,
    };
    payload.participant_snapshot_payload = {
      ...(detail?.participant_snapshot_payload || {}),
      first_name: form.participantName || null,
      last_name: form.participantLastname || null,
      display_name: participantDisplayName,
    };
  }
  if (mode === "event_category") {
    payload.event_id = Number(form.event_id);
    payload.event_name = form.evento_distancia;
    payload.category_id = Number(form.category_id);
    payload.category_name = form.categoria;
    payload.gender = form.genero;
    payload.participant_snapshot_payload = {
      ...(detail?.participant_snapshot_payload || {}),
      event_id: Number(form.event_id),
      event_name: form.evento_distancia,
      category_id: Number(form.category_id),
      category_name: form.categoria,
      gender: form.genero,
    };
  }
  if (!Object.keys(payload).length) throw new Error("No hay cambios de resultado para aplicar.");

  const request = {
    method: "PATCH",
    path: `/timing/api/v1/results/${resultId}`,
    data: payload,
  };
  const saved = await apiRequest(request);
  const verificationDetail = firstDetail(await getResultDetail({ resultId }));
  if (mode === "event_category") {
    const after = summarizeResultDetail(verificationDetail);
    if (
      normalizeText(after.evento_distancia) !== normalizeText(form.evento_distancia) ||
      normalizeText(after.genero) !== normalizeText(form.genero) ||
      normalizeText(after.categoria) !== normalizeText(form.categoria)
    ) {
      throw new Error("El resultado se guardo, pero la verificacion posterior no coincide con la combinacion solicitada.");
    }
  }

  return {
    ...buildAudit({ method: request.method, path: request.path, payload: request.data, response: saved }),
    ...(resolvedEvent
      ? {
          combineData: resolvedEvent.combineData,
          resolvedCombination: resolvedEvent.resolvedCombination,
          verification: summarizeResultDetail(verificationDetail),
        }
      : { verification: summarizeResultDetail(verificationDetail) }),
    saved,
    changed: {
      competitionId: pickCompetitionId(input),
      resultId,
      mode,
      before: summarizeResultDetail(detail),
      after: payload,
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
  const resolvedInput = await resolveCompetitionInput(input);
  const request = { path: `/timing/api/v1/results/validate/${pickCompetitionId(resolvedInput)}/` };
  const response = await apiRequest(request);
  return {
    ...buildAudit({ path: request.path, response }),
    data: response,
  };
}

async function getRaws(input) {
  const resolvedInput = await resolveCompetitionInput(input);
  const competitionId = pickCompetitionId(resolvedInput);
  const request = {
    path: `/timing/api/v1/raws/by-competition/${competitionId}/`,
    params: { limit: 500, offset: 0 },
  };
  const response = await requestAllPages(request.path);
  return {
    ...buildAudit({ path: request.path, params: request.params, response }),
    data: response,
  };
}

async function createManualRaw(input) {
  const normalizedInput = await resolveCompetitionInput(normalizeDorsalReferences(input));
  const competitionId = pickCompetitionId(normalizedInput);
  const dorsal = normalizedInput.dorsal || normalizedInput.bib;
  if (!dorsal) throw new Error("Falta dorsal.");
  if (!normalizedInput.hour) throw new Error("Falta hour en formato DD/MM/YYYY HH:mm:ss.");

  const request = {
    method: "POST",
    path: "/timing/api/v1/raws/",
    data: {
      dorsal: String(dorsal),
      chip: String(normalizedInput.chip || dorsal),
      hour: normalizedInput.hour,
      zulu: normalizedInput.zulu || normalizedInput.hour,
      location: normalizedInput.location || "META",
      team_computer: normalizedInput.team_computer || `reader_${normalizedInput.location || "META"}_${competitionId}`,
      state: normalizedInput.state ?? false,
      competition_id: Number(competitionId),
    },
  };
  const response = await apiRequest(request);
  return {
    ...buildAudit({ method: request.method, path: request.path, payload: request.data, response }),
    ...response,
  };
}

async function updateStartTime(input) {
  const resolvedInput = await resolveCompetitionInput(input);
  const competitionId = pickCompetitionId(resolvedInput);
  const time = input.time || input.startTime;
  if (!/^\d{2}:\d{2}:\d{2}$/.test(String(time || ""))) {
    throw new Error("La hora debe tener formato HH:mm:ss.");
  }

  const request = {
    method: "PATCH",
    path: "/timing/api/v1/configs/start-waves/time",
    data: {
      time,
      name_output: input.name_output || input.outputName || input.salida || input.startName,
      event_name: input.event_name || input.eventName || input.distance,
      competition_id: Number(competitionId),
      ...(input.event_id || input.eventId ? { event_id: Number(input.event_id || input.eventId) } : {}),
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
    path: "/timing/api/v1/results/edit-times/",
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
  const trustAssessment = buildAthleteEvidenceTrustAssessment(input);
  if (trustAssessment.accepted) return true;

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
      input.finishTime ||
      ((input.activityStartDateTime || input.activityStartTime || input.gpsStartDateTime) &&
        (input.gpsElapsedTime || input.evidenceElapsedTime || input.requestedValue))
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

function indicatesMissingOfficialTime(input = {}, detail = {}) {
  const values = [
    input.currentValue,
    input.currentOfficialTime,
    input.officialTime,
    detail?.tiempo_oficial,
    detail?.officialTime,
    detail?.document?.time_TOTAL,
  ].filter((value) => value !== undefined && value !== null && String(value).trim() !== "");

  if (!values.length) return true;
  return values.some((value) => /no\s*(especificado|registrado|tiene)|sin\s*tiempo|n\/a|null/i.test(String(value)));
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
  const normalizedInput = await resolveCompetitionInput(normalizeDorsalReferences(input));
  const competitionId = pickCompetitionId(normalizedInput);
  const { resultId, detail } = await resolveResultForUpdate(normalizedInput);
  const trustAssessment = buildAthleteEvidenceTrustAssessment(normalizedInput, detail);
  if (trustAssessment.enabled && normalizedInput.preferActivityStartForGps == null) {
    normalizedInput.preferActivityStartForGps = true;
  }
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
  if (proposedSeconds == null) {
    throw new Error("Falta el tiempo propuesto para validar la correccion.");
  }
  if (officialSeconds == null) {
    if (!indicatesMissingOfficialTime(normalizedInput, detail)) {
      throw new Error("Falta el tiempo oficial para validar la diferencia.");
    }
  } else {
    const differenceSeconds = Math.abs(officialSeconds - proposedSeconds);
    if (differenceSeconds < minDifferenceSeconds) {
      throw new Error(`La diferencia con el tiempo oficial es menor a ${minDifferenceSeconds} segundos.`);
    }
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
    evidencePolicy: trustAssessment.enabled ? "TRUST_ATHLETE_EVIDENCE" : "STRICT_EVIDENCE",
    evidenceTrustAssessment: trustAssessment,
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
      endpoint: "/timing/api/v1/raws/",
      payload: rawPayload,
      response: rawResponse,
    },
    edit: {
      endpoint: "/timing/api/v1/results/edit-times/",
      payload: editPayload,
      response: editResponse,
    },
  };
}

async function getConnectedReaders() {
  return apiRequest({ path: "/timing/api/v1/devices/active-channels" });
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
  EXOTIMER_UPDATE_INSCRIPTION_EVENT_CATEGORY: updateInscriptionEventCategory,
  EXOTIMER_RESEND_INSCRIPTION_CONFIRMATION: resendInscriptionConfirmation,
  EXOTIMER_SEND_INSCRIPTION_CONFIRMATION_WHATSAPP: sendInscriptionConfirmationWhatsApp,
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
  EXOTIMER_CREATE_COMPETITION_FROM_BASES: createCompetitionFromBases,
  EXOTIMER_CREATE_COMPETITION_FROM_CHAT: createCompetitionFromChat,
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
