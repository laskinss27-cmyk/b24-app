import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { listSupplyRequests, createSupplyRequest } from '../erp/operations.js';

/**
 * API рабочего места «Снаб». Источник спроса — ЗАЯВКИ (Material Request) ядра по сделкам:
 * менеджер из сделки осознанно отправляет нехватку в снабжение (кнопка «Снабжение»).
 *  - /api/supply/orders  — все заявки из ядра (позиции + комментарии + остатки) + название сделки из Б24.
 *  - /api/supply/request — создать заявку по выбранным товарам сделки.
 * Канарейку режет фронт. Токен юзера, домен — allowlist портала.
 */
// «Обеспечено» — снабженец отработал заявку (статусы Material Request).
const MR_DONE = new Set(['Ordered', 'Transferred', 'Issued', 'Received', 'Stopped']);
interface AuthBody { domain?: string; accessToken?: string }

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerApiSupplyRoute(app: FastifyInstance): void {
	const clientFrom = (b: AuthBody): B24Client | null => {
		if (!b.domain || !b.accessToken) return null;
		if (normalizeDomain(b.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: b.domain, accessToken: b.accessToken } });
	};

	app.post('/api/supply/orders', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return { ok: true, orders: [] as unknown[] };
		try {
			const reqs = await listSupplyRequests(erp);
			// Название сделки — из Б24 (одним батч-вызовом по списку dealId). Статус «обеспечено» — из самой заявки.
			const dealIds = [...new Set(reqs.map((o) => Number(o.dealId)).filter((n) => Number.isInteger(n) && n > 0))];
			const titleMap = new Map<number, string>();
			if (dealIds.length) {
				const deals = await client.call<Array<Record<string, unknown>>>('crm.deal.list', {
					filter: { '@ID': dealIds }, select: ['ID', 'TITLE'],
				}).catch(() => [] as Array<Record<string, unknown>>);
				for (const d of deals ?? []) titleMap.set(Number(d['ID']), String(d['TITLE'] ?? ''));
			}
			const enriched = reqs.map((o) => ({ ...o, dealTitle: titleMap.get(Number(o.dealId)) ?? '', closed: MR_DONE.has(o.status) }));
			app.log.info({ reqs: enriched.length }, '[api/supply/orders] ok');
			return { ok: true, orders: enriched };
		} catch (err) {
			app.log.error({}, `[api/supply/orders] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Создать заявку в снабжение по выбранным товарам сделки (из вкладки «Товары»).
	app.post('/api/supply/request', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; itemName?: unknown; qty?: unknown; note?: unknown })
			.map((l) => ({ productId: Number(l.productId), itemName: String(l.itemName ?? ''), qty: Number(l.qty), note: String(l.note ?? '').trim() }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций для заявки' });
		try {
			const scheduleDate = new Date().toISOString().slice(0, 10);
			const { name } = await createSupplyRequest(erp, { dealId, scheduleDate, lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, ...(l.itemName ? { itemName: l.itemName } : {}), ...(l.note ? { note: l.note } : {}) })) });
			app.log.info({ dealId, lines: lines.length, name }, '[api/supply/request] created');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ dealId }, `[api/supply/request] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
