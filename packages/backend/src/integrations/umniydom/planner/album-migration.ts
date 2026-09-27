import type { DatabaseSync } from 'node:sqlite';

export function migratePlannerAlbum(db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS planner_chat_uploads_v1 (
        request_id TEXT NOT NULL REFERENCES planner_inbox_v1(request_id),
        view TEXT NOT NULL CHECK(view IN ('top','iso')),
        file_id TEXT NOT NULL,
        PRIMARY KEY(request_id,view)
    )`);
}
