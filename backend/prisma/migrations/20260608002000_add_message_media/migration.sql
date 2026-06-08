CREATE TYPE "MessageContentType" AS ENUM ('TEXT', 'IMAGE');

ALTER TABLE "Message"
ADD COLUMN "contentType" "MessageContentType" NOT NULL DEFAULT 'TEXT',
ADD COLUMN "mediaId" TEXT,
ADD COLUMN "mediaMimeType" TEXT,
ADD COLUMN "mediaSha256" TEXT,
ADD COLUMN "mediaFilename" TEXT,
ADD COLUMN "mediaData" BYTEA,
ADD COLUMN "mediaAnalysis" JSONB;

CREATE INDEX "Message_contentType_idx" ON "Message"("contentType");
CREATE INDEX "Message_mediaId_idx" ON "Message"("mediaId");
