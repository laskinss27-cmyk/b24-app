# One planner notification with two images

Prepared replacement for the two-message delivery. Activation requires the existing
incoming webhook to have `disk` scope, in addition to its existing `crm` and `im` scopes.
The production webhook currently rejects `disk.folder.uploadfile` with `insufficient_scope`.
Do not deploy until this requirement is met. No live test message is authorized.

Flow: get the configured chat folder with `im.disk.folder.get`; upload the two PNGs
with `disk.folder.uploadfile`; send one `im.disk.file.commit` with both `UPLOAD_ID`s,
`AS_FILE=N`, and the complete notification text. Images remain separate and openable.
No public files, external screenshot URLs or temporary chat messages are involved.
The lead timeline keeps its two PNGs and project JSON unchanged.

References:
- https://apidocs.bitrix24.ru/api-reference/chats/files/im-disk-folder-get.html
- https://apidocs.bitrix24.ru/api-reference/disk/folder/disk-folder-upload-file.html
- https://apidocs.bitrix24.ru/api-reference/chats/files/im-disk-file-commit.html

`planner_chat_uploads_v1` is additive. Each confirmed upload ID and its next stage
are committed atomically. Only the final commit sends a message; both receipt rows
then record the same message ID. A known rate limit retries the current operation
without reuploading confirmed files. Expired sending leases, partial receipts or
uncertain outcomes require manual verification, never a fallback duplicate send.
Uploaded files may remain pending manual review after an uncertain outcome; do not
delete them automatically because the commit may have succeeded.

Existing completed jobs are not resent. A previous-version `notify_iso` job finishes
only its remaining isometry through the old native upload method. All previous
uncertain `_sending` stages remain fenced. Unknown stages cannot be marked done.

Rollback: stop the worker before reverting; put unfinished `album_top`, `album_iso`,
`album_commit` and corresponding `_sending` jobs into manual review because the prior
worker does not understand them. Keep uploaded-file IDs and receipts; do not reset
them to `notify` blindly. Take an online database backup before maintenance.
