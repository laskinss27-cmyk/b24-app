import type { B24Client } from '../b24/client.js';
import type { FastifyInstance } from 'fastify';
import type { ErpClient } from '../erp/client.js';
import { fetchErpItemNames, fetchErpStoreStock } from '../erp/operations.js';
import { frozenInventoryDifferences } from '../inventory-stock-snapshot.js';
import { loadInventoryItems } from './inventory-storage.js';

export async function loadInventoryPoint(app: FastifyInstance, client: B24Client, inventoryId: string, storeId: number) {
	const items = await loadInventoryItems(app, client, 'point');
	const item = (items ?? []).find((it) => String(it['ID']) === String(inventoryId));
	if (!item) throw new Error('инвентаризация не найдена');
	const data = item['DETAIL_TEXT'] ? (JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown>) : {};
	const points = Array.isArray(data['points']) ? (data['points'] as Array<Record<string, unknown>>) : [];
	const point = points.find((candidate) => Number(candidate['storeId']) === Number(storeId));
	if (!point) throw new Error('точка не найдена');
	return { item, data, points, pt: point };
}

export async function computeInventoryReconciliationLines(erp: ErpClient, point: Record<string, unknown>) {
	const storeName = String(point['storeName'] ?? '');
	const frozen = frozenInventoryDifferences(point);
	if (frozen) {
		const current = await fetchErpStoreStock(erp, storeName);
		const lines = frozen.map((line) => ({
			productId: line.productId,
			name: line.name,
			bookErp: line.book,
			fact: line.fact,
			diff: line.diff,
			valuation: current.get(line.productId)?.valuation ?? 0,
		}));
		const unnamed = lines.filter((line) => !line.name).map((line) => line.productId);
		if (unnamed.length) {
			const names = await fetchErpItemNames(erp, unnamed);
			for (const line of lines) if (!line.name) line.name = names.get(line.productId) ?? `товар #${line.productId}`;
		}
		lines.sort((left, right) => left.name.localeCompare(right.name, 'ru'));
		return { lines, storeName };
	}

	// Старые инвентаризации без снимка сохраняют прежнюю логику совместимости.
	const facts = (point['draft'] ?? {}) as Record<string, number>;
	const factIds = Object.keys(facts).map(Number).filter((id) => Number.isInteger(id) && id > 0);
	if (!factIds.length) throw new Error('у точки нет фактов подсчёта (draft пуст)');
	const book = await fetchErpStoreStock(erp, storeName);
	const resultLines = ((point['result'] ?? {}) as { lines?: Array<{ productId: number; name?: string }> }).lines ?? [];
	const nameById = new Map(resultLines.map((line) => [Number(line.productId), String(line.name ?? '')]));
	const lines: Array<{ productId: number; name: string; bookErp: number; fact: number; diff: number; valuation: number }> = [];
	for (const productId of factIds) {
		const fact = Number(facts[productId] ?? 0);
		const bookLine = book.get(productId);
		const bookErp = bookLine?.qty ?? 0;
		if (Math.abs(fact - bookErp) < 1e-9) continue;
		lines.push({
			productId,
			name: nameById.get(productId) ?? '',
			bookErp,
			fact,
			diff: fact - bookErp,
			valuation: bookLine?.valuation ?? 0,
		});
	}
	const unnamed = lines.filter((line) => !line.name).map((line) => line.productId);
	if (unnamed.length) {
		const names = await fetchErpItemNames(erp, unnamed);
		for (const line of lines) if (!line.name) line.name = names.get(line.productId) ?? `товар #${line.productId}`;
	}
	lines.sort((left, right) => left.name.localeCompare(right.name, 'ru'));
	return { lines, storeName };
}
