-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('TIMER', 'BUYER', 'ORGANIZER', 'ATHLETE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('WHATSAPP');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'WAITING_HUMAN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SupportActionStatus" AS ENUM ('PROPOSED', 'EXECUTED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "TimerContact" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimerContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" SERIAL NOT NULL,
    "channel" "MessageChannel" NOT NULL DEFAULT 'WHATSAPP',
    "phone" TEXT NOT NULL,
    "displayName" TEXT,
    "userType" "UserType" NOT NULL DEFAULT 'UNKNOWN',
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION,
    "classification" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "waId" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "phone" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "rawPayload" JSONB,
    "aiMetadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAction" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "messageId" INTEGER,
    "userType" "UserType" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SupportActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TimerContact_phone_key" ON "TimerContact"("phone");

-- CreateIndex
CREATE INDEX "TimerContact_phone_idx" ON "TimerContact"("phone");

-- CreateIndex
CREATE INDEX "Conversation_phone_idx" ON "Conversation"("phone");

-- CreateIndex
CREATE INDEX "Conversation_userType_idx" ON "Conversation"("userType");

-- CreateIndex
CREATE INDEX "Conversation_status_idx" ON "Conversation"("status");

-- CreateIndex
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_channel_phone_key" ON "Conversation"("channel", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "Message_waId_key" ON "Message"("waId");

-- CreateIndex
CREATE INDEX "Message_conversationId_timestamp_idx" ON "Message"("conversationId", "timestamp");

-- CreateIndex
CREATE INDEX "Message_phone_idx" ON "Message"("phone");

-- CreateIndex
CREATE INDEX "SupportAction_conversationId_idx" ON "SupportAction"("conversationId");

-- CreateIndex
CREATE INDEX "SupportAction_status_idx" ON "SupportAction"("status");

-- CreateIndex
CREATE INDEX "SupportAction_name_idx" ON "SupportAction"("name");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAction" ADD CONSTRAINT "SupportAction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

