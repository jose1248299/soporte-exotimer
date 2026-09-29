CREATE TABLE "StartListWhatsappSession" (
  "phoneHash" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "encryptedToken" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "pendingConfirmation" JSONB,
  "processingUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StartListWhatsappSession_pkey" PRIMARY KEY ("phoneHash")
);
