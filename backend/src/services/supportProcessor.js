const prisma = require("../lib/prisma");
const { analyzeImageEvidence, classifyMessage, composeReply } = require("./ai");
const { executeAction, requiresConfirmation } = require("./exotimerClient");
const { getPolicy } = require("./supportPolicies");
const { downloadMedia, sendTextMessage } = require("./waba");
const { normalizePhone } = require("../utils/phone");

async function findOrCreateConversation({ phone, displayName }) {
  return prisma.conversation.upsert({
    where: { channel_phone: { channel: "WHATSAPP", phone } },
    create: {
      phone,
      displayName,
      lastMessageAt: new Date(),
    },
    update: {
      displayName: displayName || undefined,
      lastMessageAt: new Date(),
    },
  });
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
      actionInput: mergedInput,
      needsHuman: classification.needsHuman || previous.needsHuman || false,
    };
  }

  return {
    ...classification,
    actionInput: mergedInput,
  };
}

function actionNeedsCompetitionId(actionName) {
  return [
    "EXOTIMER_GET_COMPETITION_EVENTS",
    "EXOTIMER_GET_TICKETS",
    "EXOTIMER_GET_INSCRIPTION",
    "EXOTIMER_GET_RESULTS",
    "EXOTIMER_VALIDATE_PRE_RACE",
    "EXOTIMER_GET_RAWS",
    "EXOTIMER_CREATE_MANUAL_RAW",
    "EXOTIMER_UPDATE_START_TIME",
    "EXOTIMER_UPDATE_EVENT_TICKET",
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

  if (actionNeedsCompetitionId(actionName) && !hasCompetition) {
    missing.push(hasCompetitionName ? "competitionId_resolved_from_name" : "competitionName");
  }

  if (actionName === "EXOTIMER_GET_INSCRIPTION" && !(input.dorsal || input.bib)) {
    missing.push("dorsal");
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

async function processInboundText(args) {
  return processInboundMessage({
    ...args,
    type: "text",
  });
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

  const content = contentType === "IMAGE"
    ? baseContent || "[Imagen recibida]"
    : baseContent;
  const processableText = buildProcessableText({ text: content, mediaAnalysis });

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

  const recentMessages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { timestamp: "desc" },
    take: 12,
  });
  const history = [...recentMessages].reverse().map(compactMessage);

  let classification = await classifyMessage({
    text: processableText,
    forcedTimer: Boolean(timer),
    previousClassification: conversation.classification,
    previousUserType: conversation.userType,
    conversationStatus: conversation.status,
    history,
  });
  classification = mergeClassificationWithConversation(classification, conversation);

  const userType = timer ? "TIMER" : classification.userType;
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

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      userType,
      confidence: classification.confidence,
      classification,
      status: classification.needsHuman ? "WAITING_HUMAN" : "OPEN",
      lastMessageAt: timestamp,
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
        messageId: inbound.id,
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
      source: "whatsapp",
      phone,
      message: processableText,
    };

    if (!policy.enabled) {
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
    } else if ((policy.requiresHuman || requiresConfirmation(classification.action)) && !classification.actionInput?.confirmed) {
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
  });

  let sent = null;
  try {
    sent = await sendTextMessage(phone, reply);
  } catch (error) {
    console.error("No se pudo enviar respuesta WhatsApp:", error.response?.data || error.message);
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      phone,
      content: reply,
      aiMetadata: {
        classification,
        actionResult,
        actionError,
        actionPending,
        contextActionResult,
        contextActionError,
        providerMessageId: sent?.messages?.[0]?.id || null,
      },
      timestamp: new Date(),
    },
  });

  return {
    duplicated: false,
    conversationId: conversation.id,
    inboundMessageId: inbound.id,
    userType,
    reply,
  };
}

module.exports = { processInboundMessage, processInboundText };
