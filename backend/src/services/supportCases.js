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

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function normalizeAthlete(value) {
  if (!value) return null;
  if (typeof value === "string") return { name: value, dorsal: null };
  if (typeof value !== "object") return null;

  const name = value.name || value.athleteName || value.participant || null;
  const dorsal = value.dorsal || value.bib || null;
  if (!name && !dorsal) return null;
  return {
    name: name ? String(name) : null,
    dorsal: dorsal ? String(dorsal) : null,
  };
}

function mergeDorsals(existing = [], input = {}) {
  const athletes = [
    ...asArray(input.detectedAthletes),
    ...asArray(input.athletes),
    ...asArray(input.participants),
  ]
    .map(normalizeAthlete)
    .filter(Boolean);

  return uniqueStrings([
    ...asArray(existing),
    ...asArray(input.detectedDorsals),
    ...asArray(input.dorsals),
    ...asArray(input.bibs),
    input.dorsal,
    input.bib,
    ...athletes.map((athlete) => athlete.dorsal),
  ]);
}

function mergeAthletes(existing = [], input = {}) {
  const current = asArray(existing).map(normalizeAthlete).filter(Boolean);
  const incoming = [
    ...asArray(input.detectedAthletes),
    ...asArray(input.athletes),
    ...asArray(input.participants),
    normalizeAthlete({ name: input.athleteName || input.participant || input.name, dorsal: input.dorsal || input.bib }),
  ].filter(Boolean);

  const byKey = new Map();
  for (const athlete of [...current, ...incoming]) {
    const key = athlete.dorsal || athlete.name;
    if (!key) continue;
    byKey.set(String(key), {
      name: athlete.name || byKey.get(String(key))?.name || null,
      dorsal: athlete.dorsal || byKey.get(String(key))?.dorsal || null,
    });
  }

  return [...byKey.values()];
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
    detectedDorsals: mergeDorsals(existing?.detectedDorsals, input),
    detectedAthletes: mergeAthletes(existing?.detectedAthletes, input),
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
