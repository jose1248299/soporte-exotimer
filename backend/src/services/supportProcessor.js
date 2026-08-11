const crypto = require("node:crypto");
const prisma = require("../lib/prisma");
const config = require("../config");
const {
  analyzeDocumentEvidence,
  analyzeImageEvidence,
  classifyMessage,
  composeReply,
} = require("./ai");
const { executeAction, requiresConfirmation } = require("./exotimerClient");
const { getPolicy } = require("./supportPolicies");
const { sendNewMessageNotification } = require("./pushNotifications");
const { findOrCreateSupportCase, pickCompetitionId } = require("./supportCases");
const { downloadMedia, sendTextMessage } = require("./waba");
const { normalizeDorsalReferences } = require("../utils/dorsal");
const { normalizePhone } = require("../utils/phone");
const {
  isWhatsappUserId,
  normalizeWhatsappRecipient,
  normalizeWhatsappUserId,
  whatsappConversationRecipient,
} = require("../utils/whatsapp");

const replyDebounceTimers = new Map();
const processorStartedAt = new Date();

async function findOrCreateConversation({
  phone,
  whatsappUserId,
  displayName,
  channel = "WHATSAPP",
  userType,
  touchLastMessageAt = true,
}) {
  const stableUserId =
    channel === "WHATSAPP"
      ? normalizeWhatsappUserId(whatsappUserId)
      : "";
  const address =
    channel === "WHATSAPP" ? normalizeWhatsappRecipient(phone) : phone;
  if (!address && !stableUserId) {
    throw new Error("La conversacion no tiene un identificador de remitente valido.");
  }

  let existing = stableUserId
    ? await prisma.conversation.findUnique({
        where: {
          channel_whatsappUserId: {
            channel,
            whatsappUserId: stableUserId,
          },
        },
      })
    : null;
  let conversationPhone = address || stableUserId;

  if (!existing && address) {
    existing = await prisma.conversation.findUnique({
      where: { channel_phone: { channel, phone: address } },
    });
    if (
      existing?.whatsappUserId &&
      stableUserId &&
      existing.whatsappUserId !== stableUserId
    ) {
      existing = null;
      conversationPhone = stableUserId;
    }
  }

  if (!existing) {
    try {
      return await prisma.conversation.create({
        data: {
          channel,
          phone: conversationPhone,
          whatsappUserId: stableUserId || undefined,
          displayName,
          userType: userType || undefined,
          lastMessageAt: new Date(),
        },
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      existing = stableUserId
        ? await prisma.conversation.findUnique({
            where: {
              channel_whatsappUserId: {
                channel,
                whatsappUserId: stableUserId,
              },
            },
          })
        : null;
      if (!existing) {
        existing = await prisma.conversation.findUnique({
          where: { channel_phone: { channel, phone: conversationPhone } },
        });
      }
      if (!existing) throw error;
    }
  }

  return prisma.conversation.update({
    where: { id: existing.id },
    data: {
      displayName: displayName || undefined,
      whatsappUserId:
        stableUserId && !existing.whatsappUserId
          ? stableUserId
          : undefined,
      userType:
        channel === "EXOTIMER" && userType === "SYSTEM_USER"
          ? "SYSTEM_USER"
          : existing.userType === "UNKNOWN" && userType
            ? userType
            : undefined,
      lastMessageAt: touchLastMessageAt ? new Date() : undefined,
    },
  });
}

function buildExotimerContextText(message, conversation) {
  if (!message || conversation?.channel !== "EXOTIMER") return "";
  const context = message.rawPayload?.context || {};
  const items = [
    message.competitionId ? `competitionId=${message.competitionId}` : "",
    context.page ? `page=${context.page}` : "",
    context.section ? `section=${context.section}` : "",
  ].filter(Boolean);

  return items.length ? `Contexto ExoTimer: ${items.join(", ")}.` : "";
}

function buildExotimerConversationPhone({ competitionId, userId }) {
  return `exotimer:${competitionId}:${String(userId || "unknown").trim() || "unknown"}`;
}

function normalizeExotimerUserType(userRole) {
  const role = String(userRole || "").toUpperCase();
  if (role === "SYSTEM_USER") return "SYSTEM_USER";
  if (["ADMIN", "SUPER_ADMIN", "STAFF", "ORGANIZER", "TIMER"].includes(role)) return "SYSTEM_USER";
  return "SYSTEM_USER";
}

function compactMessage(message) {
  return {
    direction: message.direction,
    content: message.content,
    contentType: message.contentType,
    mediaAnalysis: message.mediaAnalysis,
    timestamp: message.timestamp,
  };
}

function mergeActionInput(previousInput = {}, nextInput = {}) {
  const identityKeys = [
    "inscriptionId",
    "inscription_id",
    "inscriptionReference",
    "reference",
    "codigoInscripcion",
    "codigo",
    "pk",
    "document",
    "dni",
    "identityDocument",
    "email",
    "expectedEmail",
    "phone",
    "telefono",
    "celular",
    "participantName",
    "athleteName",
  ];
  const normalizeIdentity = (value) =>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9@]+/gi, "")
      .toLowerCase();
  const identityChanged = identityKeys.some(
    (key) =>
      nextInput[key] != null &&
      previousInput[key] != null &&
      normalizeIdentity(nextInput[key]) !== normalizeIdentity(previousInput[key])
  );
  const safePrevious = identityChanged
    ? Object.fromEntries(
        Object.entries(previousInput).filter(
          ([key]) => !identityKeys.includes(key)
        )
      )
    : previousInput;
  const merged = {
    ...safePrevious,
    ...nextInput,
  };
  if (nextInput.competitionId || nextInput.competition_id || nextInput.competition) {
    delete merged.missingFields;
  }

  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function stableActionValue(value) {
  if (Array.isArray(value)) return value.map(stableActionValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter(
          (key) =>
            ![
              "confirmed",
              "forceRetry",
              "missingFields",
              "policy",
              "_idempotencyKey",
            ].includes(key)
        )
        .sort()
        .map((key) => [key, stableActionValue(value[key])])
    );
  }
  return value;
}

function actionIdempotencyKey(actionName, input = {}) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        actionName,
        input: stableActionValue(input),
      })
    )
    .digest("hex")
    .slice(0, 32);
}

const IDEMPOTENT_ACTIONS = new Set([
  "EXOTIMER_CREATE_RESULT_CORRECTION_CASE",
  "EXOTIMER_VALIDATE_PAYMENT_EVIDENCE",
  "EXOTIMER_UPDATE_INSCRIPTION_EMAIL",
  "EXOTIMER_UPDATE_INSCRIPTION_EVENT_CATEGORY",
  "EXOTIMER_RESEND_INSCRIPTION_CONFIRMATION",
  "EXOTIMER_SEND_INSCRIPTION_CONFIRMATION_WHATSAPP",
  "EXOTIMER_UPDATE_RESULT_PARTICIPANT_DATA",
  "EXOTIMER_UPDATE_RESULT_DORSAL",
  "EXOTIMER_UPDATE_RESULT_EVENT_CATEGORY",
  "EXOTIMER_CREATE_MANUAL_RAW",
  "EXOTIMER_EDIT_RESULT_TIME",
  "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION",
]);

