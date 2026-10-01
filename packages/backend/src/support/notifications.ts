import { APP_OWNER_USER_ID } from '@b24-app/shared';
import type { Config } from '../config.js';
import { seal, unseal } from '../mobile-session.js';
import { SupportStore } from './store.js';

type Auth = { kind: 'oauth'; domain: string; accessToken: string } | { kind: 'webhook'; url: string };
export class SupportTransportError extends Error {
	constructor(readonly code: string, readonly definite: boolean) { super(code); }
}
export type SupportCall = (auth: Auth, method: string, params: Record<string, unknown>) => Promise<unknown>;
export const supportCall: SupportCall = async (auth, method, params) => {
	const url = auth.kind === 'webhook' ? `${auth.url.replace(/\/$/, '')}/${method}.json` : `https://${auth.domain}/rest/${method}.json`;
	const body = auth.kind === 'oauth' ? { ...params, auth: auth.accessToken } : params;
	try {
		const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
		const json = await res.json() as { result?: unknown; error?: string };
		if (json.error) throw new SupportTransportError(json.error, res.status < 500 && !/INTERNAL|UNEXPECTED/i.test(json.error));
		if (!res.ok || json.result === undefined) throw new SupportTransportError('outcome_unknown', false);
		return json.result;
	} catch (error) {
		if (error instanceof SupportTransportError) throw error;
		throw new SupportTransportError('outcome_unknown', false);
	}
};
export function rememberSupportAuth(store: SupportStore, config: Config, authorId: string, domain: string, accessToken: string): void {
	const secret = config.appClientSecret || config.appSecret;
	if (!secret) throw new Error('Support delivery encryption key is not configured');
	const expiresAt = Date.now() + 50 * 60000;
	store.credential(authorId, seal(`${secret}:support-delivery`, { purpose: 'support-delivery', authorId, domain, accessToken, exp: Math.floor(expiresAt / 1000) }), expiresAt);
}
export async function deliverSupport(store: SupportStore, config: Config, call: SupportCall = supportCall, limit = 10): Promise<void> {
	for (let i = 0; i < limit; i++) {
		const job = store.takeDelivery(); if (!job) return;
		const secret = config.appClientSecret || config.appSecret;
		const credential = secret && job.credential ? unseal(`${secret}:support-delivery`, job.credential, Math.floor(Date.now() / 1000)) : null;
		const webhook = config.autozadachiWebhook || config.catalogWriteWebhook || config.devWebhook;
		let auth: Auth;
		if (job.role === 'manager') {
			if (!credential || credential['purpose'] !== 'support-delivery' || credential['authorId'] !== job.authorId || credential['domain'] !== config.portalDomain || typeof credential['accessToken'] !== 'string') {
				store.finishDelivery(job, 'pending', '', 'auth_required'); continue;
			}
			auth = { kind: 'oauth', domain: config.portalDomain, accessToken: credential['accessToken'] };
		} else {
			if (!webhook || new URL(webhook).pathname.split('/')[2] !== APP_OWNER_USER_ID) {
				store.finishDelivery(job, 'attention', '', 'owner_sender_not_configured'); continue;
			}
			auth = { kind: 'webhook', url: webhook };
		}
		const dialogId = job.role === 'manager' ? APP_OWNER_USER_ID : job.authorId;
		const ticket = store.get(job.ticketId);
		const link = config.appSectionUrl;
		const text = `${job.text}\n\nСтатус: ${ticket.status === 'new' ? 'зарегистрировано' : ticket.status === 'in_progress' ? 'в работе' : ticket.status === 'needs_details' ? 'нужны подробности' : ticket.status === 'needs_owner' ? 'нужно решение Сергея' : 'решено'}\n`
			+ `Ответы и уточнения: кнопка «Сообщить о проблеме» → «Мои обращения» в ERP.${link ? `\n${link}` : ''}`;
		try {
			let messageId: unknown;
			if (job.attachmentId !== null) {
				const attachment = store.attachment(job.attachmentId);
				let legacy = job.uploadFileId !== null;
				if (!legacy) {
					try {
						const result = await call(auth, 'im.v2.File.upload', { dialogId, fields: { name: `${ticket.number}-${job.id}-${attachment.name}`, content: attachment.content.toString('base64'), message: job.text } }) as { messageId?: unknown };
						messageId = result?.messageId;
					} catch (error) {
						// Some portals have not received im.v2 yet. Only an explicit missing-method
						// rejection permits fallback; an unknown upload result must not be repeated.
						if (error instanceof SupportTransportError && error.definite && /^(ERROR_)?METHOD_NOT_FOUND$|^UNKNOWN_METHOD$/i.test(error.code)) legacy = true;
						else throw error;
					}
				}
				if (legacy) {
					let fileId = job.uploadFileId;
					if (!fileId) {
						const history = await call(auth, 'im.dialog.messages.get', { DIALOG_ID: dialogId, LIMIT: 1 }) as { chat_id?: number };
						if (!Number.isSafeInteger(history.chat_id) || Number(history.chat_id) <= 0) throw new SupportTransportError('chat_not_found', true);
						const folder = await call(auth, 'im.disk.folder.get', { CHAT_ID: history.chat_id }) as { ID?: number };
						if (!Number.isSafeInteger(Number(folder.ID)) || Number(folder.ID) <= 0) throw new SupportTransportError('chat_folder_not_found', true);
						const file = await call(auth, 'disk.folder.uploadfile', { id: Number(folder.ID), data: { NAME: `${ticket.number}-${job.id}-${attachment.name}` },
							fileContent: [`${ticket.number}-${job.id}-${attachment.name}`, attachment.content.toString('base64')], generateUniqueName: false }) as { ID?: number };
						fileId = Number(file.ID);
						if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new SupportTransportError('outcome_unknown', false);
						store.rememberUpload(job, fileId);
					}
					const result = await call(auth, 'im.disk.file.commit', { DIALOG_ID: dialogId, FILE_ID: fileId, MESSAGE: job.text }) as { MESSAGE_ID?: unknown };
					messageId = result?.MESSAGE_ID;
				}
			} else messageId = await call(auth, 'im.message.add', { DIALOG_ID: dialogId, MESSAGE: text, URL_PREVIEW: 'N' });
			if (!/^\d+$/.test(String(messageId ?? ''))) throw new SupportTransportError('outcome_unknown', false);
			store.finishDelivery(job, 'sent', String(messageId));
		} catch (error) {
			const code = error instanceof SupportTransportError ? error.code : 'outcome_unknown';
			const retry = error instanceof SupportTransportError && error.definite && /QUERY_LIMIT_EXCEEDED|TOO_MANY_REQUESTS|expired_token|INVALID_TOKEN/i.test(code);
			store.finishDelivery(job, retry ? 'pending' : 'attention', '', code);
		}
	}
}
