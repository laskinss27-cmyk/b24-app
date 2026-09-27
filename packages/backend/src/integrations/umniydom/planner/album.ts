import type { OrdersConfig } from '../config.js';
import type { CrmCall } from '../crm.js';
import type { PlannerEnvelope } from './schema.js';
import type { PlannerInbox, PlannerJob } from './store.js';
import { plannerNotification } from './notification.js';

function id(value: unknown) {
    if (!/^[1-9]\d*$/.test(String(value))) throw Error('INVALID_CRM_ID');
    return String(value);
}

/** Uploads privately first; only commit creates a chat message, with both images. */
export async function deliverPlannerAlbum(inbox: PlannerInbox, job: PlannerJob, body: PlannerEnvelope,
    config: OrdersConfig, call: CrmCall, markRetry: (stage: string) => void) {
    if (job.stage === 'notify') inbox.checkpoint(job, 'album_top');
    for (const view of ['top', 'iso'] as const) {
        const stage = 'album_' + view;
        if (job.stage !== stage) continue;
        markRetry(stage);
        const folder = await call('im.disk.folder.get', { DIALOG_ID: config.chatId }) as { ID?: unknown } | null;
        const folderId = id(folder?.ID);
        const name = `${body.number}-${view === 'top' ? 'top' : 'isometry'}.png`;
        inbox.checkpoint(job, stage + '_sending');
        const file = await call('disk.folder.uploadfile', { id: folderId, data: { NAME: name },
            fileContent: [name, body.images[view]], generateUniqueName: true }) as { ID?: unknown } | null;
        inbox.checkpointUpload(job, view, id(file?.ID));
    }
    if (job.stage !== 'album_commit') return;
    markRetry('album_commit');
    const files = inbox.uploadedImages(job.request_id);
    if (files.length !== 2 || new Set(files.map(file => file.file_id)).size !== 2) throw Error('INCOMPLETE_ALBUM');
    inbox.checkpoint(job, 'album_commit_sending');
    const result = await call('im.disk.file.commit', { DIALOG_ID: config.chatId,
        UPLOAD_ID: files.map(file => id(file.file_id)), AS_FILE: 'N',
        MESSAGE: plannerNotification(body, `https://${config.portalDomain}/crm/lead/details/${job.lead_id}/`),
    }) as { MESSAGE_ID?: unknown; DISK_ID?: unknown } | null;
    // A successful write response must acknowledge both files before marking the job complete.
    const confirmed = Array.isArray(result?.DISK_ID) ? result.DISK_ID.map(String) : [];
    if (files.some(file => !confirmed.includes(file.file_id))) throw Error('INCOMPLETE_ALBUM_RECEIPT');
    inbox.checkpointAlbum(job, id(result?.MESSAGE_ID));
}
