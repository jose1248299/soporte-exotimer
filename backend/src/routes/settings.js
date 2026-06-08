const express = require("express");
const { ACTIONS } = require("../services/exotimerClient");
const { USER_TYPES, getPolicies, upsertPolicies, isDatabaseConfigured } = require("../services/supportPolicies");

const router = express.Router();

router.get("/policies", async (_req, res) => {
  const policies = await getPolicies();
  res.json({
    userTypes: USER_TYPES,
    actions: ACTIONS,
    policies,
    canSave: isDatabaseConfigured(),
  });
});

router.put("/policies", async (req, res) => {
  const policies = Array.isArray(req.body?.policies) ? req.body.policies : [];
  if (!policies.length) return res.status(400).json({ error: "Lista de politicas requerida" });

  try {
    const saved = await upsertPolicies(policies);
    res.json({ policies: saved });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
