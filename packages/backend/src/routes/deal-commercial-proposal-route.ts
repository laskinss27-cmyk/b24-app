import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { enrichProducts as enrichCatalogProducts } from '../b24/catalog.js';
import { dealExportRows } from '../deal-export-rows.js';
import { ErpClient } from '../erp/client.js';
import { listDealPlan, listDealQuoteVariants, listDealStages, type DealStage, type PlanItem } from '../erp/operations.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealCommercialProposalRoute(app: FastifyInstance, clientFrom: DealClientFrom): void {
	// Данные для КП (коммерческого предложения) из сделки: клиент, менеджер, товары/работы,
	// артикулы, фото из товарной базы Б24 и итоги. Документ собирает фронт.
	app.post('/api/deal/kp', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; variantId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
			const contactId = Number(deal?.['CONTACT_ID'] ?? 0);
			const assignedId = Number(deal?.['ASSIGNED_BY_ID'] ?? 0);
			const [contact, mgrRaw] = await Promise.all([
				contactId ? client.call<Record<string, unknown>>('crm.contact.get', { id: contactId }).catch(() => null) : Promise.resolve(null),
				assignedId ? client.call<unknown>('user.get', { ID: assignedId }).then((r) => (Array.isArray(r) ? r[0] : r) as Record<string, unknown> | null).catch(() => null) : Promise.resolve(null),
			]);
			const clientName = contact ? [contact['NAME'], contact['LAST_NAME']].filter(Boolean).join(' ').trim() : '';
			const phones = contact?.['PHONE'] as Array<{ VALUE?: string }> | undefined;
			const clientPhone = String(phones?.[0]?.VALUE ?? '');
			const mgrName = mgrRaw ? [mgrRaw['NAME'], mgrRaw['LAST_NAME']].filter(Boolean).join(' ').trim() : '';
			// Только РАБОЧИЙ телефон менеджера (личный мобильный в КП не светим). Пусто — строка без телефона.
			const mgrPhone = mgrRaw ? String(mgrRaw['WORK_PHONE'] ?? '') : '';
			// Артикул из хвоста названия (Eltis B-21, Lock-E01) — простой regex, только если в нём есть цифра.
			const articleOf = (name: string): string => {
				const m = /([A-Za-zА-Яа-я0-9][A-Za-z0-9\-/.]{3,})\s*$/.exec(name.trim());
				return m && m[1] && /\d/.test(m[1]) ? m[1] : '';
			};
			// КП должно смотреть на НАШ состав сделки из ядра (Sales Order), а не на нативные строки Б24:
			// в Б24 мы специально держим одну служебную строку на всю сумму.
			const erp = ErpClient.fromEnv();
			const source = 'core';
			const variantId = String(b.variantId ?? '').trim();
			const variantState = erp && variantId ? await listDealQuoteVariants(erp, dealId) : null;
			const variant = variantState?.variants.find((row) => row.id === variantId);
			const variantItems = variant?.items ?? null;
			if (erp && variantId && !variantItems) throw new Error('вариант КП не найден');
			type KpRawRow = { productId: number; name: string; type: number; qty: number; price: number; stage?: string };
			let raw: KpRawRow[] = [];
			if (erp && variantItems) {
				raw = variantItems.map((r) => ({
					productId: r.productId,
					name: r.itemName || `#${r.productId}`,
					type: r.isService ? 7 : 1,
					qty: r.qty,
					price: r.priceListRate * (1 - r.discountPercent / 100),
				}));
			} else if (erp) {
				const [plan, stages] = await Promise.all([
					listDealPlan(erp, dealId),
					listDealStages(erp, dealId),
				]).catch((err) => {
					app.log.warn({ dealId }, `[api/deal/kp] core plan failed — ${errInfo(err)}`);
					return [[], []] as [PlanItem[], DealStage[]];
				});
				raw = dealExportRows(plan, stages, []).map((r) => ({
					productId: r.productId,
					name: r.name,
					type: r.type === 'Работа' ? 7 : 1,
					qty: r.quantity,
					price: r.priceListRate * (1 - r.discountPercent / 100),
					stage: r.stage,
				}));
			}
			// Этапы остаются только внутри карточки сделки. Для клиентского КП
			// одинаковые позиции с одинаковой ценой объединяем в одну строку.
			const flattened = new Map<string, KpRawRow>();
			for (const row of raw) {
				if (!Number.isFinite(row.qty) || row.qty <= 0) continue;
				const key = [row.productId, row.type, row.name, row.price].join('\u0000');
				const current = flattened.get(key);
				if (current) current.qty += row.qty;
				else {
					flattened.set(key, {
						productId: row.productId,
						name: row.name,
						type: row.type,
						qty: row.qty,
						price: row.price,
					});
				}
			}
			const printRows = [...flattened.values()];
			const catalogInfo = await enrichCatalogProducts(
				client,
				printRows.filter((row) => row.type !== 7).map((row) => row.productId),
			).catch((err) => {
				app.log.warn({ dealId }, `[api/deal/kp] catalog images failed — ${errInfo(err)}`);
				return new Map();
			});
			const rows = printRows
				.map((r) => ({ productId: Number(r.productId), name: String(r.name ?? ''), type: Number(r.type), qty: Number(r.qty), price: Number(r.price) }))
				.filter((r) => Number.isFinite(r.qty) && r.qty > 0)
				.map((r) => {
					const info = catalogInfo.get(r.productId);
					return {
						productId: r.productId,
						name: r.name,
						article: info?.article || info?.model || articleOf(r.name),
						qty: r.qty,
						price: r.price,
						sum: r.price * r.qty,
						isWork: r.type === 7,
						...(info?.photoPath ? { photoPath: info.photoPath } : {}),
					};
				});
			const goods = rows.filter((r) => !r.isWork);
			const works = rows.filter((r) => r.isWork);
			const sumGoods = goods.reduce((a, r) => a + r.sum, 0);
			const sumWorks = works.reduce((a, r) => a + r.sum, 0);
			app.log.info({ dealId, source, goods: goods.length, works: works.length }, '[api/deal/kp] ok');
			return {
				ok: true,
				kp: {
					number: dealId, date: String(deal?.['DATE_CREATE'] ?? ''), title: String(deal?.['TITLE'] ?? ''),
					client: { name: clientName, phone: clientPhone },
					manager: { name: mgrName, phone: mgrPhone },
					goods, works, sumGoods, sumWorks, total: sumGoods + sumWorks,
				},
			};
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/kp] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