function storedActionOutput(actionName, input = {}, result) {
  if (Array.isArray(result)) {
    const endpointByAction = {
      EXOTIMER_GET_TICKETS: "/registration/api/v1/tickets/",
      EXOTIMER_GET_RESULTS: "/timing/api/v1/results/admin/",
      EXOTIMER_GET_COMPETITION_EVENTS: "/catalog/api/v1/events/",
    };
    const endpoint = endpointByAction[actionName];
    return {
      ...(endpoint
        ? {
            request: {
              method: "GET",
              endpoint,
              params: {
                competition_id:
                  result[0]?.competition_id ||
                  input.competitionId ||
                  input.competition_id ||
                  null,
              },
            },
          }
        : {}),
      response: { count: result.length },
      data: result,
    };
  }
  if (
    result &&
    typeof result === "object" &&
    !result.request &&
    result.lookup?.request
  ) {
    return {
      ...result,
      request: result.lookup.request,
    };
  }
  return result;
}

function isUnverifiedTimeCorrection(classification = {}, actionResult = null) {
  return Boolean(
    classification.action ===
      "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION" &&
      actionResult?.created &&
      actionResult?.verification?.verified !== true
  );
}

function enforceVerifiedActionReply({ reply, classification, actionResult }) {
  if (!isUnverifiedTimeCorrection(classification, actionResult)) return reply;

  const requestedTime =
    actionResult?.changed?.requestedOfficialTime ||
    actionResult?.changed?.computedTimeCurrent ||
    classification?.actionInput?.requestedValue ||
    null;
  const observedTime = actionResult?.verification?.officialTime || null;
  const comparison = [
    requestedTime ? `tiempo solicitado ${requestedTime}` : null,
    observedTime ? `tiempo observado ${observedTime}` : null,
  ]
    .filter(Boolean)
    .join(" y ");

  return [
    "La correccion se proceso, pero la verificacion final del resultado no coincide todavia.",
    comparison ? `La lectura posterior muestra ${comparison}.` : null,
    "El caso quedo pendiente de revision humana y no necesitas enviar mas evidencia por ahora.",
  ]
    .filter(Boolean)
    .join(" ");
}

function planComparableValue(plan) {
  if (!plan || typeof plan !== "object") return null;
  return stableActionValue({
    ...plan,
    fingerprint: undefined,
    readyToApply: undefined,
    missingFields: undefined,
    warnings: undefined,
    duplicates: undefined,
  });
}

function competitionPlanOverrides(plan = {}) {
  const competition = plan.competition || {};
  const planName = (value) =>
    value && typeof value === "object" ? value.name : value;
  const startTime =
    String(competition.startAt || "").match(/T(\d{2}:\d{2})/)?.[1] || null;
  const endTime =
    String(competition.endAt || "").match(/T(\d{2}:\d{2})/)?.[1] || null;
  return Object.fromEntries(
    Object.entries({
      competitionName: competition.name,
      eventDate: competition.date,
      startTime,
      endTime,
      venueName: competition.venueName,
      country: planName(competition.country),
      city: planName(competition.city),
      sport: planName(competition.sport),
      organizer: planName(competition.organizer),
      status: competition.status,
      visibility: competition.visibility,
      website: competition.website,
      registrationDeadline: competition.registrationDeadline,
      events: plan.events,
      tickets: plan.tickets,
      payment: plan.payment,
      format: plan.rules?.format,
      workoutOrder: plan.rules?.workoutOrder,
      waveSize: plan.rules?.waveSize,
      rulesSummary: plan.rules?.notes,
      bannerMessageId: plan.media?.bannerMessageId,
      basesMessageId: plan.media?.basesMessageId,
    }).filter(([, value]) => value !== undefined && value !== null)
  );
}

async function prepareCompetitionSetupClassification(
  conversation,
  classification
) {
  if (
    ![
      "EXOTIMER_PREVIEW_COMPETITION_SETUP",
      "EXOTIMER_APPLY_COMPETITION_SETUP",
    ].includes(classification.action)
  ) {
    return classification;
  }

  const recentPreviews = await prisma.supportAction.findMany({
    where: {
      conversationId: conversation.id,
      name: "EXOTIMER_PREVIEW_COMPETITION_SETUP",
      status: "EXECUTED",
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, output: true },
  });
  const lastPreview = recentPreviews.find(
    (action) => action.output?.plan
  )?.output?.plan;
  const lastReadyPlan = recentPreviews.find(
    (action) =>
      action.output?.readyToApply === true &&
      action.output?.plan?.readyToApply === true
  )?.output?.plan;
  const proposedPlan = classification.actionInput?.plan;

  if (classification.action === "EXOTIMER_APPLY_COMPETITION_SETUP") {
    const proposedMatchesStored =
      !proposedPlan ||
      (lastReadyPlan &&
        JSON.stringify(planComparableValue(proposedPlan)) ===
          JSON.stringify(planComparableValue(lastReadyPlan)));
    if (lastReadyPlan && proposedMatchesStored) {
      return {
        ...classification,
        actionInput: {
          ...(classification.actionInput || {}),
          plan: lastReadyPlan,
          confirmed: true,
        },
      };
    }

    return {
      ...classification,
      action: "EXOTIMER_PREVIEW_COMPETITION_SETUP",
      needsHuman: false,
      actionInput: {
        ...(classification.actionInput || {}),
        ...(proposedPlan ? competitionPlanOverrides(proposedPlan) : {}),
        ...(lastPreview ? { plan: lastPreview } : {}),
        confirmed: false,
      },
      summary: `${classification.summary || ""} Se regenerara un preview real antes de aplicar cambios.`.trim(),
    };
  }

  if (!proposedPlan) return classification;
  const proposedMatchesStored =
    lastPreview &&
    JSON.stringify(planComparableValue(proposedPlan)) ===
      JSON.stringify(planComparableValue(lastPreview));
  if (proposedMatchesStored) return classification;

  return {
    ...classification,
    actionInput: {
      ...(classification.actionInput || {}),
      ...competitionPlanOverrides(proposedPlan),
      ...(lastPreview ? { plan: lastPreview } : { plan: undefined }),
    },
  };
}

function mergeClassificationWithConversation(classification, conversation) {
  const previous = conversation.classification || {};
  const previousInput = previous.actionInput || {};
  const nextInput = classification.actionInput || {};
  const mergedInput = mergeActionInput(previousInput, nextInput);
  const hasPreviousContext = previous.userType && previous.userType !== "UNKNOWN";

  if (classification.userType === "UNKNOWN" && hasPreviousContext) {
    return {
      ...classification,
      userType: previous.userType,
      confidence: Math.max(classification.confidence || 0, 0.7),
      intent: classification.intent === "unknown" ? previous.intent || classification.intent : classification.intent,
      summary: classification.summary || previous.summary,
      action: classification.action || previous.action || null,
      actionInput: normalizeDorsalReferences(mergedInput),
      needsHuman: classification.needsHuman || previous.needsHuman || false,
    };
  }

  return {
    ...classification,
    actionInput: normalizeDorsalReferences(mergedInput),
  };
}

