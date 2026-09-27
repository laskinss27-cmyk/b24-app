import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { PlannerEnvelope } from './schema.js';
import { migratePlannerChat } from './chat-migration.js';
import { migratePlannerAlbum } from './album-migration.js';
export type PlannerJob = { request_id: string; source_id: string; hash: string; receipt: string; payload: string; stage: string; state: string; lease: string; lead_id: string | null; comment_id: string | null; message_id: string | null; attempts: number };
export class PlannerInbox {
    constructor(private db: DatabaseSync) {
        db.exec(`CREATE TABLE IF NOT EXISTS planner_inbox_v1 (request_id TEXT PRIMARY KEY,source_id TEXT NOT NULL, hash TEXT NOT NULL,receipt TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,
            stage TEXT NOT NULL DEFAULT 'lead',state TEXT NOT NULL DEFAULT 'pending',lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,lead_id TEXT,comment_id TEXT,message_id TEXT,reason TEXT);
            CREATE INDEX IF NOT EXISTS planner_inbox_due ON planner_inbox_v1(state,next_at);`);
        migratePlannerChat(db);
        migratePlannerAlbum(db);
    }
    accept(body: PlannerEnvelope, payload: string, hash: string) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            let row = this.get(body.requestId); const duplicate = Boolean(row);
            if (row && (row.hash !== hash || row.source_id !== body.sourceId)) throw Error('CONFLICT');
            if (!row) {
                if (Number(this.db.prepare('SELECT COALESCE(SUM(length(payload)),0) AS size FROM planner_inbox_v1').get()!.size) > 256 * 1024 * 1024) throw Error('CAPACITY');
                this.db.prepare('INSERT INTO planner_inbox_v1(request_id,source_id,hash,receipt,payload) VALUES(?,?,?,?,?)').run(body.requestId, body.sourceId, hash, 'planner-' + randomUUID(), payload);
                row = this.get(body.requestId)!;
            }
            this.db.exec('COMMIT'); return { duplicate, ack: { accepted: true, requestId: body.requestId, sourceId: body.sourceId, receiptId: row.receipt } };
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    get(id: string) { return this.db.prepare('SELECT * FROM planner_inbox_v1 WHERE request_id=?').get(id) as PlannerJob | undefined; }
    claim(now = Date.now()) {
        return this.db.prepare(`UPDATE planner_inbox_v1 SET state='processing',lease=?,lease_until=?,attempts=attempts+1 WHERE request_id=(SELECT request_id FROM planner_inbox_v1 WHERE (state='pending' AND next_at<=?) OR (state='processing' AND lease_until<?) ORDER BY rowid LIMIT 1) RETURNING *`).get(randomUUID(), now + 120000, now, now) as PlannerJob | undefined;
    }
    checkpoint(job: PlannerJob, stage: string, ids: { lead?: string; comment?: string; message?: string } = {}) {
        if (this.db.prepare('UPDATE planner_inbox_v1 SET stage=?,lead_id=COALESCE(?,lead_id),comment_id=COALESCE(?,comment_id),message_id=COALESCE(?,message_id),lease_until=? WHERE request_id=? AND lease=?').run(stage, ids.lead ?? null, ids.comment ?? null, ids.message ?? null, Date.now() + 120000, job.request_id, job.lease).changes !== 1) throw Error('LEASE_LOST');
        job.stage = stage; if (ids.lead) job.lead_id = ids.lead; if (ids.comment) job.comment_id = ids.comment; if (ids.message) job.message_id = ids.message;
    }
    checkpointImage(job: PlannerJob, view: 'top' | 'iso', messageId: string, fileId: string) {
        const stage = view === 'top' ? 'notify_iso' : 'complete';
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if (this.db.prepare('UPDATE planner_inbox_v1 SET stage=?,message_id=COALESCE(message_id,?),lease_until=? WHERE request_id=? AND lease=?').run(stage, messageId, Date.now() + 120000, job.request_id, job.lease).changes !== 1) throw Error('LEASE_LOST');
            this.db.prepare('INSERT INTO planner_chat_receipts_v1(request_id,view,message_id,file_id) VALUES(?,?,?,?)').run(job.request_id, view, messageId, fileId);
            this.db.exec('COMMIT');
            job.stage = stage; job.message_id ??= messageId;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    uploadedImages(requestId: string) {
        return this.db.prepare('SELECT view,file_id FROM planner_chat_uploads_v1 WHERE request_id=? ORDER BY CASE view WHEN \'top\' THEN 0 ELSE 1 END').all(requestId) as Array<{ view: 'top' | 'iso'; file_id: string }>;
    }
    checkpointUpload(job: PlannerJob, view: 'top' | 'iso', fileId: string) {
        const stage = view === 'top' ? 'album_iso' : 'album_commit';
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if (this.db.prepare('UPDATE planner_inbox_v1 SET stage=?,lease_until=? WHERE request_id=? AND lease=?').run(stage, Date.now() + 120000, job.request_id, job.lease).changes !== 1) throw Error('LEASE_LOST');
            this.db.prepare('INSERT INTO planner_chat_uploads_v1(request_id,view,file_id) VALUES(?,?,?)').run(job.request_id, view, fileId);
            this.db.exec('COMMIT'); job.stage = stage;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    checkpointAlbum(job: PlannerJob, messageId: string) {
        const images = this.uploadedImages(job.request_id);
        if (images.length !== 2) throw Error('INCOMPLETE_ALBUM');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if (this.db.prepare("UPDATE planner_inbox_v1 SET stage='complete',message_id=?,lease_until=? WHERE request_id=? AND lease=?").run(messageId, Date.now() + 120000, job.request_id, job.lease).changes !== 1) throw Error('LEASE_LOST');
            const receipt = this.db.prepare('INSERT INTO planner_chat_receipts_v1(request_id,view,message_id,file_id) VALUES(?,?,?,?)');
            for (const image of images) receipt.run(job.request_id, image.view, messageId, image.file_id);
            this.db.exec('COMMIT'); job.stage = 'complete'; job.message_id = messageId;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    finish(job: PlannerJob, state: 'done' | 'manual' | 'pending', reason: string | null = null) {
        this.db.prepare('UPDATE planner_inbox_v1 SET state=?,reason=?,lease=NULL,lease_until=0,next_at=? WHERE request_id=? AND lease=?').run(state, reason, Date.now() + 60000, job.request_id, job.lease);
    }
}
