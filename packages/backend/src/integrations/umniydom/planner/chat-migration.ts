import type { DatabaseSync } from 'node:sqlite';

/** Additive receipt storage; existing inbox records and completed notifications stay unchanged. */
export function migratePlannerChat(db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS planner_chat_receipts_v1 (
        request_id TEXT NOT NULL REFERENCES planner_inbox_v1(request_id),
        view TEXT NOT NULL CHECK(view IN ('top','iso')),
        message_id TEXT NOT NULL, file_id TEXT NOT NULL,
        PRIMARY KEY(request_id,view)
    )`);
}
