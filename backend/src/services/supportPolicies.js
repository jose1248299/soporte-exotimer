const prisma = require("../lib/prisma");
const { ACTIONS, requiresConfirmation, canExecuteAction } = require("./exotimerClient");

const USER_TYPES = ["SYSTEM_USER", "TIMER", "BUYER", "ORGANIZER", "ATHLETE", "UNKNOWN"];
const MISSING_DATABASE_ERROR =
  "DATABASE_URL no esta configurado. Conecta PostgreSQL para guardar cambios de permisos.";

function isDatabaseConfigured() {
  return Boolean((process.env.DATABASE_URL || "").trim());
}

function allowDefaultPoliciesWithoutDatabase() {
  return process.env.NODE_ENV !== "production";
}

function buildDefaultPolicy(userType, actionName) {
  const isSystemUser = userType === "SYSTEM_USER";
  return {
    userType,
    actionName,
    enabled: isSystemUser ? true : canExecuteAction(userType, actionName),
    requiresHuman: isSystemUser ? false : requiresConfirmation(actionName),
    source: "default",
    action: ACTIONS[actionName],
  };
}

function buildDefaultPolicies() {
  return USER_TYPES.flatMap((userType) =>
    Object.keys(ACTIONS).map((actionName) => buildDefaultPolicy(userType, actionName))
  );
}

async function getPolicies() {
  if (!isDatabaseConfigured()) {
    if (allowDefaultPoliciesWithoutDatabase()) return buildDefaultPolicies();
    throw new Error(MISSING_DATABASE_ERROR);
  }

  const saved = await prisma.supportPolicy.findMany();
  const savedByKey = new Map(saved.map((item) => [`${item.userType}:${item.actionName}`, item]));

  return buildDefaultPolicies().map((defaultPolicy) => {
    const savedPolicy = savedByKey.get(`${defaultPolicy.userType}:${defaultPolicy.actionName}`);
    if (!savedPolicy) return defaultPolicy;

    return {
      id: savedPolicy.id,
      userType: defaultPolicy.userType,
      actionName: defaultPolicy.actionName,
      enabled: savedPolicy.enabled,
      requiresHuman: savedPolicy.requiresHuman,
      notes: savedPolicy.notes,
      source: "database",
      action: defaultPolicy.action,
    };
  });
}

function validatePolicy(policy) {
  if (!USER_TYPES.includes(policy.userType)) {
    throw new Error(`Tipo de usuario no soportado: ${policy.userType}`);
  }
  if (!ACTIONS[policy.actionName]) {
    throw new Error(`Accion no soportada: ${policy.actionName}`);
  }
}

async function findSavedPolicy(userType, actionName) {
  if (!isDatabaseConfigured()) {
    if (allowDefaultPoliciesWithoutDatabase()) return null;
    throw new Error(MISSING_DATABASE_ERROR);
  }

  return prisma.supportPolicy.findUnique({
    where: { userType_actionName: { userType, actionName } },
  });
}

function mapSavedPolicy(userType, actionName, savedPolicy) {
  if (!savedPolicy) return buildDefaultPolicy(userType, actionName);

  return {
    id: savedPolicy.id,
    userType,
    actionName,
    enabled: savedPolicy.enabled,
    requiresHuman: savedPolicy.requiresHuman,
    notes: savedPolicy.notes,
    source: "database",
    action: ACTIONS[actionName],
  };
}

async function getPolicy(userType, actionName) {
  const saved = await findSavedPolicy(userType, actionName);
  return mapSavedPolicy(userType, actionName, saved);
}

async function upsertPolicies(policies) {
  for (const policy of policies) {
    validatePolicy(policy);
  }

  if (!isDatabaseConfigured()) {
    throw new Error(MISSING_DATABASE_ERROR);
  }

  const updates = policies.map((policy) =>
    prisma.supportPolicy.upsert({
      where: {
        userType_actionName: {
          userType: policy.userType,
          actionName: policy.actionName,
        },
      },
      create: {
        userType: policy.userType,
        actionName: policy.actionName,
        enabled: Boolean(policy.enabled),
        requiresHuman: Boolean(policy.requiresHuman),
        notes: policy.notes || null,
      },
      update: {
        enabled: Boolean(policy.enabled),
        requiresHuman: Boolean(policy.requiresHuman),
        notes: policy.notes || null,
      },
    })
  );

  await prisma.$transaction(updates);
  return getPolicies();
}

module.exports = {
  USER_TYPES,
  getPolicies,
  getPolicy,
  upsertPolicies,
  isDatabaseConfigured,
};
