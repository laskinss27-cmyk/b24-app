# Planner chat images

New planner requests send two native private chat files through `im.v2.File.upload`:
the top view carries the project/contact/kit brief; the next message carries isometry.
Both views and the complete project JSON remain attached to the lead timeline.
The message lists the selected cable quantity, boxes, archive period and declined items.
Unknown prices are excluded from the displayed known-price subtotal; it is not a full quote.
Customer text is escaped as BBCode and shortened only in the chat, never in the CRM comment.

The existing webhook `im` scope suffices; Disk scope and public screenshot hosting are not used.
Reference: https://apidocs.bitrix24.ru/api-reference/chat-bots/chat-bots-v2/im.v2/files/file-upload.html
Capability was checked on the portal with the existing dialog ID and empty `fields`:
`FILE_EMPTY` (`File name and content are required`). No message or file was sent by the check.

Delivery stages: `notify` → `notify_sending` → `notify_iso` → `notify_iso_sending` → `complete`.
The additive `planner_chat_receipts_v1` table records each message/file ID atomically with
advancing the inbox stage. The original `message_id` retains the first message ID.
Confirmed top views are not repeated when isometry is rate-limited or the worker restarts.
An expired sending lease, timeout or malformed write response is fenced for manual review.
There is no automatic fallback that could duplicate an upload with an uncertain outcome.
Existing completed jobs are unchanged and not resent. Legacy `notify_sending` remains fenced.

Before rolling back to a worker that lacks `notify_iso`, stop the worker and fence any pending
`notify_iso` / `notify_iso_sending` jobs for manual review using a lease-aware maintenance step;
do not let that older worker mark an unrecognized stage complete. Keep the additive receipt table.
Back up the inbox database before any maintenance. Do not blindly reset uncertain sending stages.

Tests cover the complete submit/delivery/CRM flow with a mock transport, both views, receipts,
rate limits, restarts, lost leases, legacy migration, malformed responses, BBCode and kit details.
No live test notification is authorized for this release. Actual visual rendering in Bitrix24
must be checked on a subsequently authorized request.