function actionNeedsCompetitionId(actionName) {
  return [
    "EXOTIMER_GET_COMPETITION_EVENTS",
    "EXOTIMER_GET_TICKETS",
    "EXOTIMER_GET_INSCRIPTION",
    "EXOTIMER_GET_INSCRIPTION_BY_REFERENCE_OR_DOCUMENT",
    "EXOTIMER_VALIDATE_PAYMENT_EVIDENCE",
    "EXOTIMER_UPDATE_INSCRIPTION_EMAIL",
    "EXOTIMER_UPDATE_INSCRIPTION_EVENT_CATEGORY",
    "EXOTIMER_RESEND_INSCRIPTION_CONFIRMATION",
    "EXOTIMER_SEND_INSCRIPTION_CONFIRMATION_WHATSAPP",
    "EXOTIMER_GET_RESULTS",
    "EXOTIMER_UPDATE_RESULT_PARTICIPANT_DATA",
    "EXOTIMER_UPDATE_RESULT_DORSAL",
    "EXOTIMER_UPDATE_RESULT_EVENT_CATEGORY",
    "EXOTIMER_VALIDATE_PRE_RACE",
    "EXOTIMER_GET_RAWS",
    "EXOTIMER_CREATE_MANUAL_RAW",
    "EXOTIMER_UPDATE_START_TIME",
    "EXOTIMER_UPDATE_EVENT_TICKET",
    "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION",
  ].includes(actionName);
}

async function resolveCompetitionForAction(userType, classification) {
  const input = classification.actionInput || {};
  if (!classification.action || !actionNeedsCompetitionId(classification.action)) {
    return { classification, contextActionResult: null, contextActionError: null };
  }

  if (input.competitionId || input.competition_id || input.competition) {
    return { classification, contextActionResult: null, contextActionError: null };
  }

  const competitionName = input.competitionName || input.name || input.query;
  if (!competitionName) {
    return { classification, contextActionResult: null, contextActionError: null };
  }

  try {
    const result = await executeAction(userType, "EXOTIMER_FIND_COMPETITION", { competitionName }, { allowByPolicy: true });
    if (!result?.match?.id) {
      return { classification, contextActionResult: result, contextActionError: null };
    }

    return {
      classification: {
        ...classification,
        actionInput: {
          ...input,
          competitionId: result.match.id,
          competitionName: result.match.name || competitionName,
        },
      },
      contextActionResult: {
        action: "EXOTIMER_FIND_COMPETITION",
        result,
      },
      contextActionError: null,
    };
  } catch (error) {
    return { classification, contextActionResult: null, contextActionError: error.message };
  }
}

function hasMinimumCorrectionContext(input = {}) {
  const hasCompetition = Boolean(input.competitionId || input.competition_id || input.competitionName);
  const hasPerson = Boolean(input.dorsal || input.bib || input.athleteName || input.name);
  return hasCompetition && hasPerson;
}

function missingFieldsForAction(actionName, input = {}) {
  const missing = [];
  const hasCompetition = Boolean(input.competitionId || input.competition_id || input.competition);
  const hasCompetitionName = Boolean(input.competitionName || input.name || input.query);
  const resultUpdateActions = [
    "EXOTIMER_UPDATE_RESULT_PARTICIPANT_DATA",
    "EXOTIMER_UPDATE_RESULT_DORSAL",
    "EXOTIMER_UPDATE_RESULT_EVENT_CATEGORY",
  ];

  if (actionNeedsCompetitionId(actionName) && !hasCompetition) {
    missing.push(hasCompetitionName ? "competitionId_resolved_from_name" : "competitionName");
  }

  if (actionName === "EXOTIMER_GET_INSCRIPTION" && !(input.dorsal || input.bib)) {
    missing.push("dorsal");
  }

  if (
    [
      "EXOTIMER_GET_INSCRIPTION_BY_REFERENCE_OR_DOCUMENT",
      "EXOTIMER_VALIDATE_PAYMENT_EVIDENCE",
      "EXOTIMER_UPDATE_INSCRIPTION_EMAIL",
      "EXOTIMER_UPDATE_INSCRIPTION_EVENT_CATEGORY",
      "EXOTIMER_RESEND_INSCRIPTION_CONFIRMATION",
      "EXOTIMER_SEND_INSCRIPTION_CONFIRMATION_WHATSAPP",
    ].includes(actionName)
  ) {
    const hasLookupReference = Boolean(
      input.inscriptionId ||
        input.inscription_id ||
        input.inscriptionReference ||
        input.reference ||
        input.codigoInscripcion ||
        input.codigo ||
        input.pk ||
        input.document ||
        input.dni ||
        input.identityDocument ||
        input.email ||
        input.expectedEmail ||
        input.correctEmail ||
        input.requestedEmail ||
        input.phone ||
        input.telefono ||
        input.celular ||
        input.participantName ||
        input.athleteName ||
        input.name
    );
    if (!hasLookupReference) missing.push("inscription_reference_or_document");

    if (actionName === "EXOTIMER_UPDATE_INSCRIPTION_EMAIL") {
      const hasNewEmail = Boolean(input.newEmail || input.correctEmail || input.requestedEmail || input.email);
      if (!hasNewEmail) missing.push("newEmail");
    }

    if (actionName === "EXOTIMER_UPDATE_INSCRIPTION_EVENT_CATEGORY") {
      const hasInscriptionEventPatch = Boolean(
        input.newDistance ||
          input.distanceNew ||
          input.distancia ||
          input.requestedDistance ||
          input.newGender ||
          input.genderNew ||
          input.genero ||
          input.requestedGender ||
          input.newCategory ||
          input.categoryNew ||
          input.categoria ||
          input.requestedCategory ||
          input.requestedValue ||
          input.newValue
      );
      if (!hasInscriptionEventPatch) missing.push("distance_gender_or_category");
    }
  }

  if (resultUpdateActions.includes(actionName)) {
    const hasResultReference = Boolean(
      input.resultId ||
        input.result_id ||
        input.id ||
        input.dorsal ||
        input.bib ||
        input.currentDorsal ||
        input.oldDorsal ||
        input.previousDorsal
    );
    if (!hasResultReference) missing.push("dorsal_or_resultId");

    if (actionName === "EXOTIMER_UPDATE_RESULT_DORSAL") {
      const hasNewDorsal = Boolean(input.newDorsal || input.dorsalNew || input.correctDorsal || input.requestedValue || input.newValue);
      if (!hasNewDorsal) missing.push("newDorsal");
    }

    if (actionName === "EXOTIMER_UPDATE_RESULT_EVENT_CATEGORY") {
      const hasEventPatch = Boolean(
        input.newDistance ||
          input.distanceNew ||
          input.evento_distancia ||
          input.newGender ||
          input.genderNew ||
          input.genero ||
          input.newCategory ||
          input.categoryNew ||
          input.categoria ||
          input.requestedValue ||
          input.newValue
      );
      if (!hasEventPatch) missing.push("distance_gender_or_category");
    }

    if (actionName === "EXOTIMER_UPDATE_RESULT_PARTICIPANT_DATA") {
      const hasParticipantPatch = Boolean(
        input.participantName ||
          input.athleteName ||
          input.nameNew ||
          input.firstName ||
          input.participantLastname ||
          input.lastnameNew ||
          input.lastName ||
          input.lastname ||
          input.requestedValue ||
          input.newValue
      );
      if (!hasParticipantPatch) missing.push("participantData");
    }
  }

  if (actionName === "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION") {
    const hasResultReference = Boolean(
      input.resultId ||
        input.result_id ||
        input.id ||
        input.dorsal ||
        input.bib ||
        input.currentDorsal ||
        input.oldDorsal ||
        input.previousDorsal
    );
    const hasEvidenceFinishTime = Boolean(
      input.evidenceFinishDateTime ||
        input.evidenceMetaDateTime ||
        input.evidenceFinishTime ||
        input.evidenceMetaTime ||
        input.horaMeta ||
        input.metaTime ||
        input.finishTime ||
        ((input.activityStartDateTime || input.activityStartTime) && (input.gpsElapsedTime || input.evidenceElapsedTime || input.requestedValue)) ||
        (input.trustAthleteEvidence === true && (input.gpsElapsedTime || input.evidenceElapsedTime || input.requestedValue)) ||
        (String(input.evidencePolicy || input.policyMode || "").toUpperCase() === "TRUST_ATHLETE_EVIDENCE" &&
          (input.gpsElapsedTime || input.evidenceElapsedTime || input.requestedValue))
    );
    if (!hasResultReference) missing.push("dorsal_or_resultId");
    if (!hasEvidenceFinishTime) missing.push("evidenceFinishTime");
  }

  if (
    [
      "EXOTIMER_APPLY_COMPETITION_SETUP",
      "EXOTIMER_CREATE_COMPETITION_FROM_BASES",
      "EXOTIMER_CREATE_COMPETITION_FROM_CHAT",
    ].includes(actionName) &&
    !input.plan?.readyToApply
  ) {
    const extracted = input.mediaAnalysis?.extracted || input.imageAnalysis?.extracted || {};
    const hasName = Boolean(input.competitionName || input.eventName || input.name || extracted.competitionName || extracted.eventName || extracted.name);
    const hasDate = Boolean(input.date || input.eventDate || input.competitionDate || extracted.eventDate || extracted.date || extracted.competitionDate);
    const hasCity = Boolean(input.city || input.cityName || extracted.city || extracted.cityName);
    const hasDistances = Boolean(
      input.distances ||
        input.distanceOptions ||
        input.distance ||
        input.distancia ||
        extracted.distances ||
        extracted.distanceOptions ||
        extracted.distance
    );

    if (!hasName) missing.push("competitionName");
    if (!hasDate) missing.push("eventDate");
    if (!hasCity) missing.push("city");
    if (!hasDistances) missing.push("distances");
  }

  return missing;
}

