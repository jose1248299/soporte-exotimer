const { PrismaClient } = require("@prisma/client");

const prisma = global.__soporteExotimerPrisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__soporteExotimerPrisma = prisma;
}

module.exports = prisma;
