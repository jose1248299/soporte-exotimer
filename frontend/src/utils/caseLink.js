export function parseCaseLink(search) {
  const params = new URLSearchParams(search);
  const positiveId = value => /^\d+$/.test(value || "") && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const conversationId = positiveId(params.get("conversation"));
  return conversationId ? { conversationId, caseId: positiveId(params.get("case")) } : null;
}

export function filterLinkedCase(items, caseId) {
  const rows = Array.isArray(items) ? items : [];
  return caseId ? rows.filter(row => row.supportCaseId === caseId) : rows;
}