function isResultFollowUpMessage(text = "", classification = {}) {
  const normalized = String(`${text} ${classification.intent || ""} ${classification.summary || ""}`)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /(novedad|seguimiento|estado|avance|respuesta|ya.*revis|sigue|actualiz|mi caso|requesta|reclamo)/.test(normalized);
}

function normalizeDuration(value) {
  const match = String(value || "").trim().match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const seconds = match[3] === undefined
    ? Number(match[1]) * 60 + Number(match[2])
    : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [hours, minutes, remainingSeconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function formatOfficialMilliseconds(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function pickResultOfficialTime(result = {}) {
  const direct = [
    result.tiempo_oficial,
    result.officialTime,
    result.official_time,
    result.time,
    result.tiempo,
    result.document?.time_TOTAL,
    result.display_document?.time_TOTAL,
  ]
    .map(normalizeDuration)
    .find(Boolean);
  return direct || formatOfficialMilliseconds(result.official_time_ms);
}

function pickResultFinishTime(result = {}) {
  return (
    result.hora_meta ||
    result.finishTime ||
    result.finish_time ||
    result.finish_at ||
    result.metaTime ||
    null
  );
}

function summarizeResultForClosure(result = {}) {
  const participant = result.participant || {};
  const event = result.event || {};
  const category = event.category || {};
  return {
    resultId: result.id || result.result_id || result.resultId,
    dorsal: result.dorsal ?? result.bib,
    chip: result.chip,
    athleteName:
      participant.name ||
      participant.first_name ||
      result.participantName ||
      result.athleteName ||
      result.participant_display_name ||
      result.name ||
      null,
    athleteLastname:
      participant.lastname ||
      participant.last_name ||
      result.participantLastname ||
      result.lastname ||
      null,
    distance:
      event.name ||
      result.event_name ||
      result.evento_distancia ||
      result.salida ||
      result.distance ||
      null,
    gender: category.genre || category.gender_rule || result.genero || result.gender || null,
    category: category.name || result.category_name || result.categoria || result.category || null,
    officialTime: pickResultOfficialTime(result),
    finishTime: pickResultFinishTime(result),
    state: result.state || null,
  };
}

function resultHasPublishedTime(result = {}) {
  const officialTime = pickResultOfficialTime(result);
  if (officialTime) return true;
  const state = String(result.state || result.status || "").toLowerCase();
  return Boolean(
    pickResultFinishTime(result) &&
      ["finalizado", "finished", "completed"].includes(state)
  );
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && String(value).trim()).map((value) => String(value).trim()))];
}

function normalizeDorsalValue(value) {
  return normalizeDorsalReferences({ dorsal: value }).dorsal || null;
}

function findResultByDorsals(rows, dorsals) {
  const targets = new Set(dorsals.map(normalizeDorsalValue).filter(Boolean).map(String));
  return rows.find((row) => {
    const rowDorsal = normalizeDorsalValue(row.dorsal ?? row.bib);
    const rowChip = normalizeDorsalValue(row.chip);
    return [rowDorsal, rowChip].some((value) => value && targets.has(String(value)));
  });
}

function isMissingResultClaim(text = "", classification = {}) {
  const input = classification.actionInput || {};
  const normalized = String(
    [
      text,
      classification.intent,
      classification.summary,
      input.requestedCorrection,
      input.caseType,
      input.currentValue,
    ]
      .filter(Boolean)
      .join(" ")
  )
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return /crear participante|participante nuevo|crear (?:un )?resultado|no (?:me )?(?:aparece|sale|figura)|resultado (?:no|sin)|sin (?:resultado|tiempo)|tiempo (?:no|sin).*(?:public|registr|apare|sal)/.test(
    normalized
  );
}

