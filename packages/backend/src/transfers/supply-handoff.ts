import { randomUUID } from 'node:crypto';
import type { StoredTransferRequest } from './request-model.js';

export interface SupplyHandoffInput { toStore: string; deadline: string; productIds: number[] }
export interface SupplyHandoffPorts {
	prepare(input: { dealId: number; scheduleDate: string; toStore: string; note: string; lines: Array<{ productId: number; itemName: string; qty: number; note: string }> }): Promise<Record<string, unknown>>;
	create(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
	find(title: string): Promise<Array<Record<string, unknown>>>;
	save(request: StoredTransferRequest): Promise<void>;
}

export function validateSupplyHandoff(request: StoredTransferRequest, input: SupplyHandoffInput): void {
	if (request.kind !== 'supply' || request.status !== 'pending') throw new Error('Заявка уже обработана или не является заявкой снабжению');
	if (!input.toStore.trim()) throw new Error('Выберите конечный склад');
	const date = new Date(input.deadline + 'T00:00:00Z');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deadline) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.deadline) throw new Error('Укажите корректную крайнюю дату поставки');
	if (!Array.isArray(input.productIds) || input.productIds.length !== request.supplyLines.length || !input.productIds.length || input.productIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Сопоставьте каждую позицию заявки с товаром каталога');
}

/** Save intent before POST. Retrying an uncertain POST reconciles by its unique
 * title and never creates another document. A missing result requires review. */
export async function handoffSupplyRequest(request: StoredTransferRequest, input: SupplyHandoffInput, actor: { id: string; name: string }, ports: SupplyHandoffPorts): Promise<StoredTransferRequest> {
	if (request.kind !== 'supply') throw new Error('Это не заявка снабжению');
	if (request.status === 'converted' && request.supplyRequestName) return request;
	if (request.status !== 'pending') throw new Error('Заявка уже обработана');
	let working = request;
	let document: Record<string, unknown>;
	if (request.supplyHandoff) {
		const matches = await ports.find(request.supplyHandoff.title);
		if (matches.length !== 1 || Number(matches[0]?.['docstatus']) === 2) throw new Error('Результат предыдущей передачи требует сверки. Повторный документ не создан; обратитесь к администратору');
		document = matches[0]!;
	} else {
		validateSupplyHandoff(request, input);
		// Preserve all source rows and quantities, including duplicate selected SKUs.
		const grouped = new Map<number, { productId: number; itemName: string; qty: number; note: string }>();
		request.supplyLines.forEach((line, index) => {
			const productId = input.productIds[index]!;
			const note = [line.name, line.link, line.note].filter(Boolean).join('\n');
			const prior = grouped.get(productId);
			if (prior) { prior.qty += line.qty; prior.note += '\n' + note; }
			else grouped.set(productId, { productId, itemName: line.productId === productId ? line.name : `#${productId}`, qty: line.qty, note });
		});
		const title = `Заявка ТТ #${request.id} · ${randomUUID()}`;
		const payload = await ports.prepare({ dealId: 0, scheduleDate: input.deadline, toStore: input.toStore, note: request.note || `Заявка ТТ #${request.id}`, lines: [...grouped.values()] });
		payload['title'] = title;
		working = { ...request, supplyHandoff: { title, at: new Date().toISOString(), byId: actor.id, byName: actor.name, payload } };
		await ports.save(working);
		document = await ports.create(payload);
	}
	if (typeof document['name'] !== 'string' || !document['name']) throw new Error('Ядро не подтвердило номер заявки; требуется сверка');
	const result: StoredTransferRequest = { ...working, status: 'converted', supplyRequestName: document['name'], convertedAt: working.supplyHandoff!.at, convertedById: working.supplyHandoff!.byId, convertedByName: working.supplyHandoff!.byName };
	await ports.save(result);
	return result;
}
