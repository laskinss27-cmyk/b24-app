import {conditionStoreTitle, isStockCondition, splitConditionStore, type StockCondition, type StockConditionBalance, type StockConditionChange, type StockConditionHistory} from '@b24-app/shared';
import type {ErpClient} from './client.js';
import {erpContext, erpWarehouse, b24StoreTitle} from './warehouse-context.js';
import {listActiveStoreTitles} from './stock-catalog.js';
import {readDraftDeliveryReservations} from './stock-reservations.js';

const OPERATION = 'b24_condition_operation';
const DETAILS = 'b24_condition_details';
const BASE = 'b24_condition_base';
const STATE = 'b24_stock_condition';

export function validateConditionChange(input: StockConditionChange): void {
	if (!Number.isSafeInteger(input.productId) || input.productId <= 0) throw new Error('Неверный товар');
	if (!input.store.trim() || splitConditionStore(input.store).condition !== 'Обычный') throw new Error('Выберите физический склад');
	if (!isStockCondition(input.from) || !isStockCondition(input.to) || input.from === input.to) throw new Error('Выберите разные исходное и новое состояния');
	if (!Number.isFinite(input.qty) || input.qty <= 0 || input.qty > 1e9 || Math.abs(input.qty * 1e6 - Math.round(input.qty * 1e6)) > 0.001) throw new Error('Количество должно быть положительным, не более 6 знаков после запятой');
	if (input.comment.length > 1000) throw new Error('Комментарий не более 1000 символов');
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.operationId)) throw new Error('Неверный идентификатор операции');
}

async function ensureFields(erp: ErpClient): Promise<void> {
	for (const field of [
		{dt:'Stock Entry',fieldname:OPERATION,label:'B24 Condition Operation',fieldtype:'Data',unique:1,no_copy:1},
		{dt:'Stock Entry',fieldname:DETAILS,label:'B24 Condition Details',fieldtype:'Long Text',no_copy:1},
		{dt:'Warehouse',fieldname:BASE,label:'B24 Condition Base',fieldtype:'Link',options:'Warehouse'},
		{dt:'Warehouse',fieldname:STATE,label:'B24 Stock Condition',fieldtype:'Data'},
	]) {
		if (await erp.get('Custom Field',`${field.dt}-${field.fieldname}`)) continue;
		try { await erp.create('Custom Field',{...field,read_only:1}); }
		catch (error) { if (!await erp.get('Custom Field',`${field.dt}-${field.fieldname}`)) throw error; }
	}
}

export async function readConditionBalances(erp: ErpClient, productId: number): Promise<StockConditionBalance[]> {
	const ctx=await erpContext(erp);
	const [titles,bins,drafts]=await Promise.all([listActiveStoreTitles(erp),erp.list('Bin',['warehouse','actual_qty','reserved_qty'],[['item_code','=',String(productId)]],0),readDraftDeliveryReservations(erp,[productId])]);
	return titles.map(title=>{
		const bin=bins.find(b=>String(b['warehouse'])===erpWarehouse(ctx,title));
		const draftQty=drafts.filter(d=>String(d['warehouse'])===erpWarehouse(ctx,title)).reduce((sum,d)=>sum+Math.max(0,Number(d['qty']??0)),0);
		const actual=Number(bin?.['actual_qty']??0),reserved=Math.max(0,Number(bin?.['reserved_qty']??0))+draftQty;
		return {...splitConditionStore(title),stockTitle:title,actual,reserved,available:Math.max(0,actual-reserved)};
	});
}

export async function readConditionHistory(erp: ErpClient, productId: number): Promise<StockConditionHistory[]> {
	if (!await erp.get('Custom Field',`Stock Entry-${DETAILS}`)) return [];
	const heads=await erp.list('Stock Entry',['name','creation','docstatus',DETAILS],[['docstatus','!=',2],[DETAILS,'like',`%"productId":${productId},%`]],100,'creation desc');
	return heads.flatMap(row=>{
		try { const details=JSON.parse(String(row[DETAILS]??'')) as StockConditionChange & {actor:string};
			return details.productId===productId?[{...details,document:String(row['name']),at:String(row['creation']),submitted:Number(row['docstatus'])===1}]:[];
		} catch { return []; }
	});
}

/** Reuse the same condition when moving between physical locations, including transit. */
export async function ensureConditionLocation(erp:ErpClient,baseTitle:string,condition:StockCondition):Promise<string>{
	const title=conditionStoreTitle(baseTitle,condition);
	if(condition==='Обычный')return title;
	const ctx=await erpContext(erp),baseName=erpWarehouse(ctx,baseTitle),targetName=erpWarehouse(ctx,title);
	const base=await erp.get('Warehouse',baseName);
	if(!base||base['company']!==ctx.company||Number(base['disabled'])===1||Number(base['is_group'])===1||base[BASE])throw new Error('Не найден физический склад состояния');
	await ensureFields(erp);
	let target=await erp.get('Warehouse',targetName);
	if(!target){
		if(title.length>140)throw new Error('Название склада слишком длинное для учёта состояния');
		try{target=await erp.create('Warehouse',{warehouse_name:title,company:ctx.company,parent_warehouse:base['parent_warehouse'],is_group:0,[BASE]:baseName,[STATE]:condition,...(base['warehouse_type']?{warehouse_type:base['warehouse_type']}:{}),...(base['account']?{account:base['account']}:{})});}
		catch(error){target=await erp.get('Warehouse',targetName);if(!target)throw error;}
	}
	if(target[BASE]!==baseName||target[STATE]!==condition||target['company']!==ctx.company||Number(target['disabled'])===1||Number(target['is_group'])===1)throw new Error('Конфликт учётного склада состояния');
	return title;
}

