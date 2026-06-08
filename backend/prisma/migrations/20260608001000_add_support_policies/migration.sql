-- CreateTable
CREATE TABLE "SupportPolicy" (
    "id" SERIAL NOT NULL,
    "userType" "UserType" NOT NULL,
    "actionName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "requiresHuman" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportPolicy_userType_actionName_key" ON "SupportPolicy"("userType", "actionName");

-- CreateIndex
CREATE INDEX "SupportPolicy_userType_idx" ON "SupportPolicy"("userType");

-- CreateIndex
CREATE INDEX "SupportPolicy_actionName_idx" ON "SupportPolicy"("actionName");
