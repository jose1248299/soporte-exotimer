const OpenAI = require("openai");
const { z } = require("zod");
const config = require("../config");
const { ACTIONS, canExecuteAction, requiresConfirmation } = require("./exotimerClient");
const {
  buildExotimerAssistantKnowledge,
  buildTimerAssistantKnowledge,
} = require("./exotimerKnowledge");
const { parseVideoFinishFindingMessage } = require("../utils/videoFinish");

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

const normalizeForIntent = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

function isTimerCompetitionCreationRequest(text) {
  const lower = normalizeForIntent(text);
  return /(crear|crea|creame|configur|alta|nuevo|nueva).{0,50}(competencia|evento|distancia|carrera)|competencia.{0,50}(imagen|afiche|bases|crear|configur)|evento.{0,50}(imagen|afiche|bases|crear|configur)|bases.{0,50}(competencia|evento|crear)/.test(lower);
}

function isExplicitCompetitionSetupConfirmation(text) {
  const lower = normalizeForIntent(text).trim();
  if (!lower) return false;
  if (/\b(no|cancelar|cancela|deten|espera|todavia no|aun no)\b/.test(lower)) {
    return false;
  }
  return /\b(confirmo|confirmado|procede|proceder|crea|crear|aplica|aplicar|adelante|dale|hazlo)\b/.test(
    lower
  );
}

function isTimerCompetitionCreationContext({ text, previousClassification, history = [] } = {}) {
  if (isTimerCompetitionCreationRequest(text)) return true;
  if (
    history.slice(-6).some((message) => {
      const extracted = message.mediaAnalysis?.extracted || {};
      return Boolean(
        ["IMAGE", "DOCUMENT"].includes(message.contentType) &&
          (extracted.competitionName ||
            extracted.eventName ||
            extracted.events?.length ||
            extracted.distances?.length)
      );
    })
  ) {
    return true;
  }
  const previousAction = previousClassification?.action;
  const previousIntent = normalizeForIntent(previousClassification?.intent || previousClassification?.summary);
  if (
    previousAction === "EXOTIMER_PREVIEW_COMPETITION_SETUP" ||
    previousAction === "EXOTIMER_APPLY_COMPETITION_SETUP" ||
    previousAction === "EXOTIMER_CREATE_COMPETITION_FROM_BASES" ||
    previousAction === "EXOTIMER_CREATE_COMPETITION_FROM_CHAT" ||
    previousIntent.includes("competition_creation") ||
    previousIntent.includes("crear competencia") ||
    previousIntent.includes("crear evento")
  ) {
    return true;
  }

  const recent = history
    .slice(-6)
    .map((message) => message.content)
    .join(" ");
  return isTimerCompetitionCreationRequest(recent);
}

