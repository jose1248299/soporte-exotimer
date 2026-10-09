CREATE TABLE "SlackCorrectionCursor" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastWatchId" INTEGER NOT NULL DEFAULT 0,
    "nextSendAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SlackCorrectionCursor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SlackCorrectionObservedReply" (
    "messageId" INTEGER NOT NULL,
    CONSTRAINT "SlackCorrectionObservedReply_pkey" PRIMARY KEY ("messageId")
);
ALTER TABLE "SlackCorrectionObservedReply" ADD CONSTRAINT "SlackCorrectionObservedReply_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SlackCorrectionWatch" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "supportCaseId" INTEGER,
    "lastReplyId" INTEGER NOT NULL,
    "lastReplyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SlackCorrectionWatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SlackCorrectionNotification" (
    "id" SERIAL NOT NULL,
    "eventKey" TEXT NOT NULL,
    "watchId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextSendAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SlackCorrectionNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlackCorrectionWatch_key_key" ON "SlackCorrectionWatch"("key");
CREATE UNIQUE INDEX "SlackCorrectionWatch_supportCaseId_key" ON "SlackCorrectionWatch"("supportCaseId");
CREATE INDEX "SlackCorrectionWatch_conversationId_idx" ON "SlackCorrectionWatch"("conversationId");
CREATE UNIQUE INDEX "SlackCorrectionNotification_eventKey_key" ON "SlackCorrectionNotification"("eventKey");
CREATE INDEX "SlackCorrectionNotification_state_nextSendAt_idx" ON "SlackCorrectionNotification"("state", "nextSendAt");
ALTER TABLE "SlackCorrectionNotification" ADD CONSTRAINT "SlackCorrectionNotification_watchId_fkey"
    FOREIGN KEY ("watchId") REFERENCES "SlackCorrectionWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
