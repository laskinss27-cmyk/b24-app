import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

/** Прочитать ВСЕ записи ctv_repairs постранично. entity.item.get отдаёт ~50 за раз — без пагинации
 * скан номеров (и список) теряет свежие ремонты при >50 записей (отсюда был дубль repairNo). Если
 * портал не поддерживает `start` (та же первая запись повторно) — выходим, чтобы не зациклиться. */
export async function fetchAllRepairs(client: B24Client): Promise<Array<Record<string, unknown>>> {
	const all: Array<Record<string, unknown>> = [];
	let start = 0;
	let prevFirstId: string | null = null;
	for (let page = 0; page < 40; page++) {
		const batch = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, SORT: { ID: 'DESC' }, start });
		const items = Array.isArray(batch) ? batch : [];
		if (!items.length) break;
		const firstId = String(items[0]?.['ID'] ?? '');
		if (firstId === prevFirstId) break; // `start` не поддержан — та же страница, дальше не идём
		prevFirstId = firstId;
		all.push(...items);
		if (items.length < 50) break;
		start += items.length;
	}
	return all;
}

/** Свой номер ремонта (со 100, дальше max+1) — общий для обоих потоков. На сбое скана — уникальный по времени
 *  (фикс.100 плодил дубли). Гонка при одновременном создании маловероятна для канарейки. */
export async function assignRepairNo(client: B24Client, log: FastifyInstance['log']): Promise<number> {
	try {
		const existing = await fetchAllRepairs(client);
		let max = 99, withNo = 0;
		for (const it of existing) {
			try { const d = it['DETAIL_TEXT'] ? (JSON.parse(String(it['DETAIL_TEXT'])) as { repairNo?: unknown }) : {}; const n = Number(d.repairNo); if (Number.isFinite(n) && n > 0) { withNo++; if (n > max) max = n; } } catch { /* битая запись */ }
		}
		const assigned = max + 1;
		log.info({ scanned: existing.length, withRepairNo: withNo, maxRepairNo: max, assigned }, '[api/repairs] номер присвоен');
		return assigned;
	} catch (err) {
		const rn = 100 + (Date.now() % 100000);
		log.error({ repairNo: rn }, `[api/repairs] скан номеров упал, присвоен уникальный по времени — ${errInfo(err)}`);
		return rn;
	}
}
