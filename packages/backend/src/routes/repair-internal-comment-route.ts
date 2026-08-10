import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import type { RepairData } from './repair-record.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type RepairClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerRepairInternalCommentRoute(app: FastifyInstance, clientFrom: RepairClientFrom): void {
	// Быстрая смена вида ремонта платный↔гарантийный (без захода в полное редактирование).
	// При переходе на платный можно сразу прислать стоимость; на гарантийный — стоимость обнуляется.
	// У предпродажного ремонта нет клиентской формы, но рабочий комментарий должен оставаться редактируемым.
	app.post('/api/repairs/update-internal-comment', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; internalComment?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			if (data.kind !== 'presale') return reply.code(400).send({ ok: false, error: 'для клиентского ремонта используй обычное редактирование' });
			data.internalComment = String(b.internalComment ?? '').trim().slice(0, 2000);
			const name = String(raw['NAME'] ?? '').trim() || `[предпродажа] ${data.device || `#${data.productId ?? id}`}`;
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id }, '[api/repairs/update-internal-comment] ok');
			return { ok: true, repair: { id, name, ...data } };
		} catch (err) {
			app.log.error({ id }, `[api/repairs/update-internal-comment] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
