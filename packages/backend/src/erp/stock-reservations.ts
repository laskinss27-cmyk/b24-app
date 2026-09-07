import type {ErpClient} from './client.js';
/** Frappe may return only names for child-table list queries despite requested fields. */
export async function readDraftDeliveryReservations(erp:ErpClient,productIds:number[]):Promise<Array<Record<string,unknown>>>{
	if(!productIds.length)return [];
	const ids=[...new Set(productIds.map(String))];
	const result:Array<Record<string,unknown>>=[];
	for(let offset=0;offset<ids.length;offset+=100){
		const rows=await erp.list('Delivery Note Item',['name','item_code','warehouse','qty','docstatus'],[['item_code','in',ids.slice(offset,offset+100)],['docstatus','=',0]],0);
		for(let start=0;start<rows.length;start+=10){
			const hydrated=await Promise.all(rows.slice(start,start+10).map(async row=>{
				if(['item_code','warehouse','qty'].every(key=>Object.hasOwn(row,key)))return row;
				const name=String(row['name']??'');
				if(!name)throw new Error('Ядро не вернуло идентификатор строки черновика');
				const full=await erp.get('Delivery Note Item',name);
				if(!full||!Object.hasOwn(full,'qty')||!Object.hasOwn(full,'warehouse'))throw new Error('Не удалось проверить количество черновика реализации');
				return full;
			}));
			result.push(...hydrated.filter(row=>Number(row['docstatus']??0)===0&&ids.includes(String(row['item_code']))));
		}
	}
	return result;
}
