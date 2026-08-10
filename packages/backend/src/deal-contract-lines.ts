import { B24Client } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import { listDealPlan, type PlanItem } from './erp/operations.js';
import type { ContractLine } from './deal-contract-types.js';

const B24_COLLAPSE_PRODUCT_ID = 9814;
const B24_COLLAPSE_SERVICE_NAME = 'Отгрузка подтверждена на сумму';

const clean = (value: unknown): string => String(value ?? '').trim();

function linesFromPlan(plan: PlanItem[]): ContractLine[] {
	return plan
		.filter((item) => item.qty > 0)
		.map((item) => {
			const price = Math.round(item.rate * 100) / 100;
			return {
				name: item.itemName || `#${item.productId}`,
				price,
				quantity: item.qty,
				total: Math.round(price * item.qty * 100) / 100,
			};
		});
}

export function contractLinesFromB24ProductRows(rows: Array<Record<string, unknown>>): ContractLine[] {
	return rows.flatMap((row): ContractLine[] => {
		const productId = Number(row['PRODUCT_ID'] ?? row['productId'] ?? 0);
		const name = clean(row['PRODUCT_NAME'] ?? row['productName']);
		const quantity = Number(row['QUANTITY'] ?? row['quantity'] ?? 0);
		const price = Number(row['PRICE'] ?? row['price'] ?? 0);
		if (
			productId === B24_COLLAPSE_PRODUCT_ID
			|| name === B24_COLLAPSE_SERVICE_NAME
			|| !Number.isFinite(quantity)
			|| quantity <= 0
			|| !Number.isFinite(price)
			|| price < 0
		) return [];
		return [{
			name: name || (productId > 0 ? `#${productId}` : 'Позиция сделки'),
			price: Math.round(price * 100) / 100,
			quantity,
			total: Math.round(price * quantity * 100) / 100,
		}];
	});
}

export async function loadContractLines(client: B24Client, erp: ErpClient, dealId: number): Promise<ContractLine[]> {
	void client;
	return linesFromPlan(await listDealPlan(erp, dealId));
}
