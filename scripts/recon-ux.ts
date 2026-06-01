/**
 * Read-only разведка для Sprint 1 UX (вкладка «Товары»).
 *
 * Бьём DEV_WEBHOOK, НИЧЕГО не пишем. Цель — снять неизвестные перед сборкой:
 *   1) откуда брать закупочную цену
 *      (PROPERTY_338/362 на товаре vs catalog.product.purchasingPrice vs документы прихода/FIFO)
 *   2) как отличать «работы» (услуги) от «товаров» в строках сделки
 *      (TYPE строки? тип товара в каталоге? free-form строка с PRODUCT_ID=0?)
 *   3) как устроены документы реализации/отгрузки — для «Отгружено N/M»
 *   4) форма остатков по складам (catalog.store.product.list), фильтр amount>0
 *   5) найти живую сделку с товарами (32592 — пустая, для write-тестов позже)
 *
 * Запуск:  npx tsx scripts/recon-ux.ts
 * Вывод компактный — потом читаю и синтезирую, в git не коммитим результат.
 */

import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) {
	console.error('DEV_WEBHOOK не задан в .env');
	process.exit(1);
}
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

// ── helpers ──────────────────────────────────────────────────────────────────
function hr(title: string): void {
	console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}
function j(label: string, data: unknown): void {
	let s = JSON.stringify(data, null, 2);
	if (s && s.length > 4000) s = s.slice(0, 4000) + `\n…(обрезано, всего ${s.length} симв.)`;
	console.log(`${label}:\n${s}`);
}
async function tryCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
	try {
		return await client.call<T>(method, params);
	} catch (err) {
		if (err instanceof B24ApiError) {
			console.log(`  ⛔ ${method} → ${err.code}: ${err.description ?? ''}`);
		} else {
			console.log(`  ⛔ ${method} → ${String(err)}`);
		}
		return null;
	}
}