function heuristicClassify(text, forcedTimer) {
  if (forcedTimer) {
    const lower = normalizeForIntent(text);
    if (isTimerCompetitionCreationRequest(text)) {
      return {
        ...fallbackClassification,
        userType: "TIMER",
        confidence: 0.9,
        intent: "timer_competition_creation_guidance",
        summary: "Timer solicita ayuda para crear o configurar competencia/evento.",
        action: "EXOTIMER_PREVIEW_COMPETITION_SETUP",
        actionInput: { message: text },
        needsHuman: false,
      };
    }

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
  const videoFinishFinding = parseVideoFinishFindingMessage(text);
  if (videoFinishFinding) {
    return {
      userType: forcedTimer ? "TIMER" : "ATHLETE",
      confidence: 0.99,
      intent: "video_finish_self_service_finding",
      summary:
        "El participante envio un hallazgo estructurado desde Video Finish.",
      action: "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION",
      actionInput: videoFinishFinding,
      needsHuman: false,
    };
  }

  const timerCreationContext = forcedTimer
    ? isTimerCompetitionCreationContext({ text, previousClassification, history })
    : false;
  const previousCompetitionPlan = previousClassification?.actionInput?.plan;
  if (
    forcedTimer &&
    previousCompetitionPlan?.readyToApply &&
    isExplicitCompetitionSetupConfirmation(text)
  ) {
    return {
      ...fallbackClassification,
      userType: "TIMER",
      confidence: 1,
      intent: "timer_competition_creation_apply",
      summary: "Timer confirmo aplicar el plan validado de la competencia.",
      action: "EXOTIMER_APPLY_COMPETITION_SETUP",
      actionInput: {
        plan: previousCompetitionPlan,
        confirmed: true,
      },
      needsHuman: false,
    };
  }
  if (forcedTimer && !timerCreationContext) return heuristicClassify(text, true);

  const client = getClient();
  if (!client && forcedTimer && timerCreationContext) {
    return {
      ...fallbackClassification,
      userType: "TIMER",
      confidence: 0.85,
      intent: "timer_competition_creation_preview",
      summary: "Timer solicita preparar una competencia desde datos o archivos adjuntos.",
      action: "EXOTIMER_PREVIEW_COMPETITION_SETUP",
      actionInput: { message: text },
      needsHuman: false,
    };
  }
  if (!client) return heuristicClassify(text, forcedTimer);

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
    "- Para crear una competencia nueva, tanto TIMER como SYSTEM_USER deben usar primero EXOTIMER_PREVIEW_COMPETITION_SETUP. Solo despues de un preview listo y confirmacion explicita usa EXOTIMER_APPLY_COMPETITION_SETUP con el mismo objeto plan y confirmed=true.",
    "- Si el usuario consulta resultados y da competencia+dorsal, usa EXOTIMER_GET_RESULTS con competitionId/competitionName y dorsal. No uses EXOTIMER_GET_INSCRIPTION para comprobar resultados.",
    "- No ejecutes cambios tecnicos genericos, raws manuales libres ni tickets sin confirmacion humana: usa la accion, pero needsHuman=true.",
    "- Para cambios de TIEMPO de carrera de atletas, usa EXOTIMER_CREATE_RESULT_CORRECTION_CASE o humano solo cuando falten señales minimas. Se permite TRUST_ATHLETE_EVIDENCE para ser mas credulo con evidencia combinada razonable.",
    "- Si el atleta no tiene tiempo oficial y entrega competitionId o competitionName, dorsal y una hora aproximada del dia en la que cruzo la meta, usa EXOTIMER_CHECK_VIDEO_FINISH_AVAILABILITY con approximateTime en formato HH:mm:ss. Si falta la hora aproximada, usa action=null y pidela.",
    "- Solo ofrece la URL publica de Video Finish cuando EXOTIMER_CHECK_VIDEO_FINISH_AVAILABILITY devuelva available=true. Nunca inventes el enlace ni expongas una URL temporal del proveedor de video.",
    "- El mensaje [HALLAZGO GENERADO POR FINISHER DATA] se procesa de forma deterministica. Sus datos deben conservarse literalmente y la accion valida evento, camara, grabacion, dorsal, distancia y timestamp antes de cualquier escritura.",
    "- En Video Finish, Timestamp exacto de camara incluye el desfase tecnico de la camara. No lo ajustes en el prompt: el backend resta gapVideo y produce evidenceFinishDateTime canonico.",
    "- Puedes usar EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION con needsHuman=false si la conversacion tiene competitionId o competitionName, dorsal/resultId, tiempo solicitado y evidencia objetiva fuerte o evidencia combinada razonable bajo TRUST_ATHLETE_EVIDENCE.",
    "- TRUST_ATHLETE_EVIDENCE aplica cuando hay reclamo estructurado desde la web publica o contexto claro con competitionId+dorsal+atleta, mas al menos dos o tres senales: GPS/Strava/Garmin/reloj con tiempo o duracion, foto del dorsal antes/durante/meta, foto oficial cruzando meta, fecha/hora compatible, distancia/evento compatible, resultado actual sin tiempo/en carrera. En ese caso incluye trustAthleteEvidence=true y evidencePolicy='TRUST_ATHLETE_EVIDENCE'.",
    "- Bajo TRUST_ATHLETE_EVIDENCE no exijas que una sola imagen contenga nombre+dorsal+tiempo. Acepta evidencia repartida en varias imagenes/mensajes si el hilo completo es coherente y el reclamo no afecta una situacion sensible evidente.",
    "- Evidencia objetiva fuerte significa: imagen/captura/foto analizada con confidence >= 0.85 o hasStrongEvidence=true, y que confirme hora de llegada/meta o tiempo GPS coherente con el reclamo. Para Strava/Garmin/GPS acepta como fuerte si el reclamo estructurado ya trae competitionId, dorsal y atleta, y la imagen muestra nombre compatible o contexto del evento, fecha/lugar compatibles, distancia coherente y tiempo solicitado.",
    "- Para EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION extrae: competitionId, dorsal, athleteName, currentValue, requestedValue, evidenceFinishTime o evidenceFinishDateTime, activityStartDateTime, gpsElapsedTime/evidenceElapsedTime, evidenceConfidence, evidenceSummary, hasStrongEvidence=true cuando aplique, trustAthleteEvidence/evidencePolicy cuando aplique, targetField='tiempo'.",
    "- En eventos configurados con type_salidas='tiempo_chip', una correccion de tiempo requiere una salida individual y una meta coherentes. La accion conserva cualquier loc_Salida ya asignada; si falta, puede derivarla como hora meta menos duracion solicitada y asignar ambos raws. Solo usa esta accion si la evidencia permite conocer tanto la duracion como la hora meta.",
    "- Nunca confirmes como exitosa una correccion de tiempo cuya verificacion posterior sea false. En ese caso indica que la escritura no quedo validada y que el caso pasa a revision humana.",
    "- Si la evidencia GPS muestra hora de inicio de actividad y duracion/tiempo en movimiento, usa activityStartDateTime + gpsElapsedTime para que el sistema calcule hora meta estimada. Una duracion como 02:09:54 siempre va en gpsElapsedTime/evidenceElapsedTime, nunca en evidenceFinishTime. No pongas la hora de inicio como evidenceFinishDateTime salvo que sea realmente hora de llegada.",
    "- Antes de corregir tiempo automaticamente, si existe tiempo oficial, la diferencia entre tiempo oficial y solicitado debe ser significativa, aproximadamente mayor a 2 minutos. Si no hay tiempo registrado/publicado o el resultado esta en carrera, puedes corregir sin esa comparacion cuando la evidencia fuerte o TRUST_ATHLETE_EVIDENCE permita calcular la hora meta. Si hay conflicto de datos grave, multiples atletas posibles, dorsal incompatible, competencia no clara o la imagen corresponde a otra competencia, needsHuman=true.",
    "- Si un atleta envia un reclamo estructurado desde la web publica con competitionId, dorsal y valor correcto, puedes ejecutar cambios permitidos sin humano.",
    "- Para cambiar dorsal usa EXOTIMER_UPDATE_RESULT_DORSAL con competitionId, dorsal actual en dorsal/currentDorsal, targetField, currentValue, requestedValue y newDorsal. Al cambiar dorsal, el sistema tambien debe cambiar chip al nuevo dorsal salvo que el usuario indique explicitamente un chip distinto.",
    "- Para cambiar distancia, genero o categoria usa EXOTIMER_UPDATE_RESULT_EVENT_CATEGORY con competitionId, dorsal, targetField, currentValue, requestedValue y newDistance/newGender/newCategory segun corresponda. No inventes categorias: si el usuario dice 'categoria correspondiente a mi edad', incluye participantAge/edad y deja que el backend resuelva una categoria real del evento. Si conoces la categoria exacta, debe coincidir con una opcion existente.",
    "- Despues de acciones de cambio de resultado, responde que fue corregido solo si la accion ejecutada devuelve verificacion o changed.after coherente. Si la accion falla o no hay verificacion, explica que se escalara a revision humana.",
    "- Para cambiar nombre, apellido u otros datos personales visibles del participante usa EXOTIMER_UPDATE_RESULT_PARTICIPANT_DATA con competitionId, dorsal, targetField, currentValue, requestedValue y participantName/participantLastname cuando corresponda.",
    "- En estos cambios permitidos de atleta, usa needsHuman=false si tienes competitionId o competitionName, dorsal/resultId y el valor correcto solicitado. Si falta algun dato esencial, usa action=null y pide el dato faltante.",
    "- Para atletas, consulta primero inscripcion/resultados cuando existan evento y dorsal. Registra EXOTIMER_CREATE_RESULT_CORRECTION_CASE solo cuando haya datos minimos del caso y una correccion/reporte concreto.",
    "- Para atletas con problemas de inscripcion, correo de confirmacion, pago, voucher, no aparezco inscrito, correo mal escrito o no me llego el email: clasifica como ATHLETE, no como ORGANIZER.",
    "- Para esos casos de inscripcion usa EXOTIMER_GET_INSCRIPTION_BY_REFERENCE_OR_DOCUMENT si tienes competitionId o competitionName y al menos uno de: inscriptionReference, document/dni, email, phone o participantName. No pidas dorsal para inscripciones.",
    "- Si el usuario pasa a consultar la inscripcion de otra persona, reemplaza todos los identificadores de la persona anterior. Nunca combines DNI/nombre de una persona con correo, telefono, referencia o evidencia de otra.",
    "- Cuando haya varios participantes en el mismo chat, ejecuta una accion por participante y afirma solo lo que devuelve lookup.bestMatch/changed para esa persona. No digas que actualizaste o enviaste datos de ambos si la accion solo afecto una inscripcion.",
    "- Si el usuario adjunta comprobante de pago o la imagen analizada indica paymentEvidence/hasStrongEvidence, usa EXOTIMER_VALIDATE_PAYMENT_EVIDENCE con competitionId, inscriptionReference/document/email/phone/participantName y paymentEvidence. Esta accion solo verifica; no aprueba pagos ni afirma que el correo fue reenviado.",
    "- Si el usuario dice que ingreso mal su correo y da el correo correcto, puedes usar EXOTIMER_UPDATE_INSCRIPTION_EMAIL con competitionId, referencia/DNI/email/phone/nombre para ubicar la inscripcion y newEmail/correctEmail/requestedEmail. Usa needsHuman=false solo si hay una unica coincidencia clara por DNI o referencia; si solo coincide por nombre, needsHuman=true.",
    "- Si el usuario reclama que en su inscripcion eligio mal distancia, genero o categoria, usa EXOTIMER_UPDATE_INSCRIPTION_EVENT_CATEGORY con competitionId o competitionName, referencia/DNI/email/phone/nombre, targetField y newDistance/newGender/newCategory o requestedValue. Usa needsHuman=false si hay una unica coincidencia clara por DNI, referencia, email o telefono y el valor correcto esta disponible.",
    "- Si el usuario no recibio el correo de confirmacion y tienes competitionId o competitionName mas referencia/DNI/email/telefono/nombre, usa EXOTIMER_RESEND_INSCRIPTION_CONFIRMATION para verificar y recuperar su confirmacion. La API nueva no reenvia correos: no afirmes que el email fue reenviado; ofrece enviar el comprobante por WhatsApp.",
    "- Si el usuario pide recibir el comprobante, QR o confirmacion por WhatsApp, usa EXOTIMER_SEND_INSCRIPTION_CONFIRMATION_WHATSAPP con competitionId y los datos de busqueda disponibles. Usa needsHuman=false si hay una unica inscripcion clara por DNI, email, telefono o referencia.",
    "- Para consultas operativas urgentes sin fuente verificada, como ubicacion de recojo de kit el ultimo dia, no inventes ni repitas recomendaciones genericas. Usa action=null, needsHuman=true, explica que falta informacion oficial y solicita atencion inmediata del organizador.",
    forcedTimer
      ? "- Para TIMER que pide crear/configurar una competencia, usa primero EXOTIMER_PREVIEW_COMPETITION_SETUP. El preview no escribe datos: analiza chat, afiche o PDF, resuelve catalogos, detecta duplicados y prepara competencia, eventos, categorias, timing, tickets, pagos y archivos."
      : "",
    forcedTimer
      ? "- Para EXOTIMER_PREVIEW_COMPETITION_SETUP extrae y conserva todo lo disponible: competitionName, eventDate, startTime, endTime, venueName, city, country, sport, organizer, status, visibility, registrationDeadline, events, categories, tickets, payment, website, rulesSummary y waveSize. No inventes valores ilegibles."
      : "",
    forcedTimer
      ? "- Estructura events como [{name,distanceMeters,startTime,venueName,categories:[{name,genderRule,minAge,maxAge}],waveSize}]. Estructura tickets como [{title,price,currency,status,eventName,categoryNames,teamSize,startsAt,endsAt}]. Estructura payment como {type,bank,account,cci,details}."
      : "",
    forcedTimer
      ? "- Un ticket es una opcion de compra, no una categoria. Si Open y Pro tienen exactamente el mismo precio, moneda, vigencia, cupo, teamSize y condiciones, genera un solo ticket por evento/distancia y vincula todas sus categorias validas. Solo separalos si cambia una condicion comercial o el Timer lo pide expresamente."
      : "",
    forcedTimer
      ? "- Trata la lista de categorias indicada por el Timer como exhaustiva: no inventes variantes simetricas ausentes. Si se mencionan niveles Open/Pro pero no sus combinaciones exactas, deja que el preview solicite categoryTierDefinitions."
      : "",
    forcedTimer
      ? "- Cada ticket debe usar categoryNames que pertenezcan exclusivamente a su eventName. No mezcles categorias entre Individual, Duplas u otras distancias."
      : "",
    forcedTimer
      ? "- Si el preview devuelve readyToApply=true, resume el plan y pide confirmacion explicita. No uses EXOTIMER_APPLY_COMPETITION_SETUP en el mismo turno del preview."
      : "",
    forcedTimer
      ? "- Cuando el Timer responda confirmo, crear, procede o equivalente sobre un preview listo, cambia a EXOTIMER_APPLY_COMPETITION_SETUP, conserva plan completo sin modificarlo, agrega confirmed=true y usa needsHuman=false. Nunca reconstruyas ni resumas el objeto plan."
      : "",
    forcedTimer
      ? "- EXOTIMER_CREATE_COMPETITION_FROM_BASES y EXOTIMER_CREATE_COMPETITION_FROM_CHAT quedan solo para compatibilidad con conversaciones antiguas. No los elijas en conversaciones nuevas."
      : "",
    forcedTimer
      ? "- Si el organizador falta y el Timer autoriza Sin Asignar, usa organizer='Sin Asignar' y allowUnassignedOrganizer=true. Si no lo autoriza, pide organizador o autorizacion para Sin Asignar."
      : "",
    forcedTimer
      ? "- No inventes categorias. Si el Timer no las especifica o dice que se cargaran despues con listado, usa createCategories=false."
      : "",
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
    forcedTimer ? buildTimerAssistantKnowledge() : "",
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
    return "Hola, Timer identificado. Indicame si necesitas crear/configurar una competencia o revisar una competencia, punto de control, salida o cambio tecnico.";
  }
  return "Hola, gracias por escribir a Finisher Data. Cuentame si consultas por inscripciones o resultados de un evento?";
}

