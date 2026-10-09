ALTER TABLE "Message"
  ADD COLUMN "providerMessageId" TEXT,
  ADD COLUMN "deliveryStatus" TEXT,
  ADD COLUMN "deliveryError" JSONB,
  ADD COLUMN "sendAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextSendAt" TIMESTAMP(3),
  ADD COLUMN "sendLeaseUntil" TIMESTAMP(3);
CREATE UNIQUE INDEX "Message_providerMessageId_key" ON "Message"("providerMessageId");
CREATE INDEX "Message_deliveryStatus_nextSendAt_idx" ON "Message"("deliveryStatus", "nextSendAt");

CREATE TABLE "WhatsappDelivery" (
  "providerMessageId" TEXT NOT NULL PRIMARY KEY,
  "sentAt" TIMESTAMP(3), "deliveredAt" TIMESTAMP(3), "readAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3), "errors" JSONB, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ConversationReplyJob" (
  "conversationId" INTEGER NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "leaseUntil" TIMESTAMP(3), "leaseToken" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT, "state" TEXT NOT NULL DEFAULT 'PENDING',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationReplyJob_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ConversationReplyJob_state_dueAt_idx" ON "ConversationReplyJob"("state", "dueAt");
