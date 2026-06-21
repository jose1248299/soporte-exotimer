const OpenAI = require("openai");
const { z } = require("zod");
const config = require("../config");
const { ACTIONS, canExecuteAction, requiresConfirmation } = require("./exotimerClient");
const { buildExotimerAssistantKnowledge } = require("./exotimerKnowledge");

const actionNames = Object.keys(ACTIONS);

const fallbackClassification = {
  userType: "UNKNOWN",
  confidence: 0,
  intent: "unknown",
  summary: "No se pudo clasificar automaticamente.",
  action: null,
  actionInput: {},
  needsHuman: true,
};

const classificationSchema = z.object({
  userType: z.enum(["SYSTEM_USER", "TIMER", "BUYER", "ORGANIZER", "ATHLETE", "UNKNOWN"]),
  confidence: z.number().min(0).max(1),
  intent: z.string(),
  summary: z.string(),
  action: z.enum(actionNames).nullable(),
  actionInput: z.record(z.any()).default({}),
  needsHuman: z.boolean().default(false),
});

function getClient() {
  if (!config.openai.apiKey) return null;
  return new OpenAI({ apiKey: config.openai.apiKey });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function heuristicClassify(text, forcedTimer) {
  if (forcedTimer) {
    const lower = String(text || "").toLowerCase();
    if (/(reader|lectora|conectad|canal|equipo)/.test(lower)) {
      return {
        ...fallbackClassification,
        userType: "TIMER",
        confidence: 0.82,
        intent: "reader_status",
        summary: "Timer solicita estado de readers o canales.",
        action: "EXOTIMER_GET_CONNECTED_READERS",
        needsHuman: false,
      };
    }

    return {
      ...fallbackClassification,
      userType: "TIMER",
      confidence: 1,
      intent: "timer_support",
      summary: "Numero registrado como Timer.",
      needsHuman: false,
    };
  }

  const lower = String(text || "").toLowerCase();
  if (/(no recib|correo|confirmaci|inscripci|inscrito|pago|voucher|yape|plin)/.test(lower)) {
    return {
      ...fallbackClassification,
      userType: "ATHLETE",
      confidence: 0.7,
      intent: "inscription_support",
      summary: "Participante solicita soporte sobre inscripcion, pago o correo de confirmacion.",
      actionInput: { message: text },
      needsHuman: false,
    };
  }
  if (/(precio|cotiza|costo|cu[aá]nto|paquete|servicio)/.test(lower)) {
    return {
      ...fallbackClassification,
      userType: "BUYER",
      confidence: 0.65,
      intent: "price_inquiry",
      summary: "Consulta comercial sobre precios.",
      action: "BUYER_CREATE_PRICE_INQUIRY",
      actionInput: { message: text },
      needsHuman: true,
    };
  }
  if (/(ticket|entrada|inscripci[oó]n|cupos|organizador)/.test(lower)) {
    return {
      ...fallbackClassification,
      userType: "ORGANIZER",
      confidence: 0.62,
      intent: "ticket_or_inscription",
      summary: "Consulta de organizador sobre tickets o inscripciones.",
      needsHuman: false,
    };
  }
  if (/(resultado|tiempo|chip|clasificaci[oó]n|corregir|dorsal|bib)/.test(lower)) {
    return {
      ...fallbackClassification,
      userType: "ATHLETE",
      confidence: 0.66,
      intent: "result_correction",
      summary: "Solicitud de atleta sobre correccion de resultados.",
      action: "EXOTIMER_CREATE_RESULT_CORRECTION_CASE",
      actionInput: { message: text },
      needsHuman: true,
    };
  }

  return fallbackClassification;
}

async function classifyMessage({
  text,
  forcedTimer,
  previousClassification,
  previousUserType,
  conversationStatus,
  history = [],
  channel = "WHATSAPP",
  trustedSystemUser = false,
}) {
  if (forcedTimer) return heuristicClassify(text, true);

  const client = getClient();
  if (!client) return heuristicClassify(text, false);

  const prompt = [
    `Clasifica un mensaje entrante por ${channel === "EXOTIMER" ? "el chat interno de ExoTimer" : "WhatsApp"} para Finisher Data, empresa de cronometraje electronico deportivo.`,
    "Debes razonar como una conversacion completa, no como mensajes aislados.",
    "Tipos de usuario:",
    "- SYSTEM_USER: usuario autenticado dentro de ExoTimer. Solo usar si el canal/contexto indica trustedSystemUser=true.",
    "- TIMER: solo si el sistema ya lo identifico por telefono. No asumas TIMER por texto.",
    "- BUYER: solicita precios, cotizaciones o informacion comercial.",
    "- ORGANIZER: organiza un evento y pide modificar tickets, inscripciones o configuracion de venta.",
    "- ATHLETE: participante que pide corregir resultados, tiempos, dorsal, chip o clasificacion.",
    "Devuelve JSON estricto con: userType, confidence, intent, summary, action, actionInput, needsHuman.",
    "Acciones disponibles:",
    ...Object.entries(ACTIONS).map(
      ([name, meta]) =>
        `- ${name}: ${meta.description}. Roles: ${meta.roles.join(", ")}. Riesgo: ${meta.risk}.`
    ),
    "Reglas:",
    trustedSystemUser
      ? "- Este mensaje viene del chat interno de ExoTimer con trustedSystemUser=true. Clasifica userType=SYSTEM_USER. Puede ejecutar cualquier accion disponible si hay datos suficientes. No lo trates como atleta externo."
      : "- Este mensaje viene de un canal externo. No uses SYSTEM_USER.",
    trustedSystemUser
      ? "- Para SYSTEM_USER, usa action=null cuando la consulta sea explicativa o de manual, por ejemplo como usar una pantalla, que significa un error o donde configurar algo. Responde con informacion usando el contexto operativo."
      : "",
    trustedSystemUser
      ? "- Para SYSTEM_USER, si pide explicitamente crear, editar, corregir, reenviar, validar o consultar datos, devuelve la accion ExoTimer mas concreta y needsHuman=false cuando tengas identificadores suficientes."
      : "",
    "- Usa el historial y la clasificacion anterior para entender mensajes cortos de continuidad como nombres, dorsales, confirmaciones o aclaraciones.",
    "- Si el mensaje actual completa datos pedidos antes, conserva el userType, intent, action y actionInput anterior, agregando solo los datos nuevos.",
    "- No cambies a UNKNOWN si el historial muestra claramente que la conversacion sigue siendo sobre el mismo caso.",
    "- Extrae y conserva campos utiles: competitionName, competitionId, dorsal, bib, currentDorsal, athleteName, participantName, participantLastname, requestedCorrection, targetField, currentValue, requestedValue, newDorsal, newDistance, newGender, newCategory, eventName, ticketName, phone, email, document, dni, inscriptionReference, paymentEvidence, correctEmail, requestedEmail, newEmail.",
    "- Los dorsales no tienen ceros a la izquierda. Si recibes 002, 02 o 0002, interpreta y devuelve dorsal=2. Aplica esto tambien a bib, currentDorsal, newDorsal, detectedDorsals y detectedAthletes[].dorsal.",
    "- Si el usuario menciona varios dorsales o varias personas del equipo, NO dividas el caso. Devuelve detectedDorsals como array de strings y detectedAthletes como array de objetos {name,dorsal} cuando puedas.",
    "- Conserva detectedDorsals y detectedAthletes previos del contexto, agregando nuevos sin perder los anteriores.",
    "- Usa action=null si faltan ids o datos esenciales.",
    "- Puedes usar EXOTIMER_FIND_COMPETITION si el usuario da nombre de competencia pero no id.",
    "- Si el usuario da nombre de competencia y dorsal para resultados, puedes devolver EXOTIMER_GET_INSCRIPTION con competitionName y dorsal; el sistema resolvera competitionId.",
    "- No ejecutes cambios tecnicos genericos, raws manuales libres ni tickets sin confirmacion humana: usa la accion, pero needsHuman=true.",
    "- Para cambios de TIEMPO de carrera de atletas, usa EXOTIMER_CREATE_RESULT_CORRECTION_CASE o humano salvo cuando haya evidencia contundente segun las reglas siguientes.",
    "- Puedes usar EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION con needsHuman=false solo si la conversacion tiene competitionId o competitionName, dorsal/resultId, tiempo oficial actual, tiempo solicitado, y una evidencia objetiva fuerte.",
    "- Evidencia objetiva fuerte significa: imagen/captura/foto analizada con confidence >= 0.85 o hasStrongEvidence=true, y que confirme hora de llegada/meta o tiempo GPS coherente con el reclamo. Idealmente debe verse el dorsal o el contexto debe haber identificado sin ambiguedad al atleta.",
    "- Para EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION extrae: competitionId, dorsal, athleteName, currentValue, requestedValue, evidenceFinishTime o evidenceFinishDateTime, evidenceConfidence, evidenceSummary, hasStrongEvidence=true, targetField='tiempo'.",
    "- Si la evidencia solo muestra un tiempo GPS pero no la hora meta, usa evidenceFinishTime solo si puedes inferir una hora meta clara desde la evidencia o el texto. Si solo hay duracion sin hora meta, no ejecutes la correccion automatica.",
    "- Antes de corregir tiempo automaticamente, la diferencia entre tiempo oficial y solicitado debe ser significativa, aproximadamente mayor a 2 minutos. Si la diferencia es menor, hay conflicto de datos, el dorsal no coincide, la competencia no esta clara o la imagen corresponde a otra competencia, needsHuman=true.",
    "- Si un atleta envia un reclamo estructurado desde la web publica con competitionId, dorsal y valor correcto, puedes ejecutar cambios permitidos sin humano.",
    "- Para cambiar dorsal usa EXOTIMER_UPDATE_RESULT_DORSAL con competitionId, dorsal actual en dorsal/currentDorsal, targetField, currentValue, requestedValue y newDorsal.",
    "- Para cambiar distancia, genero o categoria usa EXOTIMER_UPDATE_RESULT_EVENT_CATEGORY con competitionId, dorsal, targetField, currentValue, requestedValue y newDistance/newGender/newCategory segun corresponda.",
    "- Para cambiar nombre, apellido u otros datos personales visibles del participante usa EXOTIMER_UPDATE_RESULT_PARTICIPANT_DATA con competitionId, dorsal, targetField, currentValue, requestedValue y participantName/participantLastname cuando corresponda.",
    "- En estos cambios permitidos de atleta, usa needsHuman=false si tienes competitionId o competitionName, dorsal/resultId y el valor correcto solicitado. Si falta algun dato esencial, usa action=null y pide el dato faltante.",
    "- Para atletas, consulta primero inscripcion/resultados cuando existan evento y dorsal. Registra EXOTIMER_CREATE_RESULT_CORRECTION_CASE solo cuando haya datos minimos del caso y una correccion/reporte concreto.",
    "- Para atletas con problemas de inscripcion, correo de confirmacion, pago, voucher, no aparezco inscrito, correo mal escrito o no me llego el email: clasifica como ATHLETE, no como ORGANIZER.",
    "- Para esos casos de inscripcion usa EXOTIMER_GET_INSCRIPTION_BY_REFERENCE_OR_DOCUMENT si tienes competitionId o competitionName y al menos uno de: inscriptionReference, document/dni, email, phone o participantName. No pidas dorsal para inscripciones.",
    "- Si el usuario adjunta comprobante de pago o la imagen analizada indica paymentEvidence/hasStrongEvidence, usa EXOTIMER_VALIDATE_PAYMENT_EVIDENCE con competitionId, inscriptionReference/document/email/phone/participantName y paymentEvidence. Esta accion solo verifica; no aprueba pagos ni afirma que el correo fue reenviado.",
    "- Si el usuario dice que ingreso mal su correo y da el correo correcto, puedes usar EXOTIMER_UPDATE_INSCRIPTION_EMAIL con competitionId, referencia/DNI/email/phone/nombre para ubicar la inscripcion y newEmail/correctEmail/requestedEmail. Usa needsHuman=false solo si hay una unica coincidencia clara por DNI o referencia; si solo coincide por nombre, needsHuman=true.",
    "- Si el usuario reclama que en su inscripcion eligio mal distancia, genero o categoria, usa EXOTIMER_UPDATE_INSCRIPTION_EVENT_CATEGORY con competitionId o competitionName, referencia/DNI/email/phone/nombre, targetField y newDistance/newGender/newCategory o requestedValue. Usa needsHuman=false si hay una unica coincidencia clara por DNI, referencia, email o telefono y el valor correcto esta disponible.",
    "- Si el usuario no recibio el correo de confirmacion y tienes competitionId o competitionName mas referencia/DNI/email/telefono/nombre, usa EXOTIMER_RESEND_INSCRIPTION_CONFIRMATION. Usa needsHuman=false si hay referencia, DNI, email o telefono claro; si solo hay nombre ambiguo, needsHuman=true.",
    "- Para compradores, usa BUYER_CREATE_PRICE_INQUIRY; la cotizacion comercial vive fuera de Exotimer.",
    "Contexto persistente:",
    JSON.stringify({
      channel,
      trustedSystemUser,
      previousUserType,
      conversationStatus,
      previousClassification,
      history,
    }),
    trustedSystemUser ? buildExotimerAssistantKnowledge() : "",
    `Mensaje actual: ${text}`,
  ].join("\n");

  const completion = await client.chat.completions.create({
    model: config.openai.model,
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
  });

  const parsed = parseJson(completion.choices[0]?.message?.content);
  const result = classificationSchema.safeParse(parsed);
  if (!result.success) return heuristicClassify(text, false);

  const data = result.data;
  if (data.action && !canExecuteAction(data.userType, data.action)) {
    data.action = null;
    data.actionInput = {};
    data.needsHuman = true;
  }

  if (data.action && requiresConfirmation(data.action) && data.userType !== "SYSTEM_USER") {
    data.needsHuman = true;
  }

  return data;
}

function fallbackReply(userType) {
  if (userType === "BUYER") {
    return "Hola, gracias por contactar a Finisher Data. Para cotizar tu evento, cuentame la fecha, ciudad, deporte y cantidad aproximada de participantes.";
  }
  if (userType === "ATHLETE") {
    return "Hola, te ayudo con tu resultado. Enviame nombre del evento, tu nombre completo, dorsal y la correccion que necesitas revisar.";
  }
  if (userType === "ORGANIZER") {
    return "Hola, te ayudo con la configuracion de tickets o inscripciones. Indicame la competencia, distancia, ticket y cambio requerido.";
  }
  if (userType === "TIMER") {
    return "Hola, Timer identificado. Indicame la competencia, punto de control o salida, y el cambio exacto que necesitas revisar.";
  }
  return "Hola, gracias por escribir a Finisher Data. Cuentame si consultas por inscripciones o resultados de un evento?";
}

async function composeReply({
  userType,
  text,
  classification,
  actionResult,
  actionError,
  actionPending,
  contextActionResult,
  contextActionError,
  history = [],
  channel = "WHATSAPP",
}) {
  const client = getClient();
  if (!client) return fallbackReply(userType);

  const status = actionResult
    ? "La accion solicitada fue ejecutada correctamente."
    : actionError
      ? `La accion no pudo ejecutarse: ${actionError}`
      : actionPending
        ? "La accion fue registrada como pendiente de confirmacion humana. No se ejecuto aun."
        : "No se ejecuto ninguna accion automatica.";

  const completion = await client.chat.completions.create({
    model: config.openai.model,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          [
            `Eres soporte de Finisher Data por ${channel === "EXOTIMER" ? "el chat interno de ExoTimer para usuarios autenticados del sistema" : "WhatsApp"}.`,
            "Responde en espanol, breve, amable y accionable. Usa el historial para continuar el caso sin pedir de nuevo datos ya entregados.",
            "No inventes cambios realizados. Si falta informacion, pidela claramente. Si algo quedo pendiente de confirmacion humana, dilo sin afirmar que ya se cambio.",
            channel === "EXOTIMER"
              ? "Si la consulta es informativa, responde como asistente operativo usando el manual y contexto de ExoTimer. Si se ejecuto una accion, resume que se hizo y que debe revisar el usuario."
              : "",
            channel === "EXOTIMER" ? buildExotimerAssistantKnowledge() : "",
          ]
            .filter(Boolean)
            .join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          userType,
          incomingMessage: text,
          history,
          classification,
          actionStatus: status,
          actionResult,
          contextActionResult,
          contextActionError,
          actionPending,
        }),
      },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() || fallbackReply(userType);
}