function sanitizeExternalReply(reply, channel = "WHATSAPP") {
  const text = String(reply || "");
  if (channel !== "WHATSAPP") return text;

  return text
    .replace(
      /\b(?:https?:\/\/)?(?:cloud\.)?exotimer\.com(?:\/\S*)?/gi,
      "la plataforma de resultados"
    )
    .replace(
      /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)?raceline\.app(?:\/\S*)?/gi,
      "nuestro sistema"
    )
    .replace(/\bEXOTIMER_[A-Z0-9_]+\b/gi, "la operacion solicitada")
    .replace(
      /\b(?:Exo[\s_-]*Timer|Race[\s_-]*Line)\b/gi,
      "nuestro sistema de resultados"
    );
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
  const operationalKnowledge =
    channel === "EXOTIMER"
      ? buildExotimerAssistantKnowledge()
      : userType === "TIMER"
        ? buildTimerAssistantKnowledge()
        : "";

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
            "No prometas que avisaras automaticamente cuando haya novedades, porque no existe un disparador garantizado de seguimiento. Indica el estado actual y, si queda pendiente, pide que el equipo humano lo revise o que el usuario vuelva a consultar.",
            channel === "WHATSAPP"
              ? "Nunca menciones ExoTimer, Race Line, nombres internos de acciones, endpoints, APIs, bases de datos ni detalles tecnicos de integracion. Para el cliente externo di 'nuestro sistema de resultados', 'la plataforma de resultados' o 'nuestro sistema de inscripciones', segun corresponda."
              : "",
            "Menciona como atendido, enviado o modificado solamente al participante identificado en actionResult.lookup.bestMatch o actionResult.changed. Nunca extiendas una accion individual a otras personas del chat.",
            "Si actionResult.idempotentReplay=true, explica el resultado ya existente sin afirmar que se volvio a ejecutar o enviar.",
            "Si contextActionResult.followUpResolution.type es RESULT_ALREADY_UPDATED, informa que ya verificaste el resultado en el sistema, menciona tiempo oficial, distancia/evento y dorsal actual, pide actualizar la pagina de resultados y cierra amablemente sin decir que sigue en revision.",
            "Si contextActionResult.followUpResolution.type es RESULT_TIME_UPDATED_DORSAL_PENDING, informa que el tiempo ya figura actualizado, pero que el dorsal visible aun queda pendiente de revision. Menciona el dorsal actual y el dorsal solicitado.",
            "Si se ejecuto EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION, confirma la correccion y pide refrescar la pagina solo cuando actionResult.verification.verified=true. Si es false, informa que la escritura se intento pero la lectura posterior aun no coincide y que el caso queda en revision.",
            "Si se ejecuto EXOTIMER_CHECK_VIDEO_FINISH_AVAILABILITY y actionResult.available=true, comparte exactamente actionResult.publicRecoveryUrl. Indica que debe buscar su llegada, ubicar el instante preciso y usar los botones de la pagina para enviar por WhatsApp el hallazgo generado. Si available=false, explica brevemente el motivo indicado en actionResult.reason y no compartas enlace.",
            "Si se ejecuto EXOTIMER_VALIDATE_VIDEO_FINISH_FINDING, informa si el hallazgo quedo validado, pero no afirmes que el tiempo fue corregido porque esa accion solo consulta.",
            "Si una correccion usa actionResult.evidencePolicy=VIDEO_FINISH_SELF_SERVICE, explica que el hallazgo de Video Finish fue validado contra el evento y confirma el nuevo tiempo solo si actionResult.verification.verified=true.",
            "Si se ejecuto EXOTIMER_RESEND_INSCRIPTION_CONFIRMATION, informa que verificaste la inscripcion, aclara que la API nueva no permite reenviar el email y ofrece enviar el comprobante por WhatsApp. Nunca afirmes que el correo fue reenviado.",
            "Si se ejecuto EXOTIMER_SEND_INSCRIPTION_CONFIRMATION_WHATSAPP, informa que el comprobante PDF con su codigo de confirmacion fue enviado por WhatsApp y que puede revisarlo en este chat.",
            "Si classification.action es EXOTIMER_PREVIEW_COMPETITION_SETUP y actionResult.preview=true, resume nombre, fecha, estado, sede, organizador, eventos, categorias, tickets, precios, pago y archivos. Si readyToApply=true pide una confirmacion explicita para aplicar exactamente ese plan. Si es false, pide solo missingFields y explica duplicados o warnings importantes.",
            "Si classification.action es EXOTIMER_APPLY_COMPETITION_SETUP y actionResult.complete=true, informa el competitionId y confirma que competencia, eventos, categorias, timing, tickets, pagos y archivos fueron verificados. Si needsRepair=true, no afirmes que termino: informa el competitionId, los pasos fallidos y que el flujo puede reanudarse sin duplicar.",
            "Para las acciones antiguas EXOTIMER_CREATE_COMPETITION_FROM_BASES y EXOTIMER_CREATE_COMPETITION_FROM_CHAT conserva el mismo criterio: solo confirma exito si actionResult.complete=true.",
            channel === "EXOTIMER"
              ? "Si la consulta es informativa, responde como asistente operativo usando el manual y contexto de ExoTimer. Si se ejecuto una accion, resume que se hizo y que debe revisar el usuario."
              : "",
            userType === "TIMER"
              ? "El usuario esta identificado como TIMER por telefono registrado. Puedes orientarlo con conocimiento operativo de creacion/configuracion de competencias, pero no afirmes escrituras si no hubo accion ejecutada."
              : "",
            operationalKnowledge,
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
          "Analiza imagenes enviadas como evidencia o bases/afiche para soporte de cronometraje deportivo. Devuelve JSON estricto, breve y util. No inventes datos ilegibles. Si la imagen es afiche/bases de evento, extrae nombre, fecha, sede, ciudad/pais, deporte, organizador, modalidades/eventos, categorias, tickets con precios numericos, cierre de inscripciones y datos de pago. Un ticket es una opcion de compra, no una categoria: si varios niveles comparten exactamente las mismas condiciones comerciales, devuelve un solo ticket por evento/distancia con todas sus categoryNames. No inventes combinaciones simetricas de categorias que no aparezcan. Para equipos conserva teamSize. Para capturas GPS/Strava/Garmin, distingue hora de inicio de actividad (activityStartDateTime), duracion (gpsElapsedTime) y hora real de meta/llegada (evidenceFinishDateTime). Nunca copies una duracion como 02:09:54 dentro de evidenceFinishTime. Marca hasStrongEvidence=true si la imagen muestra nombre compatible o contexto claro, fecha/lugar compatibles, distancia coherente y tiempo/duracion del reclamo con confidence >= 0.85, aunque no sea una fuente oficial. Si la imagen solo aporta una pieza parcial fuerte, explicalo en evidenceSummary para que el hilo completo pueda usarse bajo TRUST_ATHLETE_EVIDENCE.",
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
                  eventName: null,
                  eventDate: null,
                  city: null,
                  country: null,
                  sport: null,
                  organizer: null,
                  distances: [],
                  website: null,
                  startTime: null,
                  endTime: null,
                  venueName: null,
                  registrationDeadline: null,
                  runningDistanceMeters: null,
                  waveSize: null,
                  events: [
                    {
                      name: null,
                      distanceMeters: null,
                      categories: [
                        {
                          name: null,
                          genderRule: null,
                          minAge: null,
                          maxAge: null,
                        },
                      ],
                    },
                  ],
                  tickets: [
                    {
                      title: null,
                      price: null,
                      currency: "PEN",
                      eventName: null,
                      categoryNames: [],
                      teamSize: 1,
                    },
                  ],
                  payment: {
                    type: null,
                    bank: null,
                    account: null,
                    cci: null,
                    details: null,
                  },
                  rulesSummary: null,
                  workoutOrder: [],
                  time: null,
                  evidenceFinishTime: null,
                  evidenceFinishDateTime: null,
                  activityStartDateTime: null,
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

