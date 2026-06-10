const DORSAL_FIELDS = [
  "dorsal",
  "bib",
  "currentDorsal",
  "oldDorsal",
  "previousDorsal",
  "newDorsal",
  "dorsalNew",
  "correctDorsal",
];

function normalizeDorsal(value) {
  if (value === undefined || value === null || value === "") return value;
  const text = String(value).trim();
  if (!text) return "";
  if (!/^\d+$/.test(text)) return text;
  return String(Number(text));
}

function normalizeDorsalList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map(normalizeDorsal)
    .filter((item) => item !== undefined && item !== null && item !== "" && item !== "undefined");
}

function normalizeAthleteDorsal(value) {
  if (!value || typeof value !== "object") return value;
  const next = { ...value };
  if (next.dorsal !== undefined) next.dorsal = normalizeDorsal(next.dorsal);
  if (next.bib !== undefined) next.bib = normalizeDorsal(next.bib);
  return next;
}

function normalizeDorsalReferences(input = {}) {
  if (!input || typeof input !== "object") return input;
  const next = { ...input };

  for (const field of DORSAL_FIELDS) {
    if (next[field] !== undefined) next[field] = normalizeDorsal(next[field]);
  }

  for (const field of ["detectedDorsals", "dorsals", "bibs"]) {
    if (next[field] !== undefined) next[field] = normalizeDorsalList(next[field]);
  }

  for (const field of ["detectedAthletes", "athletes", "participants"]) {
    if (Array.isArray(next[field])) next[field] = next[field].map(normalizeAthleteDorsal);
  }

  return next;
}

module.exports = {
  normalizeDorsal,
  normalizeDorsalList,
  normalizeDorsalReferences,
};
