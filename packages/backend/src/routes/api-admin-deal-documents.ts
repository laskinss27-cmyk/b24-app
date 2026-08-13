import type { FastifyInstance } from 'fastify';
import type { AccessAuthBody } from '../access-policy.js';
import { diagnoseAdminDealDocuments, searchAdminDealDocuments } from '../admin/deal-document-diagnostics.js';
import {
	DealDocumentLinkRestoreError,
	normalizeRestoreComment,
	RESTORABLE_DOCUMENT_TYPES,
	restoreUnlinkedDealDocument,
} from '../admin/deal-document-link-restorer.js';
import { adminOwnerClient, adminOwnerContext } from '../admin/owner-client.js';
import { ErpClient } from '../erp/client.js';

interface SearchBody extends AccessAuthBody { query?: unknown; limit?: unknown }
interface DiagnoseBody extends AccessAuthBody { dealId?: unknown }
interface RestoreLinkBody extends AccessAuthBody { dealId?: unknown; targetType?: unknown; targetName?: unknown; comment?: unknown }

const ACCESS_ERROR = 'Админка доступна только владельцу приложения.';
const ERP_ERROR = 'Ядро склада не настроено.';

async function recordLinkRestore(
	app: FastifyInstance,
	input: { dealId: number; targetType: string; targetName: string; comment: string; actor?: { id: string; name: string }; error?: string; changed?: boolean },
): Promise<void> {
	const failed = Boolean(input.error);
	await app.operationLog.record({
		area: 'admin',
		operation: 'restore_deal_document_link',
		outcome: failed ? 'failure' : 'success',
		level: failed ? 'error' : 'warning',
		summary: failed
			? `Не удалось восстановить связь ${input.targetType} ${input.targetName} со сделкой №${input.dealId}: ${input.error}`
			: `${input.changed ? 'Восстановлена' : 'Подтверждена'} связь ${input.targetType} ${input.targetName} со сделкой №${input.dealId}. Причина: ${input.comment}`,
		...(input.actor ? { actor: input.actor } : {}),
		dealId: input.dealId,
		documents: [`${input.targetType} ${input.targetName}`],
		details: {
			documentType: input.targetType.slice(0, 80),
			documentName: input.targetName.slice(0, 160),
			comment: input.comment.slice(0, 500),
			...(input.error ? { error: input.error.slice(0, 500) } : {}),
		},
	});
}

export function registerApiAdminDealDocumentsRoute(app: FastifyInstance): void {
	app.post('/api/admin/deal-documents/search', async (req, reply) => {
		const body = (req.body ?? {}) as SearchBody;
		try {
			const client = await adminOwnerClient(app, body);
			if (!client) return reply.code(403).send({ ok: false, error: ACCESS_ERROR });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: ERP_ERROR });
			const query = typeof body.query === 'string' ? body.query.slice(0, 120) : '';
			const requestedLimit = Number(body.limit);
			const limit = Number.isFinite(requestedLimit) ? requestedLimit : 30;
			return { ok: true, deals: await searchAdminDealDocuments(erp, query, limit) };
		} catch (error) {
			app.log.error({ error: String(error) }, '[admin/deal-documents/search] failed');
			return reply.code(500).send({ ok: false, error: 'Не удалось прочитать документы сделок.' });
		}
	});

	app.post('/api/admin/deal-documents/diagnose', async (req, reply) => {
		const body = (req.body ?? {}) as DiagnoseBody;
		const dealId = Number(body.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'Некорректный ID сделки.' });
		try {
			const client = await adminOwnerClient(app, body);
			if (!client) return reply.code(403).send({ ok: false, error: ACCESS_ERROR });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: ERP_ERROR });
			return { ok: true, diagnostic: await diagnoseAdminDealDocuments(client, erp, dealId) };
		} catch (error) {
			app.log.error({ dealId, error: String(error) }, '[admin/deal-documents/diagnose] failed');
			return reply.code(500).send({ ok: false, error: 'Не удалось выполнить диагностику документов сделки.' });
		}
	});

	app.post('/api/admin/deal-documents/restore-link', async (req, reply) => {
		const body = (req.body ?? {}) as RestoreLinkBody;
		const dealId = Number(body.dealId);
		const targetType = String(body.targetType ?? '') as Parameters<typeof RESTORABLE_DOCUMENT_TYPES.has>[0];
		const targetName = String(body.targetName ?? '').trim().slice(0, 160);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'Некорректный ID сделки.' });
		if (!RESTORABLE_DOCUMENT_TYPES.has(targetType)) return reply.code(400).send({ ok: false, error: 'Некорректный тип документа.' });
		if (!targetName) return reply.code(400).send({ ok: false, error: 'Не указан документ.' });
		let comment: string;
		try {
			comment = normalizeRestoreComment(body.comment);
		} catch (error) {
			return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		let actor: { id: string; name: string } | undefined;
		try {
			const owner = await adminOwnerContext(app, body);
			if (!owner) return reply.code(403).send({ ok: false, error: ACCESS_ERROR });
			actor = owner.actor;
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: ERP_ERROR });
			const diagnostic = await diagnoseAdminDealDocuments(owner.client, erp, dealId);
			const result = await restoreUnlinkedDealDocument(erp, { dealId, targetType, targetName, comment }, diagnostic.structure.links);
			await recordLinkRestore(app, { dealId, targetType, targetName, comment, ...(actor ? { actor } : {}), changed: result.changed });
			return { ok: true, result };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await recordLinkRestore(app, { dealId, targetType, targetName, comment, ...(actor ? { actor } : {}), error: message });
			app.log.error({ dealId, targetType, targetName, error: message }, '[admin/deal-documents/restore-link] failed');
			if (error instanceof DealDocumentLinkRestoreError) return reply.code(409).send({ ok: false, error: message });
			return reply.code(500).send({ ok: false, error: 'Не удалось восстановить связь документа. Подробности записаны в журнал операций.' });
		}
	});
}
