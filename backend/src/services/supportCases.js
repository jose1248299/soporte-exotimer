const prisma = require("../lib/prisma");

const OPEN_CASE_STATUSES = ["OPEN", "WAITING_CLARIFICATION", "WAITING_HUMAN"];

function pickCompetitionId(input = {}) {
  const value = input.competitionId || input.competition_id || input.competition;
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : null;
}

function pickDorsal(input = {}) {
  const value = input.dorsal || input.bib;
  return value == null || value === "" ? null : String(value);
}

function pickAthleteName(input = {}) {
  const value = input.athleteName || input.participant || input.name;
  return value == null || value === "" ? null : String(value);
}

function buildSubject(classification = {}) {
  const input = classification.actionInput || {};
  if (classification.intent) return String(classification.intent);
  if (classification.action) return String(classification.action);
  if (input.requestedCorrection) return String(input.requestedCorrection).slice(0, 120);
  return "Solicitud de soporte";
}

function statusFromClassification(classification = {}) {
  const input = classification.actionInput || {};
  if (Array.isArray(input.missingFields) && input.missingFields.length) return "WAITING_CLARIFICATION";
  if (classification.needsHuman) return "WAITING_HUMAN";
  return "OPEN";
}

async function findOrCreateSupportCase({ conversationId, userType, classification, timestamp }) {
  const input = classification?.actionInput || {};
  const competitionId = pickCompetitionId(input);
  if (!competitionId) return null;

  const dorsal = pickDorsal(input);
  const athleteName = pickAthleteName(input);
  const where = {
    conversationId,
    competitionId,
    status: { in: OPEN_CASE_STATUSES },
    ...(dorsal ? { dorsal } : {}),
  };

  const existing = await prisma.supportCase.findFirst({
    where,
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
  });

  const data = {
    userType,
    status: statusFromClassification(classification),
    athleteName: athleteName || existing?.athleteName || null,
    dorsal: dorsal || existing?.dorsal || null,
    subject: buildSubject(classification),
    summary: classification?.summary || existing?.summary || null,
    classification,
    lastMessageAt: timestamp || new Date(),
  };

  if (existing) {
    return prisma.supportCase.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.supportCase.create({
    data: {
      conversationId,
      competitionId,
      ...data,
    },
  });
}

module.exports = {
  findOrCreateSupportCase,
  pickCompetitionId,
};
