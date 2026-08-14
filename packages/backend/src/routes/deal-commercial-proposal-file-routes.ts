import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { buildDealKpDocx, normalizeDealKpDocument } from '../deal-kp-docx.js';
import { loadDealKpImages } from '../deal-kp-photos.js';
import { buildDealKpXlsx } from '../deal-kp-xlsx.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealCommercialProposalFileRoutes(app: FastifyInstance, clientFrom: DealClientFrom): void {
	// Word-версия КП собирается из уже подготовленных данных /api/deal/kp.
	// Документ ничего не записывает в сделку: клиент получает обычный .docx для редактирования.
	app.post('/api/deal/kp-docx', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; kp?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			const kp = normalizeDealKpDocument(b.kp);
			const images = await loadDealKpImages(kp, b);
			const file = await buildDealKpDocx(kp, images);
			app.log.info({ dealId, images: images.size }, '[api/deal/kp-docx] ok');
			return reply
				.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
				.header('Content-Disposition', `attachment; filename="kp-${dealId}.docx"`)
				.header('Cache-Control', 'no-store')
				.send(file);
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/kp-docx] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Клиентская Excel-версия КП собирается из тех же данных, что Word и PDF.
	// Складские поля, реализации и внутренние остатки в этот документ не попадают.
	app.post('/api/deal/kp-xlsx', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; kp?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			const kp = normalizeDealKpDocument(b.kp);
			const images = await loadDealKpImages(kp, b);
			const file = await buildDealKpXlsx(kp, images);
			app.log.info({ dealId, images: images.size }, '[api/deal/kp-xlsx] ok');
			return reply
				.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
				.header('Content-Disposition', `attachment; filename="kp-${dealId}.xlsx"`)
				.header('Cache-Control', 'no-store')
				.send(file);
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/kp-xlsx] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
