ALTER TABLE "Conversation"
ADD COLUMN "whatsappUserId" TEXT;

ALTER TABLE "Message"
ADD COLUMN "whatsappUserId" TEXT;

UPDATE "Message"
SET "whatsappUserId" = COALESCE(
  NULLIF("rawPayload" #>> '{entry,0,changes,0,value,messages,0,from_user_id}', ''),
  NULLIF("rawPayload" #>> '{entry,0,changes,0,value,contacts,0,user_id}', '')
)
WHERE "direction" = 'INBOUND';

WITH conversation_users AS (
  SELECT "conversationId", "whatsappUserId"
  FROM "Message"
  WHERE "whatsappUserId" IS NOT NULL
  GROUP BY "conversationId", "whatsappUserId"
),
single_user_conversations AS (
  SELECT
    "conversationId",
    MIN("whatsappUserId") AS "whatsappUserId"
  FROM conversation_users
  GROUP BY "conversationId"
  HAVING COUNT(*) = 1
),
ranked_conversations AS (
  SELECT
    single_user_conversations."conversationId",
    single_user_conversations."whatsappUserId",
    ROW_NUMBER() OVER (
      PARTITION BY single_user_conversations."whatsappUserId"
      ORDER BY
        CASE WHEN conversation."phone" ~ '^[0-9]+$' THEN 0 ELSE 1 END,
        conversation."lastMessageAt" DESC NULLS LAST,
        conversation."id" DESC
    ) AS priority
  FROM single_user_conversations
  JOIN "Conversation" AS conversation
    ON conversation."id" = single_user_conversations."conversationId"
  WHERE conversation."channel" = 'WHATSAPP'
)
UPDATE "Conversation" AS conversation
SET "whatsappUserId" = ranked_conversations."whatsappUserId"
FROM ranked_conversations
WHERE conversation."id" = ranked_conversations."conversationId"
  AND ranked_conversations.priority = 1;

CREATE UNIQUE INDEX "Conversation_channel_whatsappUserId_key"
ON "Conversation"("channel", "whatsappUserId");

CREATE INDEX "Message_whatsappUserId_idx"
ON "Message"("whatsappUserId");
