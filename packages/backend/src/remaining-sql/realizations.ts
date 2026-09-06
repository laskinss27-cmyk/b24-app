import type { B24Client } from '../b24/client.js';
import { REALIZE_ENTITY } from '../b24/placement.js';
import { canonical, encode } from './codec.js';
import { StateBridge } from './runtime.js';
export interface RealizationMemory {
	id: string; name: string; dealId: number; orderId: number; shipmentId: number;
	stores: Record<string,{storeId:number;storeName:string}>;
}
const bridge = new StateBridge<RealizationMemory[]>('realizations');
export function parseRealizationMemory(items: Array<Record<string, unknown>>): RealizationMemory[] {
	const records = items.map(item => {
		const data = JSON.parse(String(item['DETAIL_TEXT'] ?? '')) as Record<string,unknown>;
		if (!data || Array.isArray(data) || Object.keys(data).some(key => !['dealId','orderId','shipmentId','stores'].includes(key))) throw new Error('Invalid realization source');
		for (const key of ['dealId','orderId','shipmentId']) if (!Number.isSafeInteger(data[key]) || Number(data[key]) <= 0) throw new Error('Invalid realization reference');
		return { ...data, id:String(data['shipmentId']), name:String(item['NAME'] ?? '') } as RealizationMemory;
	}).sort((a,b) => a.shipmentId - b.shipmentId);
	encode('realizations',records);
	return records;
}
export async function readLegacyRealizationMemory(client: B24Client): Promise<RealizationMemory[]> {
	return parseRealizationMemory(await readRealizationSource(client));
}
export async function readRealizationSource(client: B24Client): Promise<Array<Record<string,unknown>>> {
	const items: Array<Record<string,unknown>>=[], ids=new Set<string>();
	let start=0, total: number | undefined;
	for (let page=0; page<1000; page++) {
		const response=await client.callWithMeta<Array<Record<string,unknown>>>('entity.item.get',{ENTITY:REALIZE_ENTITY,SORT:{ID:'ASC'},start});
		if (!Array.isArray(response.result)) throw new Error('Invalid realization page');
		if (response.total != null) {
			const current=Number(response.total);
			if (!Number.isSafeInteger(current) || current<0 || (total!==undefined && current!==total)) throw new Error('Unstable realization total');
			total=current;
		}
		for (const row of response.result) {
			const id=String(row['ID']??''); if (!/^\d+$/.test(id) || ids.has(id)) throw new Error('Duplicate realization source identity');
			ids.add(id);items.push(row);
		}
		if (response.next==null) { if (total!==undefined && total!==items.length) throw new Error('Incomplete realization source'); return items; }
		const next=Number(response.next);
		if (!response.result.length || !Number.isSafeInteger(next) || next<=start) throw new Error('Invalid realization cursor');
		start=next;
	}
	throw new Error('Realization pagination limit');
}
export function readRealizationMemory(client: B24Client) { return bridge.read('global', () => readLegacyRealizationMemory(client)); }
async function mirror(client: B24Client, records: RealizationMemory[]) {
	const raw = await readRealizationSource(client);
	const parsed = parseRealizationMemory(raw);
	const sourceIds = new Map(raw.map(item => [String(JSON.parse(String(item['DETAIL_TEXT'])).shipmentId),String(item['ID'])]));
	for (const row of records) {
		const previous = parsed.find(item => item.shipmentId === row.shipmentId);
		const {id,name,...data} = row;
		let externalId = sourceIds.get(id);
		if (!previous || canonical(previous) !== canonical(row)) {
			if (externalId) await client.call('entity.item.update',{ENTITY:REALIZE_ENTITY,ID:externalId,NAME:name,DETAIL_TEXT:JSON.stringify(data)});
			else {
				const added = await client.call<number | {id?:number}>('entity.item.add',{ENTITY:REALIZE_ENTITY,NAME:name,DETAIL_TEXT:JSON.stringify(data)});
				externalId = String(typeof added === 'number' ? added : added?.id ?? '');
			}
		}
		if (!externalId || !/^\d+$/.test(externalId)) throw new Error('Missing realization mirror identity');
		if (bridge.mode === 'primary') await bridge.connection('global').query('INSERT INTO app_realization_identities(shipment_id,bitrix_external_id) VALUES (?,?) ON DUPLICATE KEY UPDATE bitrix_external_id=VALUES(bitrix_external_id)',[row.shipmentId,externalId]);
	}
}
export async function saveRealizationMemory(client: B24Client, data: Omit<RealizationMemory,'id'|'name'>) {
	return bridge.mutate('global',async () => {
		const rows = await bridge.read('global',() => readLegacyRealizationMemory(client));
		const record = { ...data,id:String(data.shipmentId),name:`ship_${data.shipmentId}` };
		const previous = rows.find(row => row.shipmentId === data.shipmentId);
		if (previous && canonical(previous) !== canonical(record)) throw new Error('Conflicting realization memory');
		if (!previous) rows.push(record);
		rows.sort((a,b) => a.shipmentId - b.shipmentId);
		await bridge.write('global',rows,value => mirror(client,value));
	});
}
export function recoverRealizationMirror(client: B24Client) { return bridge.recover('global',rows => mirror(client,rows)); }
