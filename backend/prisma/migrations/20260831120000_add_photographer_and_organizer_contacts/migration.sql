-- CreateTable
CREATE TABLE "PhotographerContact" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhotographerContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizerContact" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhotographerContact_phone_key" ON "PhotographerContact"("phone");

-- CreateIndex
CREATE INDEX "PhotographerContact_phone_idx" ON "PhotographerContact"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerContact_phone_key" ON "OrganizerContact"("phone");

-- CreateIndex
CREATE INDEX "OrganizerContact_phone_idx" ON "OrganizerContact"("phone");