function shouldPromoteTrustedTimeCorrection(classification, result) {
  if (classification.action !== "EXOTIMER_CREATE_RESULT_CORRECTION_CASE") return false;
  if (resultHasPublishedTime(result)) return false;

  const input = classification.actionInput || {};
  const trustEnabled =
    input.trustAthleteEvidence === true ||
    input.TRUST_ATHLETE_EVIDENCE === true ||
    String(input.evidencePolicy || input.policyMode || "").toUpperCase() ===
      "TRUST_ATHLETE_EVIDENCE";
  const hasStructuredClaim = Boolean(
    (input.competitionId || input.competition_id || input.competition) &&
      (input.dorsal || input.bib || input.currentDorsal) &&
      (input.athleteName || input.participantName)
  );
  const hasElapsedTime = Boolean(
    normalizeDuration(
      input.gpsElapsedTime ||
        input.evidenceElapsedTime ||
        input.requestedValue
    )
  );
  const evidenceText = String(
    [input.evidenceSummary, input.evidence, classification.summary]
      .filter(Boolean)
      .join(" ")
  ).toLowerCase();
  const hasObjectiveEvidence =
    Boolean(input.hasStrongEvidence) ||
    /(gps|adidas|garmin|strava|reloj|actividad|distancia|captura|imagen|foto)/.test(
      evidenceText
    );

  return trustEnabled && hasStructuredClaim && hasElapsedTime && hasObjectiveEvidence;
}

async function inspectAthleteResultPreflight({
  supportCase,
  classification,
  text,
  userType,
  execute = executeAction,
}) {
  const input = classification.actionInput || {};
  if (classification.userType !== "ATHLETE" && userType !== "ATHLETE") {
    return { classification, audit: null, resolution: null, promoted: false };
  }
  if (classification.action !== "EXOTIMER_CREATE_RESULT_CORRECTION_CASE") {
    return { classification, audit: null, resolution: null, promoted: false };
  }

  const competitionId = input.competitionId || input.competition_id || supportCase?.competitionId;
  const dorsals = uniqueStrings([
    input.dorsal,
    input.bib,
    input.currentDorsal,
    input.oldDorsal,
    input.previousDorsal,
    ...(Array.isArray(input.detectedDorsals) ? input.detectedDorsals : []),
  ]);
  const requestedDorsals = uniqueStrings([input.newDorsal, input.dorsalNew, input.correctDorsal, input.requestedDorsal]);
  if (!competitionId || (!dorsals.length && !requestedDorsals.length)) {
    return { classification, audit: null, resolution: null, promoted: false };
  }

  const lookupDorsals = uniqueStrings([...requestedDorsals, ...dorsals]);
  const lookupDorsal = lookupDorsals[0];
  const list = await execute(
    userType,
    "EXOTIMER_GET_RESULTS",
    {
      competitionId,
      dorsal: lookupDorsal,
      detectedDorsals: lookupDorsals,
    },
    { allowByPolicy: true }
  );
  const rows = Array.isArray(list) ? list : list?.results || list?.data || [];
  const currentResult = findResultByDorsals(rows, dorsals);
  const requestedResult = findResultByDorsals(rows, requestedDorsals);
  const result = requestedResult || currentResult;
  const baseAudit = {
    type: "RESULT_PREFLIGHT",
    request: {
      method: "GET",
      endpoint: "/timing/api/v1/results/admin/",
      params: {
        competition_id: Number(competitionId),
        dorsals: lookupDorsals.map(String),
      },
    },
    response: {
      found: Boolean(result),
      matches: rows.length,
      result: result ? summarizeResultForClosure(result) : null,
    },
  };
  if (!result) {
    return {
      classification,
      audit: baseAudit,
      resolution: null,
      promoted: false,
    };
  }

  const resultId = result.id || result.result_id || result.resultId;
  let detail = result;
  if (resultId) {
    try {
      detail = await execute(
        userType,
        "EXOTIMER_GET_RESULT_DETAIL",
        { resultId },
        { allowByPolicy: true }
      );
    } catch {
      detail = result;
    }
  }

  const summary = summarizeResultForClosure(detail);
  const enrichedAudit = {
    ...baseAudit,
    response: {
      ...baseAudit.response,
      result: summary,
    },
  };
  const enrichedInput = {
    ...input,
    resultId: summary.resultId || resultId,
    currentValue: summary.officialTime || input.currentValue || null,
    currentOfficialTime: summary.officialTime || null,
    currentState: summary.state,
  };

  if (
    shouldPromoteTrustedTimeCorrection(
      { ...classification, actionInput: enrichedInput },
      detail
    )
  ) {
    return {
      classification: {
        ...classification,
        action: "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION",
        actionInput: enrichedInput,
        needsHuman: false,
        summary: `${classification.summary} El preflight encontro el resultado sin tiempo y habilito la correccion con evidencia acumulada.`,
      },
      audit: {
        ...enrichedAudit,
        response: {
          ...enrichedAudit.response,
          decision: "promote_time_evidence_correction",
        },
      },
      resolution: null,
      promoted: true,
    };
  }

  if (
    !resultHasPublishedTime(detail) ||
    (!isResultFollowUpMessage(text, classification) &&
      !isMissingResultClaim(text, classification))
  ) {
    return {
      classification: {
        ...classification,
        actionInput: enrichedInput,
      },
      audit: enrichedAudit,
      resolution: null,
      promoted: false,
    };
  }

  const requestedDorsal = requestedDorsals[0] || null;
  const actualDorsal = summary.dorsal != null ? String(summary.dorsal) : null;
  const hasPendingDorsalChange = Boolean(requestedDorsal && actualDorsal && requestedDorsal !== actualDorsal);
  const resolutionType = hasPendingDorsalChange ? "RESULT_TIME_UPDATED_DORSAL_PENDING" : "RESULT_ALREADY_UPDATED";

  return {
    classification: {
      ...classification,
      action: null,
      actionInput: enrichedInput,
      needsHuman: hasPendingDorsalChange,
      summary: hasPendingDorsalChange
        ? `${classification.summary} El tiempo ya figura actualizado en ExoTimer, pero queda pendiente revisar el cambio de dorsal.`
        : `${classification.summary} El resultado ya figura actualizado en ExoTimer.`,
    },
    audit: {
      ...enrichedAudit,
      response: {
        ...enrichedAudit.response,
        decision: resolutionType,
      },
    },
    resolution: {
      type: resolutionType,
      action: "EXOTIMER_GET_RESULT_DETAIL",
      checkedAt: new Date().toISOString(),
      competitionId: String(competitionId),
      requestedDorsal,
      pendingDorsalChange: hasPendingDorsalChange
        ? {
            requestedDorsal,
            actualDorsal,
          }
        : null,
      result: summary,
    },
    promoted: false,
  };
}

async function persistResultPreflight({
  conversation,
  supportCase,
  triggerMessage,
  userType,
  preflight,
}) {
  if (preflight.audit) {
    await prisma.supportAction.create({
      data: {
        conversationId: conversation.id,
        supportCaseId: supportCase?.id || null,
        messageId: triggerMessage.id,
        userType,
        name: "EXOTIMER_GET_RESULTS",
        status: "EXECUTED",
        input: {
          source: "automatic_result_preflight",
          ...preflight.audit.request,
        },
        output: preflight.audit,
      },
    });
  }

  const resolution = preflight.resolution;
  if (!resolution) return;
  const hasPendingDorsalChange = Boolean(resolution.pendingDorsalChange);
  const requestedDorsal = resolution.requestedDorsal;
  const actualDorsal = resolution.result?.dorsal;

  if (supportCase?.id) {
    await prisma.supportCase.update({
      where: { id: supportCase.id },
      data: {
        status: hasPendingDorsalChange ? "WAITING_HUMAN" : "RESOLVED",
        summary: hasPendingDorsalChange
          ? `${supportCase.summary || ""} Tiempo verificado en ExoTimer; queda pendiente validar cambio de dorsal ${actualDorsal} -> ${requestedDorsal}.`.trim()
          : `${supportCase.summary || ""} Resultado verificado como actualizado en ExoTimer.`.trim(),
        lastMessageAt: new Date(),
      },
    });
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      status: hasPendingDorsalChange ? "WAITING_HUMAN" : "RESOLVED",
    },
  });
}

