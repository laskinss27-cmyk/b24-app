import { B24ApiError, type B24Client } from './b24/client.js';

/** Единственная служебная строка, которую Битрикс показывает вместо состава сделки из ядра. */
export const B24_COLLAPSE_SERVICE_PRODUCT_ID = 9814;
export const B24_COLLAPSE_SERVICE_NAME = 'Отгрузка подтверждена на сумму';

/** Настоящая нескладская услуга платного ремонта в каталоге и ядре. */
export const PAID_REPAIR_SERVICE_PRODUCT_ID = 19108;
export const PAID_REPAIR_SERVICE_NAME = 'Платный ремонт';
export const WARRANTY_REPAIR_SERVICE_NAME = 'Гарантийный ремонт';

export interface RepairDealPlanLine {
	productId: number;
	itemName?: string;
	qty: number;
	priceListRate: number;
	discountPercent: number;
	isService?: boolean;
}

/** Обновить только ремонтную услугу, не затрагивая оборудование и другие услуги сделки. */
export function mergeRepairServiceLine(
	currentPlan: RepairDealPlanLine[],
	payType: 'paid' | 'warranty',
	price: number,
): RepairDealPlanLine[] {
	if (!Number.isFinite(price) || price < 0) throw new Error('цена платного ремонта должна быть неотрицательным числом');
	const lines = currentPlan
		.filter((line) => line.productId !== PAID_REPAIR_SERVICE_PRODUCT_ID)
		.map((line) => ({ ...line }));
	if (payType === 'paid') {
		lines.push({
			productId: PAID_REPAIR_SERVICE_PRODUCT_ID,
			itemName: PAID_REPAIR_SERVICE_NAME,
			qty: 1,
			priceListRate: price,
			discountPercent: 0,
			isService: true,
		});
	}
	return lines;
}

/** Показать в сделке Битрикса только одну служебную строку с общей суммой из ядра. */
export async function setDealB24CollapsedService(client: B24Client, dealId: number, total: number): Promise<void> {
	try {
		await client.call('crm.deal.productrows.set', {
			id: dealId,
			rows: total > 0
				? [{
					PRODUCT_ID: B24_COLLAPSE_SERVICE_PRODUCT_ID,
					PRODUCT_NAME: B24_COLLAPSE_SERVICE_NAME,
					PRICE: total,
					QUANTITY: 1,
					MEASURE_CODE: 796,
				}]
				: [],
		});
	} catch (error) {
		const immutableLegacyShipment = error instanceof B24ApiError
			&& error.code === 'ERROR_CORE'
			&& /невозможно удалить отгруженный товар/i.test(error.description ?? '');
		if (!immutableLegacyShipment) throw error;

		// Старые сделки могли быть отгружены через нативный склад Б24 до перехода
		// на ядро. Такие строки Битрикс удалить уже не разрешает. Оставляем их как
		// историю, но сумму сделки синхронизируем с актуальным планом ядра.
		await client.call('crm.deal.update', {
			id: dealId,
			fields: {
				IS_MANUAL_OPPORTUNITY: 'Y',
				OPPORTUNITY: total,
			},
		});
	}
}
