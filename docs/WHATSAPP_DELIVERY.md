# WhatsApp outbound delivery and recovery

## Delivery states

- `QUEUED`: saved response awaiting a send attempt.
- `SENDING`: one worker has claimed the message.
- `ACCEPTED`: Meta returned a provider message ID; delivery is not confirmed.
- `SENT`, `DELIVERED`, `READ`: confirmed by signed Meta status callbacks.
- `FAILED`: explicit API rejection or failed callback; see the stored error code.
- `UNKNOWN`: a timeout, server error, or expired send lease left acceptance uncertain. No automatic resend.
- `EXPIRED`: the last inbound WhatsApp message is outside the 24-hour free-text window.

The webhook processes every entry/change/status/message and persists status callbacks before acknowledgement. Failed database writes return HTTP 500 so Meta can retry. Callbacks arriving before message persistence are retained in `WhatsappDelivery`; repeated and out-of-order callbacks do not downgrade delivered/read messages. Historical messages with only a provider ID are labelled accepted, not delivered. Previously discarded callbacks cannot be reconstructed.

Graph `/messages` uses `to` for telephone numbers and `recipient` for business-scoped user IDs. The distinction applies to text, image and document sends.

## Durable recovery

`ConversationReplyJob` retains the debounce deadline across restarts. A revision and renewable database lease prevent two workers processing the same job simultaneously and preserve messages received while a response is being generated. Generation failures retry with bounded backoff, up to five attempts. Terminal jobs remain available for diagnosis.

Normal support replies and manual replies are stored before transport. The support reply and its inbound processed markers commit in one transaction. Retrying transport sends the saved content rather than regenerating the reply or repeating a Race Line mutation. A worker recovers queued sends and missing reply jobs every minute. Recovery only considers recent inbound messages; it does not bulk-replay historical cases.

Explicit throttling (HTTP 429) is retried at most five times. Other explicit client rejections remain failed and can be retried by an authenticated panel operator with the retry icon. Uncertain sends are never automatically retried, because Meta does not offer an exactly-once send contract here. After acceptance but before saving its ID, a process/database failure can therefore require manual investigation.

Start List imports retain their dedicated authorization/session/reply flow and are excluded from generic reply recovery. Secret confirmation commands are not copied into the normal outbox. Their recorded provider IDs can still receive delivery states. Documents sent inside registration actions also produce status ledger entries, but are not automatically resent or converted into a text reply.

## Deploy and verification

1. `npm run prisma:generate`
2. `npm run prisma:deploy` (additive migration `20261009120000_whatsapp_delivery_and_reply_jobs`).
3. Deploy backend and frontend. The worker starts with the backend when `DATABASE_URL` is configured.
4. Keep `META_APP_SECRET` configured and subscribe the existing Meta app to the `messages` webhook field, which also supplies delivery statuses.
5. Send a new inbound test message and verify its response progresses beyond accepted to delivered/read. Inspect failed callback codes if it does not.

No new environment variables are required. Existing `SUPPORT_REPLY_DEBOUNCE_MS` remains in use. Health checks alone cannot prove delivery to a handset.

Tests cover recipient payloads, status-only/batched webhooks, database errors, out-of-order callbacks, queue claims, restart recovery, new messages during processing, throttling, uncertain sends and the 24-hour cutoff. PostgreSQL verification can use rollback-only synthetic fixtures with a mocked Meta sender, without contacting a customer.

References: [Meta usernames overview](https://developers.meta.com/resources/videos/whatsapp-usernames/), [Cloud API SDK BSUID request contract](https://github.com/gokapso/whatsapp-cloud-api-js#business-scoped-user-ids-bsuids).
