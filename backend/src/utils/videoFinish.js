const { normalizeDorsal } = require("./dorsal");

const VIDEO_FINISH_EVIDENCE_POLICY = "VIDEO_FINISH_SELF_SERVICE";

function normalizeLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function cleanGeneratedValue(value) {
  const text = String(value || "").trim();
  if (!text || normalizeLabel(text) === "no especificado") return null;
  return text;
}

function messageFields(text) {
  const fields = new Map();
  String(text || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) return;
      const key = normalizeLabel(line.slice(0, separator));
      const value = cleanGeneratedValue(line.slice(separator + 1));
      if (key && value) fields.set(key, value);
    });
  return fields;
}

function normalizeVideoFinishClock(value) {
  const text = String(value || "").trim();
  const clock = text.match(/(?:^|T|\s)([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?/);
  if (!clock) return null;
  return `${String(clock[1]).padStart(2, "0")}:${clock[2]}:${clock[3] || "00"}`;
}

function parseVideoFinishFindingMessage(text) {
  const normalized = normalizeLabel(text);
  if (
    !normalized.includes("[hallazgo generado por finisher data]") ||
    !normalized.includes("recuperacion autoservicio de resultado")
  ) {
    return null;
  }

  const fields = messageFields(text);
  const competitionId = fields.get("id evento") || null;
  const dorsal = normalizeDorsal(fields.get("dorsal declarado"));
  const participantName = fields.get("nombre completo") || null;
  const distance = fields.get("distancia declarada") || null;
  const estimatedTime = fields.get("hora aproximada indicada") || null;
  const markedTime = fields.get("hora marcada en el evento") || null;
  const cameraTimestamp = fields.get("timestamp exacto de camara") || null;
  const recordingStart = fields.get("inicio de la grabacion revisada") || null;
  const visualDetail = fields.get("detalle visual") || null;

  return {
    competitionId,
    competitionName: fields.get("evento") || null,
    eventDate: fields.get("fecha") || null,
    participantName,
    athleteName: participantName,
    dorsal,
    videoFinishDistance: distance,
    distance,
    videoFinishEstimatedTime: estimatedTime,
    videoFinishMarkedTime: markedTime,
    videoFinishCameraTimestamp: cameraTimestamp,
    videoFinishRecordingStart: recordingStart,
    videoFinishVisualDetail: visualDetail,
    videoFinishPageUrl: fields.get("url de busqueda") || null,
    videoFinishFinding: true,
    evidencePolicy: VIDEO_FINISH_EVIDENCE_POLICY,
    evidenceFinishDateTime: cameraTimestamp,
    evidenceSummary: [
      "Hallazgo de recuperacion autoservicio de Video Finish.",
      visualDetail ? `Detalle visual: ${visualDetail}.` : null,
    ]
      .filter(Boolean)
      .join(" "),
    targetField: "tiempo",
  };
}

function isVideoFinishEvidence(input = {}) {
  return (
    input.videoFinishFinding === true ||
    String(input.evidencePolicy || input.policyMode || "").toUpperCase() ===
      VIDEO_FINISH_EVIDENCE_POLICY
  );
}

module.exports = {
  VIDEO_FINISH_EVIDENCE_POLICY,
  isVideoFinishEvidence,
  normalizeVideoFinishClock,
  parseVideoFinishFindingMessage,
};