async function main(): Promise<void> {
	// ── 1. Склады ───────────────────────────────────────────────────────────
	hr('1. СКЛАДЫ (catalog.store.list)');
	const stores = await tryCall<{ stores?: Array<Record<string, unknown>> }>('catalog.store.list', {
		select: ['id', 'title', 'active', 'address', 'sort'],
		order: { id: 'ASC' },
	});
	const storeList = stores?.stores ?? [];
	console.log(`Складов: ${storeList.length}`);
	j('stores', storeList.map((s) => ({ id: s['id'], title: s['title'], active: s['active'] })));

	// ── 2. Ищем живую сделку с товарами ───────────────────────────────────────
	hr('2. ПОИСК ЗАПОЛНЕННОЙ СДЕЛКИ (crm.deal.list → productrows)');
	const deals = await tryCall<Array<Record<string, unknown>>>('crm.deal.list', {
		order: { ID: 'DESC' },
		filter: { '>OPPORTUNITY': 0 },
		select: ['ID', 'TITLE', 'OPPORTUNITY', 'CURRENCY_ID', 'CATEGORY_ID', 'STAGE_ID'],
		start: 0,
	});
	const dealIds = (deals ?? []).slice(0, 25).map((d) => Number(d['ID']));
	// гарантированно проверим и 32592 (должна быть пустой)
	if (!dealIds.includes(32592)) dealIds.push(32592);
	console.log(`Проверяю строки у ${dealIds.length} сделок: ${dealIds.join(', ')}`);

	const rowsBatch: Record<string, { method: string; params: Record<string, unknown> }> = {};
	for (const id of dealIds) rowsBatch[`d${id}`] = { method: 'crm.deal.productrows.get', params: { id } };
	const rowsRes = await client.callBatch(rowsBatch).catch((e) => {
		console.log('batch productrows failed', String(e));
		return null;
	});

	const rowCounts: Array<{ dealId: number; rows: number }> = [];
	const rowsByDeal: Record<number, Array<Record<string, unknown>>> = {};
	if (rowsRes) {
		for (const id of dealIds) {
			const r = rowsRes.result[`d${id}`] as Array<Record<string, unknown>> | undefined;
			const arr = Array.isArray(r) ? r : [];
			rowsByDeal[id] = arr;
			rowCounts.push({ dealId: id, rows: arr.length });
		}
	}
	rowCounts.sort((a, b) => b.rows - a.rows);
	j('Кол-во строк по сделкам (desc)', rowCounts);

	// кандидат — сделка с наибольшим числом строк
	const candidate = rowCounts.find((c) => c.rows > 0)?.dealId;
	if (!candidate) {
		console.log('⚠️ Ни одной сделки с товарами не нашли в выборке. Дальше по складам/товарам наугад.');
	}

	// ── 3. Строки сделки-кандидата: TYPE, цены, кол-во ────────────────────────
	hr(`3. СТРОКИ СДЕЛКИ-КАНДИДАТА #${candidate ?? '—'} (crm.deal.productrows.get)`);
	const candRows = candidate ? rowsByDeal[candidate] : [];
	j(
		'Строки (сырьё, ключевые поля)',
		candRows.map((r) => ({
			ID: r['ID'],
			PRODUCT_ID: r['PRODUCT_ID'],
			PRODUCT_NAME: r['PRODUCT_NAME'],
			TYPE: r['TYPE'],
			PRICE: r['PRICE'],
			QUANTITY: r['QUANTITY'],
			DISCOUNT_SUM: r['DISCOUNT_SUM'],
			MEASURE_NAME: r['MEASURE_NAME'],
		})),
	);
	const typeDistribution: Record<string, number> = {};
	for (const r of candRows) {
		const t = String(r['TYPE']);
		typeDistribution[t] = (typeDistribution[t] ?? 0) + 1;
	}
	j('Распределение TYPE в строках (какие бывают значения)', typeDistribution);
	const productIds = [...new Set(candRows.map((r) => Number(r['PRODUCT_ID'])).filter((x) => x > 0))].slice(0, 8);
	console.log(`Уникальных PRODUCT_ID (>0) для дальнейших проб: ${productIds.join(', ') || '— (возможно free-form строки)'}`);
	const freeFormRows = candRows.filter((r) => Number(r['PRODUCT_ID']) === 0);
	console.log(`Строк с PRODUCT_ID=0 (free-form, кандидат на «работы»): ${freeFormRows.length}`);

	// ── 4. Товары: тип (товар/услуга) + закупочная цена (3 источника) ─────────
	hr('4. ТОВАРЫ — ТИП и ЗАКУПКА (crm.product.get / catalog.product.get)');
	if (productIds.length) {
		const prodBatch: Record<string, { method: string; params: Record<string, unknown> }> = {};
		for (const pid of productIds) {
			prodBatch[`crm${pid}`] = { method: 'crm.product.get', params: { id: pid } };
			prodBatch[`cat${pid}`] = { method: 'catalog.product.get', params: { id: pid } };
		}
		const prodRes = await client.callBatch(prodBatch).catch(() => null);
		for (const pid of productIds) {
			const crmP = prodRes?.result[`crm${pid}`] as Record<string, unknown> | undefined;
			const catWrap = prodRes?.result[`cat${pid}`] as { product?: Record<string, unknown> } | undefined;
			const catP = catWrap?.product;
			console.log(`\n— PRODUCT_ID ${pid} —`);
			// crm.product.get: тип + любые PROPERTY_*
			if (crmP) {
				const props: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(crmP)) {
					if (k.startsWith('PROPERTY_') && v != null && v !== '') props[k] = v;
				}
				console.log(
					`  crm.product.get: NAME=${JSON.stringify(crmP['NAME'])} TYPE=${JSON.stringify(crmP['TYPE'])} SECTION_ID=${JSON.stringify(crmP['SECTION_ID'])}`,
				);
				j('  заполненные PROPERTY_* (ищем 338/362 «Закупка»)', props);
			} else {
				console.log('  crm.product.get → нет данных');
			}
			// catalog.product.get: нативный purchasingPrice + type
			if (catP) {
				console.log(
					`  catalog.product.get: type=${JSON.stringify(catP['type'])} purchasingPrice=${JSON.stringify(catP['purchasingPrice'])} purchasingCurrency=${JSON.stringify(catP['purchasingCurrency'])}`,
				);
			} else {
				console.log('  catalog.product.get → нет данных (нет scope catalog? или не каталожный товар)');
			}
		}
	} else {
		console.log('Нет PRODUCT_ID для проб — пропускаю.');
	}

	// ── 5. Остатки по складам для первого товара ──────────────────────────────
	hr('5. ОСТАТКИ ПО СКЛАДАМ (catalog.store.product.list) — форма ответа + фильтр >0');
	const probePid = productIds[0];
	if (probePid) {
		const sp = await tryCall<{ storeProducts?: Array<Record<string, unknown>> }>('catalog.store.product.list', {
			filter: { productId: probePid },
			select: ['id', 'storeId', 'productId', 'amount', 'quantityReserved'],
		});
		const list = sp?.storeProducts ?? [];
		console.log(`storeProducts для PRODUCT_ID ${probePid}: ${list.length} строк`);
		j('Все строки остатков (сырьё)', list);
		j(
			'Только склады с amount>0 (как будем фильтровать)',
			list.filter((x) => Number(x['amount']) > 0).map((x) => ({ storeId: x['storeId'], amount: x['amount'] })),
		);
	} else {
		console.log('Нет товара для пробы остатков.');
	}

	// ── 6. Складские документы: типы + привязка + поля строки (закупка/FIFO) ──
	hr('6. СКЛАДСКИЕ ДОКУМЕНТЫ (catalog.document.list / .element.list)');
	const docs = await tryCall<{ documents?: Array<Record<string, unknown>> }>('catalog.document.list', {
		select: ['id', 'docType', 'status', 'total', 'title', 'commentary', 'dateModify'],
		order: { id: 'DESC' },
	});
	const docList = (docs?.documents ?? []).slice(0, 40);
	const docTypeCount: Record<string, number> = {};
	for (const d of docList) {
		const t = String(d['docType']);
		docTypeCount[t] = (docTypeCount[t] ?? 0) + 1;
	}
	j('Типы документов в последних 40 (docType → кол-во)', docTypeCount);
	j(
		'Последние 12 документов (тип/статус/заголовок/коммент — ищем привязку к сделке)',
		docList.slice(0, 12).map((d) => ({
			id: d['id'],
			docType: d['docType'],
			status: d['status'],
			total: d['total'],
			title: d['title'],
			commentary: d['commentary'],
		})),
	);

	// по одному примеру элементов на каждый встреченный тип документа
	hr('6b. ЭЛЕМЕНТЫ ДОКУМЕНТОВ по типам (catalog.document.element.list) — где живёт закупка');
	const seenTypes = new Set<string>();
	const sampleDocs: Array<{ id: number; docType: string }> = [];
	for (const d of docList) {
		const t = String(d['docType']);
		if (!seenTypes.has(t)) {
			seenTypes.add(t);
			sampleDocs.push({ id: Number(d['id']), docType: t });
		}
	}
	for (const sd of sampleDocs) {
		const els = await tryCall<{ documentElements?: Array<Record<string, unknown>> }>('catalog.document.element.list', {
			filter: { docId: sd.id },
		});
		const arr = (els?.documentElements ?? []).slice(0, 3);
		console.log(`\n— docType=${sd.docType} (doc #${sd.id}), элементов показываю ${arr.length} —`);
		j('элементы (сырьё — смотрим purchasingPrice/amount/storeFrom/storeTo/elementId)', arr);
	}

	hr('ГОТОВО — разведка завершена, ничего не записано');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
