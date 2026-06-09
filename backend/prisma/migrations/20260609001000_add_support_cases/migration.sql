CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'WAITING_CLARIFICATION', 'WAITING_HUMAN', 'RESOLVED');

CREATE TABLE "SupportCase" (
  "id" SERIAL NOT NULL,
  "conversationId" INTEGER NOT NULL,
  "competitionId" INTEGER,
  "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
  "userType" "UserType" NOT NULL DEFAULT 'UNKNOWN',
  "athleteName" TEXT,
  "dorsal" TEXT,
  "subject" TEXT,
  "summary" TEXT,
  "classification" JSONB,
  "lastMessageAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SupportCase"
ADD CONSTRAINT "SupportCase_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message"
ADD COLUMN "supportCaseId" INTEGER,
ADD COLUMN "competitionId" INTEGER;

ALTER TABLE "Message"
ADD CONSTRAINT "Message_supportCaseId_fkey"
FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportAction"
ADD COLUMN "supportCaseId" INTEGER;

ALTER TABLE "SupportAction"
ADD CONSTRAINT "SupportAction_supportCaseId_fkey"
FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SupportCase_conversationId_idx" ON "SupportCase"("conversationId");
CREATE INDEX "SupportCase_competitionId_idx" ON "SupportCase"("competitionId");
CREATE INDEX "SupportCase_status_idx" ON "SupportCase"("status");
CREATE INDEX "SupportCase_lastMessageAt_idx" ON "SupportCase"("lastMessageAt");
CREATE INDEX "SupportCase_competitionId_status_lastMessageAt_idx" ON "SupportCase"("competitionId", "status", "lastMessageAt");

CREATE INDEX "Message_supportCaseId_timestamp_idx" ON "Message"("supportCaseId", "timestamp");
CREATE INDEX "Message_competitionId_timestamp_idx" ON "Message"("competitionId", "timestamp");

CREATE INDEX "SupportAction_supportCaseId_idx" ON "SupportAction"("supportCaseId");
