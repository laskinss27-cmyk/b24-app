import type { ErpClient } from './client.js';

// Leave room below the ERP HTTP server's 4094-byte request-line limit.
const MAX_REQUEST_BYTES = 3500;

/** Unlimited list with AND filters on scalar document fields. Splits oversized IN
 * filters into disjoint queries; keeps every returned row, including equal movements.
 * Use neither child-table filters nor global sorting/pagination with this helper.
 */
export async function listWithBatchedInFilters<T = Record<string, unknown>>(
	erp: ErpClient,
	doctype: string,
	fields: string[],
	filters: unknown[],
): Promise<T[]> {
	const normalized = filters.map((filter) => Array.isArray(filter) && filter[1] === 'in' && Array.isArray(filter[2])
		? [filter[0], filter[1], [...new Set(filter[2])]] : filter);

	async function read(batchFilters: unknown[]): Promise<T[]> {
		const query = new URLSearchParams({ fields: JSON.stringify(fields), limit_page_length: '0', filters: JSON.stringify(batchFilters) });
		const line = `GET /api/resource/${encodeURIComponent(doctype)}?${query} HTTP/1.1`;
		if (Buffer.byteLength(line) <= MAX_REQUEST_BYTES) return erp.list<T>(doctype, fields, batchFilters);

		let splitIndex = -1;
		let largest = 0;
		for (let index = 0; index < batchFilters.length; index++) {
			const filter = batchFilters[index];
			if (!Array.isArray(filter) || filter[1] !== 'in' || !Array.isArray(filter[2]) || filter[2].length < 2) continue;
			const size = new URLSearchParams({ values: JSON.stringify(filter[2]) }).toString().length;
			if (size > largest) { largest = size; splitIndex = index; }
		}
		if (splitIndex < 0) throw new Error(`ERPNext: фильтр ${doctype} превышает допустимую длину HTTP-запроса`);
		const filter = batchFilters[splitIndex] as [string, string, unknown[]];
		const middle = Math.ceil(filter[2].length / 2);
		const output: T[] = [];
		for (const values of [filter[2].slice(0, middle), filter[2].slice(middle)]) {
			const part = batchFilters.map((current, index) => index === splitIndex ? [filter[0], filter[1], values] : current);
			output.push(...await read(part));
		}
		return output;
	}
	return read(normalized);
}
