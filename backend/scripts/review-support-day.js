const fs = require("node:fs");
const path = require("node:path");
const prisma = require("../src/lib/prisma");
const { processConversationReply } = require("../src/services/supportProcessor");

async function main() {
  const args = process.argv.slice(2);
  const date = args.find(arg => /^\d{4}-\d{2}-\d{2}$/.test(arg));
  if (!date) throw new Error("Indica fecha YYYY-MM-DD (America/Lima), opcional --apply y --ids=184,185. No envia WhatsApp.");
  const start = new Date(`${date}T00:00:00-05:00`);
  const end = new Date(start.getTime() + 86400000);
  const ids = args.find(arg => arg.startsWith("--ids="))?.slice(6).split(",").map(Number);
  const apply = args.includes("--apply");
  const conversations = await prisma.conversation.findMany({ where: {
    channel: "WHATSAPP", ...(ids ? { id: { in: ids } } : {}),
    messages: { some: { direction: "INBOUND", timestamp: { gte: start, lt: end } } },
  }, orderBy: { id: "asc" }, select: { id: true, phone: true, displayName: true } });
  const report = { date, mode: apply ? "apply_without_sending" : "preview", startedAt: new Date().toISOString(), cases: [] };
  const output = path.resolve("outputs", `support-review-${date}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  for (const conversation of conversations) {
    try {
      const review = await processConversationReply(conversation.id, { replay: true, preview: !apply, sendReply: false });
      report.cases.push({ ...conversation, ...review });
      console.log(JSON.stringify({ id: conversation.id, action: review?.classification?.action,
        summary: review?.classification?.summary, input: review?.classification?.actionInput,
        needsHuman: review?.classification?.needsHuman, remaining: review?.classification?.remainingRequests,
        verification: review?.actionResult?.verification, error: review?.actionError, reply: review?.reply,
        resultContext: review?.resultContext?.result }));
    } catch (error) {
      report.cases.push({ ...conversation, error: error.message });
      console.log(JSON.stringify({ id: conversation.id, error: error.message }));
    }
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
  console.log(`Report: ${output}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
