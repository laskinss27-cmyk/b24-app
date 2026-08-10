import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import {
	PAID_REPAIR_SERVICE_NAME,
	WARRANTY_REPAIR_SERVICE_NAME,
	mergeRepairServiceLine,
	setDealB24CollapsedService,
} from '../deal-service.js';
import { ErpClient } from '../erp/client.js';
import { calculateDealPlanTotal, listDealPlan, upsertDealPlan } from '../erp/operations.js';
import {
	existingRepairDealFields,
	repairDealSyncWarning,
	syncExistingRepairDealOperations,
} from '../repair-deal-sync.js';
import type { RepairData } from './repair-record.js';

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

/** Поле сделки «Название объекта» (обязательное). Б24 собирает имя сделки по шаблону {{ID}}_{{это поле}},
 * а TITLE напрямую переопределить нельзя — глобальное автоназвание затирает (проверено). Поэтому пишем
 * сюда «Платный ремонт №N · клиент · устройство» → имя сделки выходит осмысленным. Код поля портал-специфичен
 * (нашли через crm.deal.fields по заголовку «Название объекта»); сменят поле — имя просто станет «{ID}_». */
const DEAL_OBJECT_NAME_FIELD = 'UF_CRM_1750227509';

/** Авто-сделка по клиентскому ремонту. Создаётся ОДИН раз для ремонта с привязанным контактом:
 * у платного сумма = «наша цена», у гарантийного сумма = 0; dealId пишется в карточку → дубля нет.
 * Если вид/цена потом меняются — обновляем сумму и позицию у уже созданной сделки (best-effort). Без контакта не создаём.
 * Возвращает результат для подсказки на фронте. Мутирует data.dealId при создании. */
const QUICKSALE_REPAIR_CATEGORY_ID = 6;
const QUICKSALE_REPAIR_STAGE_ID = 'C6:NEW';

export interface DealSyncResult {
	dealId: number | null;
	created: boolean;
	noContact: boolean;
	coreSynced: boolean;
	b24Synced: boolean;
	syncWarning: string | null;
}

async function syncRepairCoreComposition(
	data: RepairData,
	dealId: number,
	log: FastifyInstance['log'],
): Promise<number> {
	const price = data.payType === 'paid' && typeof data.ourPrice === 'number' ? data.ourPrice : 0;
	const erp = ErpClient.fromEnv();
	if (!erp) throw new Error('ядро склада недоступно — состав ремонтной сделки не синхронизирован');

	const currentPlan = await listDealPlan(erp, dealId);
	const lines = mergeRepairServiceLine(
		currentPlan.map((line) => ({
			productId: line.productId,
			itemName: line.itemName,
			qty: line.qty,
			priceListRate: line.priceListRate,
			discountPercent: line.discountPercent,
			isService: line.isService,
		})),
		data.payType,
		price,
	);

	const today = new Date().toISOString().slice(0, 10);
	await upsertDealPlan(erp, dealId, lines, today);
	const total = await calculateDealPlanTotal(erp, dealId);
	log.info({ dealId, payType: data.payType, repairPrice: price, total, lines: lines.length }, '[repairs] core deal composition synced');
	return total;
}

/**
 * Аварийный fallback: если ядро временно недоступно, не теряем введённую цену.
 * При следующем действии legacy-импорт перенесёт эту точную строку в услугу 19108.
 */
async function setLegacyRepairDealRow(client: B24Client, dealId: number, payType: RepairData['payType'], price: number): Promise<void> {
	const rowName = payType === 'paid' ? PAID_REPAIR_SERVICE_NAME : WARRANTY_REPAIR_SERVICE_NAME;
	await client.call('crm.deal.productrows.set', {
		id: dealId,
		rows: [{ PRODUCT_NAME: rowName, PRICE: price, QUANTITY: 1 }],
	});
}

