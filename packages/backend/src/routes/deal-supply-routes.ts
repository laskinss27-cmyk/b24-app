import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { createSupplyTask, supplyTaskUrl, taskLink } from '../b24/supply-task.js';
import { loadDealOrderInfo } from '../deal-order-info.js';
import {
	DEAL_SUPPLY_CREATED_FLAG,
	listCoreSupplyCards,
	listSupplyCards,
	resolveSupplyStore,
	SUPPLY_CATEGORY_ID,
	SUPPLY_LIST_FIELD,
	SUPPLY_NUMBER_FIELD,
	SUPPLY_STORE_FIELD,
	SUPPLY_TYPE_ID,
	type SupplyCard,
} from '../deal-supply-cards.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealSupplyRoutes(app: FastifyInstance, clientFrom: DealClientFrom): void {
	// Что уже отгружено по строкам сделки (для колонки «Отгружено» и остатков к отгрузке).
	app.post('/api/deal/shipped', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			const [info, b24Supply, coreSupply] = await Promise.all([
				loadDealOrderInfo(client, dealId),
				listSupplyCards(client, dealId).catch(() => [] as SupplyCard[]),
				listCoreSupplyCards(dealId).catch(() => [] as SupplyCard[]),
			]);
			const supply = [...coreSupply, ...b24Supply];
			return {
				ok: true,
				orderId: info.orderId,
				shipped: Object.fromEntries(info.shipped),
				reserves: Object.fromEntries(info.reserves),
				shipments: info.shipments,
				payment: info.payment,
				sourceStoreId: info.sourceStoreId,
				supply,
				rows: [],
			};
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/shipped] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Товар «нет на складах» → в снабжение. Дополняем перечень существующей заявки сделки
	// или создаём карточку «Снабжение» с точным перечнем. Карточку создаём САМИ (робот портала
	// триггерится не на поле — у сделки 36742 «Да» стоит, заявки нет), номер — следующий по
	// счётчику карточек, ответственный — нажавший менеджер (как у ручных заявок).
	app.post('/api/deal/supply-request', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; items?: unknown; storeToName?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const items = (Array.isArray(b.items) ? b.items : [])
			.map((it) => it as { name?: unknown; quantity?: unknown; measure?: unknown })
			.map((it) => ({ name: String(it.name ?? '').trim(), quantity: Number(it.quantity), measure: String(it.measure ?? 'шт') }))
			.filter((it) => it.name && Number.isFinite(it.quantity) && it.quantity > 0);
		if (!items.length) return reply.code(400).send({ ok: false, error: 'no valid items' });
		const storeToName = String(b.storeToName ?? '').trim();

		let listText = items.map((it) => `${it.name} — ${it.quantity} ${it.measure}`).join('\n');
		if (storeToName) listText += `\nПривезти на: ${storeToName}`;
		try {
			const [existing, coreExisting] = await Promise.all([
				listSupplyCards(client, dealId),
				listCoreSupplyCards(dealId).catch(() => [] as SupplyCard[]),
			]);
			const open = existing.find((c) => !/SUCCESS|FAIL/i.test(c.stageId)) ?? existing[0];
			if (open) {
				// Дополняем перечень открытой заявки (только append, чужой текст не трогаем).
				const card = await client.call<{ item?: Record<string, unknown> }>('crm.item.get', { entityTypeId: SUPPLY_TYPE_ID, id: open.id });
				const current = String(card?.item?.[SUPPLY_LIST_FIELD] ?? '').trim();
				const next = current ? `${current}\n\n+ из вкладки сделки:\n${listText}` : listText;
				const fields: Record<string, unknown> = { [SUPPLY_LIST_FIELD]: next };
				// Склад поставки — только если у заявки он ещё не указан (чужой выбор не трогаем).
				if (storeToName && !Number(card?.item?.[SUPPLY_STORE_FIELD] ?? 0)) {
					const el = await resolveSupplyStore(client, storeToName);
					if (el) fields[SUPPLY_STORE_FIELD] = el;
				}
				await client.call('crm.item.update', { entityTypeId: SUPPLY_TYPE_ID, id: open.id, fields });
				app.log.info({ dealId, cardId: open.id }, '[api/deal/supply-request] appended');
				return { ok: true, mode: 'appended', cardId: open.id, title: open.title };
			}
			const coreOpen = coreExisting.find((c) => !/stopped|closed|completed|success|fail/i.test(c.stageId)) ?? coreExisting[0];
			if (coreOpen) {
				return { ok: true, mode: 'exists', cardId: 0, title: coreOpen.title };
			}

			// Новая заявка: номер = max(счётчик свежих карточек)+1, название как у автоматики.
			const me = await client.call<{ ID?: string | number }>('user.current', {});
			const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
			const dealTitle = String(deal?.['TITLE'] ?? '').replace(/^\d+_/, '').slice(0, 60);
			const recent = await client.call<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
				entityTypeId: SUPPLY_TYPE_ID, order: { id: 'desc' }, select: ['id', 'title', SUPPLY_NUMBER_FIELD],
			});
			let maxNum = 0;
			for (const i of (recent?.items ?? []).slice(0, 25)) {
				const fromField = Number(i[SUPPLY_NUMBER_FIELD] ?? 0);
				const fromTitle = Number(/Поставка № (\d+)/.exec(String(i['title'] ?? ''))?.[1] ?? 0);
				maxNum = Math.max(maxNum, fromField, fromTitle);
			}
			const num = maxNum + 1;
			const title = `Поставка № ${num}_${dealId}_${dealTitle}`;
			const storeEl = storeToName ? await resolveSupplyStore(client, storeToName) : null;
			const added = await client.call<{ item?: Record<string, unknown> }>('crm.item.add', {
				entityTypeId: SUPPLY_TYPE_ID,
				fields: {
					title,
					categoryId: SUPPLY_CATEGORY_ID,
					parentId2: dealId,
					assignedById: Number(me?.ID ?? 0) || undefined,
					[SUPPLY_NUMBER_FIELD]: num,
					[SUPPLY_LIST_FIELD]: listText,
					...(storeEl ? { [SUPPLY_STORE_FIELD]: storeEl } : {}),
				},
			});
			const cardId = Number(added?.item?.['id']);
			if (!cardId) throw new Error('crm.item.add (Снабжение) не вернул id');
			const supplyTask = await createSupplyTask(client, {
				title: `Заявка снабжению по сделке #${dealId}`,
				description: [
					`Заявка снабжению: ${title}`,
					`Сделка: #${dealId}`,
					storeToName ? `Привезти на: ${storeToName}` : '',
					'',
					listText,
					'',
					taskLink(supplyTaskUrl(app.config.portalDomain, app.config.appClientId, { dealSupply: dealId }, 'supply'), 'Ссылка для снабжения'),
					taskLink(supplyTaskUrl(app.config.portalDomain, app.config.appClientId, { dealSupply: dealId }, 'manager'), 'Ссылка для менеджера'),
				].filter(Boolean).join('\n'),
				authorId: Number(me?.ID ?? 0),
			});
			if (!supplyTask.taskId) app.log.warn({ dealId, cardId, error: supplyTask.error }, '[api/deal/supply-request] supply task was not created');
			// Галка «Заявка снабжения создана» — чтобы робот портала не создал дубль.
			await client.call('crm.deal.update', { id: dealId, fields: { [DEAL_SUPPLY_CREATED_FLAG]: 1 } })
				.catch((err) => app.log.warn({ dealId }, `[api/deal/supply-request] галка на сделке не встала (не критично) — ${errInfo(err)}`));
			app.log.info({ dealId, cardId, num }, '[api/deal/supply-request] created');
			return { ok: true, mode: 'created', cardId, title };
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/supply-request] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
