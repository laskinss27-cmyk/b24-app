import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { assertDealQuoteVariantSelected, listDealStages, renameDealStage } from '../erp/operations.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealStageRoutes(app: FastifyInstance, clientFrom: DealClientFrom): void {
	app.post('/api/deal/stages', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			return { ok: true, stages: await listDealStages(erp, dealId) };
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/stages] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/deal/stage-rename', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; stageId?: unknown; name?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		const stageId = String(b.stageId ?? '').trim();
		if (!Number.isInteger(dealId) || dealId <= 0 || !stageId) return reply.code(400).send({ ok: false, error: 'некорректный этап' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			await assertDealQuoteVariantSelected(erp, dealId);
			return { ok: true, stages: await renameDealStage(erp, dealId, stageId, String(b.name ?? '')) };
		} catch (err) {
			app.log.error({ dealId, stageId }, `[api/deal/stage-rename] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