async function analyzeImageEvidence({ buffer, mimeType, caption, conversationContext }) {
  const client = getClient();
  if (!client || !buffer || !mimeType?.startsWith("image/")) return null;

  const dataUrl = `data:${mimeType};base64,${Buffer.from(buffer).toString("base64")}`;
  const completion = await client.chat.completions.create({
    model: config.openai.model,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content:
          "Analiza imagenes enviadas como evidencia para soporte de cronometraje deportivo. Devuelve JSON estricto, breve y util. No inventes datos ilegibles.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              caption,
              conversationContext,
              expectedJson: {
                summary: "descripcion breve",
                visibleText: ["textos legibles relevantes"],
                extracted: {
                  athleteName: null,
                  dorsal: null,
                  competitionName: null,
                  time: null,
                  evidenceFinishTime: null,
                  evidenceFinishDateTime: null,
                  gpsElapsedTime: null,
                  resultPosition: null,
                },
                relevance: "alta|media|baja",
                hasStrongEvidence: false,
                evidenceSummary: "por que la imagen ayuda o no ayuda a corregir el resultado",
                confidence: 0,
              },
            }),
          },
          {
            type: "image_url",
            image_url: { url: dataUrl },
          },
        ],
      },
    ],
  });

  const parsed = parseJson(completion.choices[0]?.message?.content);
  return parsed || {
    summary: completion.choices[0]?.message?.content?.trim() || "Imagen recibida como evidencia.",
    visibleText: [],
    extracted: {},
    relevance: "media",
    confidence: 0.4,
  };
}

module.exports = {
  analyzeImageEvidence,
  classifyMessage,
  composeReply,
};
