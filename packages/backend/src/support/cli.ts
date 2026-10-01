/** Trusted local/server CLI. Not an HTTP endpoint; never accepts portal credentials in arguments. */
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { APP_OWNER_USER_ID, SUPPORT_STATUSES } from '@b24-app/shared';
import { loadConfig } from '../config.js';
import { SupportStore } from './store.js';
import { deliverSupport } from './notifications.js';
import { requestIdSchema } from './validation.js';

const store = new SupportStore(join(process.env['B24_STATE_DIR'] ?? '/app/state', 'support', 'support.sqlite'));
try {
	const [command, raw] = process.argv.slice(2);
	let payload = raw ?? '';
	if (raw === '--stdin') { payload = ''; for await (const chunk of process.stdin) payload += String(chunk); }
	const input = payload ? JSON.parse(payload) : {};
	const id = (): number => z.number().int().positive().parse(input.ticketId);
	let result: unknown;
	if (command === 'inbox') result = { tickets: store.inbox(), deliveryAttention: store.deliveryAttention() };
	else if (command === 'get') result = store.get(id());
	else if (command === 'claim') result = store.claim(id(), z.number().int().positive().parse(input.inputRevision), z.boolean().optional().parse(input.announce) ?? true);
	else if (command === 'renew') { store.renew(id(), z.string().uuid().parse(input.leaseToken)); result = { ok: true }; }
	else if (command === 'reply') {
		const parsed = z.object({ ticketId: z.number().int().positive(), requestId: requestIdSchema, inputRevision: z.number().int().positive(),
			leaseToken: z.string().uuid(), text: z.string().trim().min(3).max(5000), status: z.enum(SUPPORT_STATUSES).exclude(['new']) }).parse(input);
		result = store.reply(parsed, { id: APP_OWNER_USER_ID, name: 'Помощник Сергея' }, true);
	} else if (command === 'attachment') {
		const parsed = z.object({ attachmentId: z.number().int().positive(), path: z.string().min(1).optional() }).parse(input);
		const attachment = store.attachment(parsed.attachmentId);
		if (parsed.path) await writeFile(parsed.path, attachment.content, { mode: 0o600 });
		result = { ok: true, name: attachment.name, mime: attachment.mime, bytes: attachment.content.length, ...(parsed.path ? {} : { base64: attachment.content.toString('base64') }) };
	} else if (command === 'confirm-delivery') {
		const parsed = z.object({ deliveryId: z.number().int().positive(), bitrixMessageId: z.string().regex(/^\d+$/) }).parse(input);
		store.confirmDelivery(parsed.deliveryId, parsed.bitrixMessageId); result = { ok: true };
	} else if (command === 'deliver') result = { ok: true };
	else throw new Error('Usage: inbox | get | claim | renew | reply | attachment | confirm-delivery | deliver; JSON input as second argument');
	if (['claim', 'reply', 'deliver', 'confirm-delivery'].includes(command ?? '')) await deliverSupport(store, loadConfig());
	process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); }
