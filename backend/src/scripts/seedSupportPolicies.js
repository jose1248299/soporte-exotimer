const prisma = require("../lib/prisma");
const { getPolicies, upsertPolicies } = require("../services/supportPolicies");

async function main() {
  const policies = await getPolicies();
  const saved = await upsertPolicies(
    policies.map(({ userType, actionName, enabled, requiresHuman, notes }) => ({
      userType,
      actionName,
      enabled,
      requiresHuman,
      notes,
    }))
  );

  console.log(`Politicas de soporte listas: ${saved.length}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