async function analyzeDocumentEvidence({
  buffer,
  mimeType,
  filename,
  caption,
  conversationContext,
}) {
  const client = getClient();
  if (!client || !buffer) return null;
  if (
    !String(mimeType || "").includes("pdf") &&
    !String(filename || "").toLowerCase().endsWith(".pdf")
  ) {
    return {
      summary: "Documento recibido. El analisis estructurado admite reglamentos y bases en PDF.",
      extracted: {},
      relevance: "media",
      confidence: 0.2,
    };
  }
  if (Buffer.byteLength(buffer) > 20 * 1024 * 1024) {
    return {
      summary: "El PDF fue recibido, pero excede el tamano permitido para el analisis automatico.",
      extracted: {},
      relevance: "media",
      confidence: 0,
    };
  }

  const expectedJson = {
    summary: "resumen breve del documento",
    visibleText: ["datos relevantes"],
    extracted: {
      competitionName: null,
      eventDate: null,
      startTime: null,
      endTime: null,
      venueName: null,
      city: null,
      country: null,
      sport: null,
      organizer: null,
      website: null,
      registrationDeadline: null,
      runningDistanceMeters: null,
      waveSize: null,
      events: [
        {
          name: null,
          distanceMeters: null,
          startTime: null,
          venueName: null,
          categories: [
            {
              name: null,
              genderRule: "Masculino|Femenino|Mixto",
              minAge: null,
              maxAge: null,
            },
          ],
        },
      ],
      tickets: [
        {
          title: null,
          price: null,
          currency: "PEN",
          eventName: null,
          categoryNames: [],
          teamSize: 1,
          startsAt: null,
          endsAt: null,
        },
      ],
      payment: {
        type: null,
        bank: null,
        account: null,
        cci: null,
        details: null,
      },
      rulesSummary: null,
      workoutOrder: [],
    },
    assumptions: [],
    warnings: [],
    relevance: "alta|media|baja",
    confidence: 0,
  };
  const response = await client.responses.create({
    model: config.openai.model,
    instructions:
      "Analiza reglamentos, bases y brochures de eventos deportivos para configurar Race Line. Devuelve JSON estricto. Extrae solo datos presentes o inferencias muy seguras y coloca toda inferencia en assumptions. Las modalidades competitivas son eventos; los segmentos internos de una prueba no son tickets. Un ticket es una opcion de compra: si OPEN y PRO comparten exactamente precio, moneda, vigencia, cupo, teamSize y condiciones, devuelve un solo ticket por evento/distancia con todas sus categoryNames; separalos solo si cambia una condicion comercial. Conserva exactamente las categorias descritas y no inventes combinaciones simetricas ausentes. Conserva tickets solo con precios numericos reales, vigencia, datos bancarios, sede y reglas operativas. No inventes organizador, precio, cuenta ni categoria.",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              caption,
              conversationContext,
              expectedJson,
            }),
          },
          {
            type: "input_file",
            filename: filename || "bases-evento.pdf",
            file_data: `data:${mimeType || "application/pdf"};base64,${Buffer.from(
              buffer
            ).toString("base64")}`,
          },
        ],
      },
    ],
  });

  const parsed = parseJson(response.output_text);
  return (
    parsed || {
      summary:
        response.output_text?.trim() ||
        "Documento recibido para configurar el evento.",
      extracted: {},
      relevance: "media",
      confidence: 0.4,
    }
  );
}

module.exports = {
  analyzeDocumentEvidence,
  analyzeImageEvidence,
  classifyMessage,
  composeReply,
  sanitizeExternalReply,
};
