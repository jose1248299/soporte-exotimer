const { normalizeDorsal } = require("../utils/dorsal");

function canonicalizeResultInput(input = {}, actions = [], actionName) {
  const result = { ...input };
  const competitionId = input.competitionId || input.competition_id;
  for (const action of [...actions].sort((a, b) => a.id - b.id)) {
    if (action.status !== "EXECUTED" || action.name !== "EXOTIMER_UPDATE_RESULT_DORSAL") continue;
    const change = action.output?.changed;
    if (!competitionId || String(change?.competitionId) !== String(competitionId)) continue;
    const oldDorsal = normalizeDorsal(change.before?.dorsal);
    const newDorsal = normalizeDorsal(change.after?.dorsal);
    const references = [result.currentDorsal, result.dorsal, result.bib, result.oldDorsal, result.previousDorsal].filter(Boolean).map(normalizeDorsal);
    if (!newDorsal || !references.length || references.some(ref => ref !== oldDorsal && ref !== newDorsal)) continue;
    if (result.resultId && String(result.resultId) !== String(change.resultId)) continue;
    result.resultId = change.resultId;
    result.dorsal = newDorsal;
    result.currentDorsal = newDorsal;
    delete result.oldDorsal;
    delete result.previousDorsal;
    delete result.bib;
    if (actionName !== "EXOTIMER_UPDATE_RESULT_DORSAL") {
      delete result.newDorsal;
      delete result.correctDorsal;
      delete result.requestedDorsal;
    }
  }
  return result;
}

function compactAction(action) {
  const input = Object.fromEntries(Object.entries(action.input || {}).filter(([key]) =>
    ["competitionId", "competition_id", "resultId", "dorsal", "currentDorsal", "newDorsal", "participantName", "participantLastname", "targetField", "requestedValue"].includes(key)));
  return {
    id: action.id, name: action.name, status: action.status,
    input, error: action.error,
    output: action.output ? {
      changed: action.output.changed,
      verification: action.output.verification,
      type: action.output.type,
      reusedFromActionId: action.output.reusedFromActionId,
    } : null,
  };
}

const normalized = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const distanceKey = value => normalized(value).replace(/kilometros|kilometers|km/g, "k").replace(/\s/g, "");