function buildImageAnalysisText(mediaAnalysis) {
  if (!mediaAnalysis) return "";
  const extracted = mediaAnalysis.extracted || {};
  const extractedText = Object.entries(extracted)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  const visibleText = Array.isArray(mediaAnalysis.visibleText) && mediaAnalysis.visibleText.length
    ? `Textos visibles: ${mediaAnalysis.visibleText.join(" | ")}.`
    : "";
  return [
    mediaAnalysis.summary ? `Analisis de imagen: ${mediaAnalysis.summary}.` : "",
    visibleText,
    extractedText ? `Datos extraidos: ${extractedText}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildProcessableText({ text, mediaAnalysis }) {
  return [text, buildImageAnalysisText(mediaAnalysis)].filter(Boolean).join("\n\n");
}

function inboundProcessableText(message) {
  return buildProcessableText({
    text: message.content,
    mediaAnalysis: message.mediaAnalysis,
  });
}

function buildCombinedProcessableText(messages) {
  return messages
    .filter((message) => message.direction === "INBOUND")
    .map((message) => inboundProcessableText(message))
    .filter(Boolean)
    .join("\n\n---\n\n");
}

async function findPendingInboundMessages(conversationId) {
  const lastOutbound = await prisma.message.findFirst({
    where: { conversationId, direction: "OUTBOUND" },
    orderBy: { timestamp: "desc" },
    select: { timestamp: true, createdAt: true },
  });

  const candidates = await prisma.message.findMany({
    where: {
      conversationId,
      direction: "INBOUND",
    },
    orderBy: { timestamp: "desc" },
    take: 50,
  });
  const pending = [...candidates]
    .reverse()
    .filter((message) => {
      if (message.aiMetadata?.debounceProcessedAt) return false;
      if (!lastOutbound) return true;
      if (message.timestamp > lastOutbound.timestamp) return true;
      return message.createdAt >= processorStartedAt;
    });

  return pending;
}

function scheduleConversationProcessing(conversationId) {
  const previous = replyDebounceTimers.get(conversationId);
  if (previous) clearTimeout(previous);

  const waitMs = Math.max(0, Number(config.support.replyDebounceMs || 8000));
  const timer = setTimeout(() => {
    replyDebounceTimers.delete(conversationId);
    processConversationReply(conversationId).catch((error) => {
      console.error(`Error procesando conversacion ${conversationId} tras debounce:`, error);
    });
  }, waitMs);

  if (typeof timer.unref === "function") timer.unref();
  replyDebounceTimers.set(conversationId, timer);
}

async function processInboundText(args) {
  return processInboundMessage({
    ...args,
    type: "text",
  });
}

async function processConversationReply(conversationId) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) return null;

  const isWhatsapp = conversation.channel === "WHATSAPP";
  const isExotimer = conversation.channel === "EXOTIMER";
  const trustedSystemUser = isExotimer;

  const timer = isWhatsapp
    ? await prisma.timerContact.findFirst({
        where: { phone: conversation.phone, active: true },
      })
    : null;

  const pendingInboundMessages = await findPendingInboundMessages(conversation.id);
  if (!pendingInboundMessages.length) return null;

  const recentMessages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { timestamp: "desc" },
    take: 12,
  });
  const history = [...recentMessages].reverse().map(compactMessage);
  const triggerMessage = pendingInboundMessages[pendingInboundMessages.length - 1];
  const contextText = buildExotimerContextText(triggerMessage, conversation);
  const processableText = [contextText, buildCombinedProcessableText(pendingInboundMessages)].filter(Boolean).join("\n\n");

  let classification = await classifyMessage({
    text: processableText,
    forcedTimer: Boolean(timer),
    previousClassification: conversation.classification,
    previousUserType: conversation.userType,
    conversationStatus: conversation.status,
    history,
    channel: conversation.channel,
    trustedSystemUser,
  });
  classification = mergeClassificationWithConversation(classification, conversation);
  if (trustedSystemUser) {
    classification = {
      ...classification,
      userType: "SYSTEM_USER",
      confidence: Math.max(classification.confidence || 0, 0.95),
    };
  }
  classification = {
    ...classification,
    actionInput: normalizeDorsalReferences(classification.actionInput || {}),
  };
  classification = await prepareCompetitionSetupClassification(
    conversation,
    classification
  );
  if (classification.actionInput?.confirmed === true) {
    classification = {
      ...classification,
      needsHuman: false,
    };
  }

  const userType = trustedSystemUser ? "SYSTEM_USER" : timer ? "TIMER" : classification.userType;
  const contextResolution = await resolveCompetitionForAction(userType, classification);
  classification = contextResolution.classification;

  const missingFields = missingFieldsForAction(classification.action, classification.actionInput);
  if (missingFields.length) {
    classification = {
      ...classification,
      action: null,
      needsHuman: false,
      actionInput: {
        ...(classification.actionInput || {}),
        missingFields,
      },
      summary: `${classification.summary} Faltan datos para ejecutar la accion automatica.`,
    };
  } else if (classification.actionInput?.missingFields) {
    const { missingFields: _missingFields, ...actionInput } = classification.actionInput;
    classification = {
      ...classification,
      actionInput,
    };
  }

  if (
    classification.action === "EXOTIMER_CREATE_RESULT_CORRECTION_CASE" &&
    !hasMinimumCorrectionContext(classification.actionInput)
  ) {
    classification = {
      ...classification,
      action: null,
      needsHuman: false,
      summary: `${classification.summary} Faltan datos minimos para registrar el caso.`,
    };
  }

  const supportCase = await findOrCreateSupportCase({
    conversationId: conversation.id,
    userType,
    classification,
    timestamp: triggerMessage.timestamp,
  });
  const competitionId = supportCase?.competitionId || pickCompetitionId(classification.actionInput) || (isExotimer ? triggerMessage.competitionId : null);

  if (supportCase || competitionId) {
    await prisma.message.updateMany({
      where: { id: { in: pendingInboundMessages.map((message) => message.id) } },
      data: {
        supportCaseId: supportCase?.id || null,
        competitionId,
      },
    });
  }

  await Promise.all(
    pendingInboundMessages.map((message) =>
      prisma.message.update({
        where: { id: message.id },
        data: {
          aiMetadata: {
            ...(message.aiMetadata || {}),
            debounceProcessedAt: new Date().toISOString(),
            debounceBatchLastMessageId: triggerMessage.id,
          },
        },
      })
    )
  );

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      userType,
      confidence: classification.confidence,
      classification,
      status: classification.needsHuman ? "WAITING_HUMAN" : "OPEN",
      lastMessageAt: triggerMessage.timestamp,
    },
  });

  let actionResult = null;
  let actionError = null;
  let actionPending = null;
  let contextActionResult = contextResolution.contextActionResult;
  let contextActionError = contextResolution.contextActionError;

  try {
    const preflight = await inspectAthleteResultPreflight({
      supportCase,
      classification,
      text: processableText,
      userType,
    });
    classification = preflight.classification;
    await persistResultPreflight({
      conversation,
      supportCase,
      triggerMessage,
      userType,
      preflight,
    });
    if (preflight.audit || preflight.resolution) {
      contextActionResult = {
        ...(contextActionResult || {}),
        resultPreflight: preflight.audit,
        ...(preflight.resolution
          ? { followUpResolution: preflight.resolution }
          : {}),
      };
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          classification,
          status:
            preflight.resolution && !preflight.resolution.pendingDorsalChange
              ? "RESOLVED"
              : classification.needsHuman
                ? "WAITING_HUMAN"
                : "OPEN",
        },
      });
    }
  } catch (error) {
    contextActionError = error.message;
  }

  if (classification.action) {
    const policy = await getPolicy(userType, classification.action);
    const idempotencyKey = actionIdempotencyKey(
      classification.action,
      classification.actionInput || {}
    );
    const duplicateAction =
      IDEMPOTENT_ACTIONS.has(classification.action) &&
      classification.actionInput?.forceRetry !== true
        ? await prisma.supportAction.findFirst({
            where: {
              conversationId: conversation.id,
              name: classification.action,
              status: { in: ["EXECUTED", "FAILED"] },
              createdAt: {
                gte: new Date(Date.now() - 10 * 60 * 1000),
              },
              input: {
                path: ["_idempotencyKey"],
                equals: idempotencyKey,
              },
            },
            orderBy: { createdAt: "desc" },
          })
        : null;
    const action = await prisma.supportAction.create({
      data: {
        conversationId: conversation.id,
        supportCaseId: supportCase?.id || null,
        messageId: triggerMessage.id,
        userType,
        name: classification.action,
        input: {
          ...(classification.actionInput || {}),
          _idempotencyKey: idempotencyKey,
          policy: {
            enabled: policy.enabled,
            requiresHuman: policy.requiresHuman,
            source: policy.source,
          },
        },
      },
    });

    const actionInput = {
      ...classification.actionInput,
      source: isExotimer ? "exotimer" : "whatsapp",
      phone: isWhatsappUserId(conversation.phone)
        ? classification.actionInput?.phone
        : conversation.phone,
      whatsappUserId: conversation.whatsappUserId || undefined,
      conversationId: conversation.id,
      message: processableText,
      messageId: triggerMessage.id,
      mediaAnalysis: triggerMessage.mediaAnalysis || null,
      mediaContentType: triggerMessage.contentType,
      mediaMimeType: triggerMessage.mediaMimeType || null,
      mediaFilename: triggerMessage.mediaFilename || null,
    };

    if (duplicateAction?.status === "EXECUTED") {
      actionResult = {
        ...(duplicateAction.output || {}),
        idempotentReplay: true,
        reusedFromActionId: duplicateAction.id,
      };
      await prisma.supportAction.update({
        where: { id: action.id },
        data: {
          status: "SKIPPED",
          output: actionResult,
          error: `Accion equivalente reutilizada desde actionId ${duplicateAction.id}.`,
        },
      });
    } else if (duplicateAction?.status === "FAILED") {
      actionError =
        duplicateAction.error ||
        "La misma accion fallo recientemente y no se reintento automaticamente.";
      await prisma.supportAction.update({
        where: { id: action.id },
        data: {
          status: "SKIPPED",
          error: `${actionError} Reintento omitido desde actionId ${duplicateAction.id}.`,
        },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "WAITING_HUMAN" },
      });
    } else if (!trustedSystemUser && !policy.enabled) {
      actionPending = {
        actionId: action.id,
        action: classification.action,
        reason: "disabled_by_support_policy",
      };
      await prisma.supportAction.update({
        where: { id: action.id },
        data: { status: "SKIPPED", error: "Accion deshabilitada por configuracion." },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "WAITING_HUMAN" },
      });
    } else if (!trustedSystemUser && (policy.requiresHuman || requiresConfirmation(classification.action)) && !classification.actionInput?.confirmed) {
      actionPending = {
        actionId: action.id,
        action: classification.action,
        reason: "requires_human_confirmation",
      };
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "WAITING_HUMAN" },
      });
    } else {
      try {
        if (classification.action === "EXOTIMER_SEND_INSCRIPTION_CONFIRMATION_WHATSAPP" && isWhatsapp) {
          actionInput.whatsappTo = whatsappConversationRecipient(conversation);
        }
        actionResult = await executeAction(userType, classification.action, actionInput, {
          allowByPolicy: true,
        });

        const verificationFailed = isUnverifiedTimeCorrection(
          classification,
          actionResult
        );

        await prisma.supportAction.update({
          where: { id: action.id },
          data: {
            status: verificationFailed ? "FAILED" : "EXECUTED",
            output: storedActionOutput(
              classification.action,
              actionInput,
              actionResult
            ),
            error: verificationFailed
              ? "La escritura se ejecuto, pero la verificacion posterior no coincide con el tiempo solicitado."
              : null,
          },
        });
        if (
          classification.action ===
            "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION" &&
          actionResult?.verification?.verified
        ) {
          await Promise.all([
            prisma.conversation.update({
              where: { id: conversation.id },
              data: { status: "RESOLVED" },
            }),
            supportCase?.id
              ? prisma.supportCase.update({
                  where: { id: supportCase.id },
                  data: {
                    status: "RESOLVED",
                    summary: `${supportCase.summary || classification.summary || ""} Tiempo corregido y verificado automaticamente con evidencia acumulada.`.trim(),
                    lastMessageAt: new Date(),
                  },
                })
              : Promise.resolve(),
          ]);
        } else if (
          classification.action ===
            "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION" &&
          actionResult?.created
        ) {
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: { status: "WAITING_HUMAN" },
          });
        }
        if (
          classification.action === "EXOTIMER_PREVIEW_COMPETITION_SETUP" &&
          actionResult?.plan
        ) {
          classification = {
            ...classification,
            actionInput: {
              ...(classification.actionInput || {}),
              plan: actionResult.plan,
            },
          };
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: { classification },
          });
        }
      } catch (error) {
        actionError = error.message;
        await prisma.supportAction.update({
          where: { id: action.id },
          data: { status: "FAILED", error: actionError },
        });
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { status: "WAITING_HUMAN" },
        });
      }
    }
  }

  let reply = await composeReply({
    userType,
    text: processableText,
    classification,
    actionResult,
    actionError,
    actionPending,
    contextActionResult,
    contextActionError,
    history,
    channel: conversation.channel,
  });
  reply = enforceVerifiedActionReply({
    reply,
    classification,
    actionResult,
  });

  let sent = null;
  if (isWhatsapp) {
    try {
      sent = await sendTextMessage(
        whatsappConversationRecipient(conversation),
        reply
      );
    } catch (error) {
      console.error("No se pudo enviar respuesta WhatsApp:", error.response?.data || error.message);
    }
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      supportCaseId: supportCase?.id || null,
      competitionId: competitionId || null,
      direction: "OUTBOUND",
      phone: conversation.phone,
      whatsappUserId: conversation.whatsappUserId || null,
      content: reply,
      aiMetadata: {
        classification,
        actionResult,
        actionError,
        actionPending,
        contextActionResult,
        contextActionError,
        source: isExotimer ? "exotimer" : "whatsapp",
        providerMessageId: sent?.messages?.[0]?.id || null,
      },
      timestamp: new Date(),
    },
  });

  return {
    duplicated: false,
    conversationId: conversation.id,
    supportCaseId: supportCase?.id || null,
    inboundMessageId: triggerMessage.id,
    processedInboundMessageIds: pendingInboundMessages.map((message) => message.id),
    userType,
    reply,
  };
}

async function processInboundMessage({
  waId,
  from,
  whatsappUserId,
  text = "",
  timestamp,
  rawPayload,
  displayName,
  type = "text",
  media,
}) {
  const stableUserId = normalizeWhatsappUserId(whatsappUserId);
  const phone = normalizeWhatsappRecipient(from || stableUserId);
  if (!phone) throw new Error("Remitente de WhatsApp invalido.");

  if (waId) {
    const duplicate = await prisma.message.findUnique({ where: { waId } });
    if (duplicate) return { duplicated: true };
  }

  const conversation = await findOrCreateConversation({
    phone,
    whatsappUserId: stableUserId,
    displayName,
  });
  const timerPhone = isWhatsappUserId(conversation.phone)
    ? null
    : normalizePhone(conversation.phone);
  const timer = timerPhone
    ? await prisma.timerContact.findFirst({
        where: { phone: timerPhone, active: true },
      })
    : null;
  const previousMessages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { timestamp: "desc" },
    take: 12,
  });
  const previousHistory = [...previousMessages].reverse().map(compactMessage);

  let mediaPayload = null;
  let mediaAnalysis = null;
  const contentType =
    type === "image" ? "IMAGE" : type === "document" ? "DOCUMENT" : "TEXT";
  const baseContent = String(text || "").trim();

  if (["IMAGE", "DOCUMENT"].includes(contentType) && media?.id) {
    mediaPayload = {
      mediaId: media.id,
      mediaMimeType: media.mimeType || null,
      mediaSha256: media.sha256 || null,
      mediaFilename: media.filename || null,
    };

    try {
      const downloaded = await downloadMedia(media.id);
      mediaPayload = {
        ...mediaPayload,
        mediaMimeType: media.mimeType || downloaded.mimeType,
        mediaSha256: media.sha256 || downloaded.sha256,
        mediaData: downloaded.buffer,
      };

      const analysisInput = {
        buffer: downloaded.buffer,
        mimeType: mediaPayload.mediaMimeType,
        filename: mediaPayload.mediaFilename,
        caption: baseContent,
        conversationContext: {
          previousUserType: conversation.userType,
          previousClassification: conversation.classification,
          history: previousHistory,
        },
      };
      mediaAnalysis =
        contentType === "IMAGE"
          ? await analyzeImageEvidence(analysisInput)
          : await analyzeDocumentEvidence(analysisInput);
    } catch (error) {
      mediaAnalysis = {
        summary:
          contentType === "IMAGE"
            ? "No se pudo descargar o analizar la imagen recibida."
            : "No se pudo descargar o analizar el documento recibido.",
        error: error.message,
        relevance: "media",
        confidence: 0,
      };
    }
  }

  const content =
    contentType === "IMAGE"
      ? baseContent || "[Imagen recibida]"
      : contentType === "DOCUMENT"
        ? baseContent ||
          `[Documento recibido${mediaPayload?.mediaFilename ? `: ${mediaPayload.mediaFilename}` : ""}]`
        : baseContent;

  const inbound = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      waId,
      direction: "INBOUND",
      contentType,
      phone,
      whatsappUserId: stableUserId || null,
      content,
      ...(mediaPayload || {}),
      mediaAnalysis,
      rawPayload,
      timestamp,
    },
  });

  sendNewMessageNotification({
    conversation,
    message: inbound,
    userType: timer ? "TIMER" : conversation.userType,
  }).catch((error) => {
    console.warn("No se pudo enviar notificacion push:", error.message);
  });

  scheduleConversationProcessing(conversation.id);

  return {
    duplicated: false,
    conversationId: conversation.id,
    inboundMessageId: inbound.id,
    scheduled: true,
    debounceMs: Math.max(0, Number(config.support.replyDebounceMs || 8000)),
  };
}

async function findOrCreateExotimerConversation({ competitionId, userId, userName, userRole, touchLastMessageAt = true }) {
  const normalizedCompetitionId = Number(competitionId);
  if (!Number.isInteger(normalizedCompetitionId)) throw new Error("competitionId invalido");
  if (!userId) throw new Error("userId requerido");

  const phone = buildExotimerConversationPhone({ competitionId: normalizedCompetitionId, userId });
  return findOrCreateConversation({
    channel: "EXOTIMER",
    phone,
    displayName: userName || `Usuario ExoTimer ${userId}`,
    userType: normalizeExotimerUserType(userRole),
    touchLastMessageAt,
  });
}

async function processInboundExotimerMessage({
  competitionId,
  userId,
  userName,
  userRole,
  text = "",
  context,
  timestamp = new Date(),
}) {
  const content = String(text || "").trim();
  if (!content) throw new Error("Mensaje requerido");

  const normalizedCompetitionId = Number(competitionId);
  if (!Number.isInteger(normalizedCompetitionId)) throw new Error("competitionId invalido");

  const conversation = await findOrCreateExotimerConversation({
    competitionId: normalizedCompetitionId,
    userId,
    userName,
    userRole,
  });

  const inbound = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      competitionId: normalizedCompetitionId,
      direction: "INBOUND",
      contentType: "TEXT",
      phone: conversation.phone,
      content,
      rawPayload: {
        source: "exotimer",
        competitionId: normalizedCompetitionId,
        userId: String(userId),
        userName: userName || null,
        userRole: userRole || null,
        context: context || null,
      },
      aiMetadata: {
        source: "exotimer",
        page: context?.page || null,
        section: context?.section || null,
      },
      timestamp,
    },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: inbound.timestamp },
  });

  scheduleConversationProcessing(conversation.id);

  return {
    duplicated: false,
    conversationId: conversation.id,
    inboundMessageId: inbound.id,
    scheduled: true,
    debounceMs: Math.max(0, Number(config.support.replyDebounceMs || 8000)),
  };
}

module.exports = {
  actionIdempotencyKey,
  buildExotimerConversationPhone,
  competitionPlanOverrides,
  enforceVerifiedActionReply,
  findOrCreateExotimerConversation,
  inspectAthleteResultPreflight,
  mergeActionInput,
  processInboundExotimerMessage,
  processInboundMessage,
  processInboundText,
  resultHasPublishedTime,
  summarizeResultForClosure,
};
