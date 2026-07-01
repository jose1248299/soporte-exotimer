const prisma = require("../lib/prisma");
const config = require("../config");
const { analyzeImageEvidence, classifyMessage, composeReply } = require("./ai");
const { executeAction, requiresConfirmation } = require("./exotimerClient");
const { getPolicy } = require("./supportPolicies");
const { sendNewMessageNotification } = require("./pushNotifications");
const { findOrCreateSupportCase, pickCompetitionId } = require("./supportCases");
const { downloadMedia, sendTextMessage } = require("./waba");
const { normalizeDorsalReferences } = require("../utils/dorsal");
const { normalizePhone } = require("../utils/phone");

const replyDebounceTimers = new Map();
const processorStartedAt = new Date();

async function findOrCreateConversation({ phone, displayName, channel = "WHATSAPP", userType, touchLastMessageAt = true }) {
  const existing = await prisma.conversation.findUnique({
    where: { channel_phone: { channel, phone } },
  });

  if (!existing) {
    return prisma.conversation.create({
      data: {
        channel,
        phone,
        displayName,
        userType: userType || undefined,
        lastMessageAt: new Date(),
      },
    });
  }

  return prisma.conversation.update({
    where: { id: existing.id },
    data: {
      displayName: displayName || undefined,
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
  const merged = {
    ...previousInput,
    ...nextInput,
  };
  if (nextInput.competitionId || nextInput.competition_id || nextInput.competition) {
    delete merged.missingFields;
  }

  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
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
        ((input.activityStartDateTime || input.activityStartTime) && (input.gpsElapsedTime || input.evidenceElapsedTime || input.requestedValue))
    );
    if (!hasResultReference) missing.push("dorsal_or_resultId");
    if (!hasEvidenceFinishTime) missing.push("evidenceFinishTime");
  }

  return missing;
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
  const contextActionResult = contextResolution.contextActionResult;
  const contextActionError = contextResolution.contextActionError;

  if (classification.action) {
    const policy = await getPolicy(userType, classification.action);
    const action = await prisma.supportAction.create({
      data: {
        conversationId: conversation.id,
        supportCaseId: supportCase?.id || null,
        messageId: triggerMessage.id,
        userType,
        name: classification.action,
        input: {
          ...(classification.actionInput || {}),
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
      phone: conversation.phone,
      message: processableText,
    };

    if (!trustedSystemUser && !policy.enabled) {
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
          actionInput.whatsappTo = conversation.phone;
        }
        actionResult = await executeAction(userType, classification.action, actionInput, {
          allowByPolicy: true,
        });

        await prisma.supportAction.update({
          where: { id: action.id },
          data: { status: "EXECUTED", output: actionResult },
        });
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

  const reply = await composeReply({
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

  let sent = null;
  if (isWhatsapp) {
    try {
      sent = await sendTextMessage(conversation.phone, reply);
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

async function processInboundMessage({ waId, from, text = "", timestamp, rawPayload, displayName, type = "text", media }) {
  const phone = normalizePhone(from);

  if (waId) {
    const duplicate = await prisma.message.findUnique({ where: { waId } });
    if (duplicate) return { duplicated: true };
  }

  const timer = await prisma.timerContact.findFirst({
    where: { phone, active: true },
  });

  const conversation = await findOrCreateConversation({ phone, displayName });
  const previousMessages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { timestamp: "desc" },
    take: 12,
  });
  const previousHistory = [...previousMessages].reverse().map(compactMessage);

  let mediaPayload = null;
  let mediaAnalysis = null;
  const contentType = type === "image" ? "IMAGE" : "TEXT";
  const baseContent = String(text || "").trim();

  if (contentType === "IMAGE" && media?.id) {
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

      mediaAnalysis = await analyzeImageEvidence({
        buffer: downloaded.buffer,
        mimeType: mediaPayload.mediaMimeType,
        caption: baseContent,
        conversationContext: {
          previousUserType: conversation.userType,
          previousClassification: conversation.classification,
          history: previousHistory,
        },
      });
    } catch (error) {
      mediaAnalysis = {
        summary: "No se pudo descargar o analizar la imagen recibida.",
        error: error.message,
        relevance: "media",
        confidence: 0,
      };
    }
  }

  const content = contentType === "IMAGE" ? baseContent || "[Imagen recibida]" : baseContent;

  const inbound = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      waId,
      direction: "INBOUND",
      contentType,
      phone,
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
  buildExotimerConversationPhone,
  findOrCreateExotimerConversation,
  processInboundExotimerMessage,
  processInboundMessage,
  processInboundText,
};