function applyAthleteReviewPolicy(classification, context, history, actions) {
  if (/agradec|desped|thanks|greeting/.test(normalized(classification.intent))) return classification;
  const result = context?.result;
  if (classification.userType !== "ATHLETE" || !result || String(context.competitionId) !== String(classification.actionInput?.competitionId)) return classification;
  const input = { ...classification.actionInput };
  if (String(input.resultId || result.resultId) !== String(result.resultId) ||
      String(normalizeDorsal(input.dorsal || input.currentDorsal)) !== String(result.dorsal)) return classification;
  const claim = history.filter(m => m.direction === "INBOUND").map(m => m.content || "").join("\n");
  const timeClaim = /tiempo|reloj|watch|garmin|strava/i.test(`${input.targetField || ""} ${input.requestedCorrection || ""}`) ||
    (!input.targetField && /reloj|watch|garmin|strava/i.test(claim));
  const distance = input.declaredDistance || input.distance || input.eventName || input.currentDistance;
  if (timeClaim && distance && result.distance && distanceKey(distance) !== distanceKey(result.distance)) {
    return { ...classification, action: null, needsHuman: false,
      actionInput: { ...input, evidenceConflict: "distance_mismatch" },
      remainingRequests: [`Confirmar distancia: declarada ${distance}, registrada ${result.distance}.`],
      summary: `Antes de corregir el tiempo, el atleta debe aclarar si corrio ${distance} o ${result.distance}.` };
  }
  const failedWrite = [...actions].reverse().find(a => a.status === "FAILED" && a.name === "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION" &&
    String(a.output?.changed?.resultId) === String(result.resultId) && a.output?.changed?.evidenceFinishDateTime);
  const assignedMeta = context.timing?.assignments?.find(raw => raw.point_control === "loc_Meta");
  if (timeClaim && (!classification.action || /TIME_EVIDENCE_CORRECTION|CREATE_RESULT_CORRECTION_CASE/.test(classification.action)) &&
      failedWrite && String(failedWrite.output.changed.createdRawId) === String(assignedMeta?.id) &&
      String(failedWrite.output.changed.evidenceFinishDateTime).slice(0, 19) === String(assignedMeta?.hour).slice(0, 19)) {
    return { ...classification, action: "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION", needsHuman: false,
      actionInput: { ...input, resultId: result.resultId, targetField: "tiempo",
        evidenceFinishDateTime: failedWrite.output.changed.evidenceFinishDateTime },
      remainingRequests: (classification.remainingRequests || []).filter(value => !/tiempo|evidencia|verifica|revisi[oó]n/i.test(value)), summary: "Revalidar la llegada ya asignada con la configuracion vigente, sin duplicar el raw." };
  }
  const hasStart = context.timing?.assignments?.some(raw => raw.id && raw.point_control === "loc_Salida");
  const athleteName = normalized(input.athleteName || input.participantName);
  const actualName = normalized(`${result.athleteName} ${result.athleteLastname || ""}`);
  const nameMatches = athleteName.split(/\s+/).filter(token => token.length > 2 && actualName.split(/\s+/).includes(token)).length >= 2;
  const duration = input.gpsElapsedTime || input.evidenceElapsedTime || input.requestedValue;
  const declaredWatch = /reloj|apple watch|garmin|strava|gps/i.test(claim);
  if (timeClaim && !result.officialTime && hasStart && nameMatches && declaredWatch && /^\d{1,3}:\d{2}:\d{2}$/.test(duration || "") &&
      (!classification.action || classification.action === "EXOTIMER_CREATE_RESULT_CORRECTION_CASE")) {
    delete input.approximateTime;
    return { ...classification, action: "EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION", needsHuman: false,
      actionInput: { ...input, resultId: result.resultId, targetField: "tiempo", declaredDistance: result.distance,
        gpsElapsedTime: duration, requestedValue: duration, evidencePolicy: "TRUST_ATHLETE_EVIDENCE", trustAthleteEvidence: true,
        evidenceSummary: "El atleta declara duracion de su reloj; identidad y distancia coinciden y existe salida individual registrada. " + (input.evidenceSummary || "") },
      remainingRequests: (classification.remainingRequests || []).filter(value => !/tiempo|evidencia|reloj/i.test(value)), summary: "Recuperar tiempo desde la salida individual y duracion declarada del reloj; identidad y distancia verificadas." };
  }
  if (!classification.action && /sin asignar/i.test(result.athleteName || "") && athleteName.split(/\s+/).length >= 2) {
    const words = String(input.athleteName || input.participantName).trim().split(/\s+/);
    const lastCount = words.length >= 3 ? 2 : 1;
    return { ...classification, action: "EXOTIMER_UPDATE_RESULT_PARTICIPANT_DATA", needsHuman: false,
      actionInput: { competitionId: context.competitionId, resultId: result.resultId, dorsal: String(result.dorsal),
        targetField: "datos personales", participantName: words.slice(0, -lastCount).join(" "), participantLastname: words.slice(-lastCount).join(" ") },
      remainingRequests: (classification.remainingRequests || []).filter(value => !/nombre|identidad|sin asignar/i.test(value)), summary: "Completar identidad del resultado Sin Asignar con el nombre informado por la atleta en el reclamo." };
  }
  if (!classification.action && result.officialTime && /discrep|incorrect|no coincide|no cuadra/.test(normalized(input.requestedCorrection))) {
    const clock = String(result.finishTime || "").match(/T(\d{2}:\d{2}:\d{2})/)?.[1];
    return { ...classification, action: clock ? "EXOTIMER_CHECK_VIDEO_FINISH_AVAILABILITY" : null, needsHuman: false,
      actionInput: { ...input, ...(clock ? { approximateTime: clock } : {}) },
      remainingRequests: ["Obtener el hallazgo exacto de su llegada en Video Finish o el tiempo correcto; el tiempo publicado sigue en disputa."],
      summary: "El tiempo publicado no resuelve la discrepancia. Ofrecer recuperacion Video Finish y solicitar el hallazgo exacto antes de corregir." };
  }
  return classification;
}

function requestedChangeAlreadySatisfied(classification, context, actions) {
  const result = context?.result;
  const input = classification.actionInput || {};
  if (classification.action || classification.needsHuman || !result || classification.remainingRequests?.length !== 0) return false;
  if (String(input.competitionId) !== String(context.competitionId) || String(input.dorsal || input.currentDorsal) !== String(result.dorsal)) return false;
  const target = normalized(input.targetField);
  const requested = normalized(input.requestedValue);
  if (target === "categoria") return normalized(input.newCategory || requested) === normalized(result.category);
  if (target === "apellido") return requested === normalized(result.athleteLastname);
  if (target === "dorsal") return String(input.newDorsal || input.requestedValue) === String(result.dorsal) || Boolean(result.officialTime && actions.some(action =>
    action.status === "EXECUTED" && action.name === "EXOTIMER_UPDATE_RESULT_DORSAL" &&
    String(action.output?.changed?.resultId) === String(result.resultId) && String(action.output?.changed?.after?.dorsal) === String(result.dorsal)));
  return false;
}

module.exports = { canonicalizeResultInput, compactAction, applyAthleteReviewPolicy, requestedChangeAlreadySatisfied };