export async function conditionTransferDestination(erp:ErpClient,from:string,to:string):Promise<string>{
	const source=splitConditionStore(from),destination=splitConditionStore(to);
	if(destination.condition!=='Обычный'&&destination.condition!==source.condition)throw new Error('Для смены состояния используйте инструмент в карточке товара');
	return ensureConditionLocation(erp,destination.store,source.condition);
}

/** A native Material Transfer moves quantity between condition locations, never edits Bin/Item. */
export async function changeStockCondition(erp: ErpClient,input: StockConditionChange,actor: string,
	validateReservations: (source: string,qty: number)=>Promise<void>): Promise<{name:string}> {
	validateConditionChange(input);
	const ctx=await erpContext(erp);
	const item=await erp.get('Item',String(input.productId));
	if (!item || Number(item['is_stock_item'])!==1 || Number(item['disabled'])===1) throw new Error('Нужен действующий складской товар');
	const uom=await erp.get('UOM',String(item['stock_uom']??''));
	if (Number(uom?.['must_be_whole_number'])===1 && !Number.isInteger(input.qty)) throw new Error('Для этого товара количество должно быть целым');
	// Native ledger validation provides the final concurrent overdraw guard.
	const settings=await erp.get('Stock Settings','Stock Settings');
	if (!settings || Number(settings['allow_negative_stock'])===1 || Number(item['allow_negative_stock'])===1) throw new Error('Разделение по состояниям требует запрещённого отрицательного остатка в ядре');
	if (Number(item['has_serial_no'])===1 || Number(item['has_batch_no'])===1) throw new Error('Для серийного/партионного товара требуется выбор серий/партий в ядре');
	const baseName=erpWarehouse(ctx,input.store);
	const base=await erp.get('Warehouse',baseName);
	if (!base || Number(base['disabled'])===1 || Number(base['is_group'])===1 || base['company']!==ctx.company || base[BASE] || base['warehouse_type']==='Transit') throw new Error('Неверный физический склад');
	await ensureFields(erp);
	const sourceTitle=conditionStoreTitle(input.store,input.from),targetTitle=conditionStoreTitle(input.store,input.to);
	const source=erpWarehouse(ctx,sourceTitle),target=erpWarehouse(ctx,targetTitle);
	const findExisting=async()=>{
		const rows=await erp.list('Stock Entry',['name'],[[OPERATION,'=',input.operationId]],1);
		return rows[0]?await erp.get('Stock Entry',String(rows[0]['name'])):null;
	};
	const checkExisting=(doc:Record<string,unknown>)=>{
		const saved=JSON.parse(String(doc[DETAILS]??'{}')) as Record<string,unknown>;
		for (const key of Object.keys(input) as Array<keyof StockConditionChange>) if(saved[key]!==input[key]) throw new Error('Идентификатор операции уже использован для других данных');
		if (Number(doc['docstatus'])===2) throw new Error('Операция отменена. Для нового изменения создайте новую операцию');
	};
	let doc=await findExisting();
	if (doc) { checkExisting(doc); if(Number(doc['docstatus'])===1)return {name:String(doc['name'])}; }
	if (input.from!=='Обычный') {
		const sourceDoc=await erp.get('Warehouse',source);
		if (!sourceDoc || sourceDoc[BASE]!==baseName || sourceDoc[STATE]!==input.from) throw new Error('Исходный остаток состояния не найден');
	}
	const balances=await readConditionBalances(erp,input.productId);
	const balance=balances.find(b=>b.stockTitle===sourceTitle);
	if(!balance || input.qty>balance.available+1e-6)throw new Error(`В состоянии «${input.from}» свободно ${balance?.available??0}, указано ${input.qty}`);
	await validateReservations(sourceTitle,input.qty);
	await ensureConditionLocation(erp,input.store,input.to);
	if(!doc){
		try {doc=await erp.create('Stock Entry',{company:ctx.company,stock_entry_type:'Material Transfer',[OPERATION]:input.operationId,[DETAILS]:JSON.stringify({...input,actor}),remarks:`Изменение состояния: ${input.from} → ${input.to}; ${actor}. ${input.comment}`,items:[{item_code:String(input.productId),qty:input.qty,s_warehouse:source,t_warehouse:target}]});}
		catch(error){doc=await findExisting();if(!doc)throw error;checkExisting(doc);}
	}
	const name=String(doc['name']);
	if(Number(doc['docstatus'])!==1){
		try {await erp.submit('Stock Entry',name);}
		catch(error){const current=await erp.get('Stock Entry',name);if(Number(current?.['docstatus'])!==1)throw error;}
	}
	return {name};
}
