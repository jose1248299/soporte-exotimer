const prisma = require("../lib/prisma");
const { classifyMessage, composeReply } = require("./ai");
const { executeAction, requiresConfirmation } = require("./exotimerClient");
const { getPolicy } = require("./supportPolicies");
const { sendTextMessage } = require("./waba");
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

async function processInboundText({ waId, from, text, timestamp, rawPayload, displayName }) {
  const phone = normalizePhone(from);

  if (waId) {
    const duplicate = await prisma.message.findUnique({ where: { waId } });
    if (duplicate) return { duplicated: true };
  }

  const timer = await prisma.timerContact.findFirst({
    where: { phone, active: true },
  });

  const conversation = await findOrCreateConversation({ phone, displayName });

  const inbound = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      waId,
      direction: "INBOUND",
      phone,
      content: text,
      rawPayload,
      timestamp,
    },
  });

  const classification = await classifyMessage({
    text,
    forcedTimer: Boolean(timer),
  });

  const userType = timer ? "TIMER" : classification.userType;

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
      message: text,
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
    text,
    classification,
    actionResult,
    actionError,
    actionPending,
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

module.exports = { processInboundText };
