function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

module.exports = { normalizePhone };