export async function syncRepairDeal(client: B24Client, data: RepairData, log: FastifyInstance['log']): Promise<DealSyncResult> {
	// Сделка заводится на ЛЮБОЙ ремонт (даже гарантийный): сумма = «наша цена» у платного, 0 у гарантийного.
	const price = data.payType === 'paid' && typeof data.ourPrice === 'number' ? data.ourPrice : 0;
	const contactId = data.client?.contactId ?? null;
	const repairKind = data.payType === 'paid' ? 'Платный ремонт' : 'Гарантийный ремонт';
	const objectName = [`${repairKind} №${data.repairNo}`, data.client?.name, [data.device, data.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
	if (data.dealId) {
		// Ядро обновляем первым и независимо. Этап/направление существующей сделки не трогаем.
		const status = await syncExistingRepairDealOperations({
			syncCore: () => syncRepairCoreComposition(data, data.dealId!, log),
			updateMetadata: () => client.call('crm.deal.update', {
				id: data.dealId,
				fields: existingRepairDealFields(objectName, DEAL_OBJECT_NAME_FIELD),
			}).then(() => undefined),
			syncBitrixRows: (total) => setDealB24CollapsedService(client, data.dealId!, total),
		});
		if (status.coreError) {
			log.error({ dealId: data.dealId }, `[repairs] синхронизация состава с ядром не удалась — ${errInfo(status.coreError)}`);
		}
		if (status.bitrixMetadataError) {
			log.warn({ dealId: data.dealId }, `[repairs] обновление названия сделки не удалось — ${errInfo(status.bitrixMetadataError)}`);
		}
		if (status.bitrixRowsError) {
			log.warn({ dealId: data.dealId }, `[repairs] обновление суммы сделки в Битрикс24 не удалось — ${errInfo(status.bitrixRowsError)}`);
		}
		return {
			dealId: data.dealId,
			created: false,
			noContact: false,
			coreSynced: status.coreSynced,
			b24Synced: status.bitrixMetadataSynced && status.bitrixRowsSynced,
			syncWarning: repairDealSyncWarning(status),
		};
	}
	if (!contactId) {
		return {
			dealId: null,
			created: false,
			noContact: true,
			coreSynced: false,
			b24Synced: false,
			syncWarning: null,
		};
	}
	try {
		// Имя сделки Б24 собирает как {{ID}}_{{Название объекта}} → кладём осмысленное в поле «Название объекта».
		const fields: Record<string, unknown> = {
			TITLE: objectName,
			CONTACT_ID: contactId,
			CATEGORY_ID: QUICKSALE_REPAIR_CATEGORY_ID,
			STAGE_ID: QUICKSALE_REPAIR_STAGE_ID,
			OPPORTUNITY: price,
			CURRENCY_ID: 'RUB',
			[DEAL_OBJECT_NAME_FIELD]: objectName,
		};
		const added = await client.call<number | { id?: number }>('crm.deal.add', { fields });
		const did = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
		if (!did) throw new Error('crm.deal.add не вернул id');
		data.dealId = did;
		let coreSynced = false;
		let b24Synced = false;
		try {
			const total = await syncRepairCoreComposition(data, did, log);
			coreSynced = true;
			try {
				await setDealB24CollapsedService(client, did, total);
				b24Synced = true;
			} catch (err) {
				log.warn({ dealId: did }, `[repairs] обновление суммы новой сделки в Битрикс24 не удалось — ${errInfo(err)}`);
			}
		} catch (err) {
			log.error({ dealId: did }, `[repairs] синхронизация состава новой сделки с ядром не удалась — ${errInfo(err)}`);
			try {
				await setLegacyRepairDealRow(client, did, data.payType, price);
				b24Synced = true;
			} catch (fallbackError) {
				log.warn({ dealId: did }, `[repairs] резервная строка новой сделки не установлена — ${errInfo(fallbackError)}`);
			}
		}
		log.info({ dealId: did, repairNo: data.repairNo, payType: data.payType }, '[repairs] сделка по ремонту создана');
		return {
			dealId: did,
			created: true,
			noContact: false,
			coreSynced,
			b24Synced,
			syncWarning: !coreSynced
				? 'Сделка создана, но её состав в ядре пока не синхронизирован. Нажми «Синхронизировать сделку».'
				: (!b24Synced
					? 'Состав сделки в ядре сохранён, но сумма в Битрикс24 пока не обновилась. Нажми «Синхронизировать сделку».'
					: null),
		};
	} catch (err) {
		log.error({}, `[repairs] создание сделки не удалось — ${errInfo(err)}`);
		return {
			dealId: null,
			created: false,
			noContact: false,
			coreSynced: false,
			b24Synced: false,
			syncWarning: 'Ремонт сохранён, но сделку Битрикс24 создать не удалось. Нажми «Синхронизировать сделку».',
		};
	}
}
