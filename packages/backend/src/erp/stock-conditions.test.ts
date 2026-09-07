import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {conditionStoreTitle,splitConditionStore,stockChoiceLabel,type StockConditionChange} from '@b24-app/shared';
import {changeStockCondition,readConditionBalances,readConditionHistory,validateConditionChange} from './stock-conditions.js';
import {createRealizationDraft,submitRealization} from './deal-realizations.js';
import type {ErpClient} from './client.js';
import {readDraftDeliveryReservations} from './stock-reservations.js';
import {shipTransferToTransit,completeTransferFromTransit} from './stock-transfers.js';

type Row=Record<string,unknown>;
function fake(){
	const db=new Map<string,Map<string,Row>>();
	const table=(dt:string)=>{if(!db.has(dt))db.set(dt,new Map());return db.get(dt)!;};
	const put=(dt:string,row:Row)=>{table(dt).set(String(row['name']),row);return row;};
	put('Company',{name:'Умный дом',abbr:'УД'});
	put('Stock Settings',{name:'Stock Settings',allow_negative_stock:0});
	put('Item',{name:'5110',item_name:'Монитор 5110',is_stock_item:1,disabled:0,stock_uom:'шт',has_serial_no:0,has_batch_no:0});
	put('UOM',{name:'шт',must_be_whole_number:1});
	put('Warehouse',{name:'Склад - УД',warehouse_name:'Склад',company:'Умный дом',is_group:0,disabled:0,parent_warehouse:'All Warehouses - УД'});
	put('Bin',{name:'original',item_code:'5110',warehouse:'Склад - УД',actual_qty:10,reserved_qty:0});
	let seq=0;let loseSubmitResponse=false;
	const matches=(row:Row,filter:unknown[])=>{const [field,op,value]=filter;const actual=row[String(field)];if(op==='=')return String(actual??'')===String(value);if(op==='!=')return String(actual??'')!==String(value);if(op==='in')return (value as unknown[]).some(v=>String(v)===String(actual));if(op==='like')return String(actual??'').includes(String(value).replaceAll('%',''));throw Error(`Unknown filter ${op}`);};
	const api={
		async get(dt:string,name:string){return structuredClone(table(dt).get(name)??null);},
		async list(dt:string,_fields:string[],filters:unknown[][]=[]){return structuredClone([...table(dt).values()].filter(r=>filters.every(f=>matches(r,f))));},
		async create(dt:string,fields:Row){
			if(dt==='Stock Entry'&&fields['b24_condition_operation']&&[...table(dt).values()].some(r=>r['b24_condition_operation']===fields['b24_condition_operation']))throw Error('duplicate key');
			const name=dt==='Custom Field'?`${fields['dt']}-${fields['fieldname']}`:dt==='Warehouse'?`${fields['warehouse_name']} - УД`:String(fields['name']??`${dt}-${++seq}`);
			return structuredClone(put(dt,{name,docstatus:0,creation:'2026-09-07 10:00:00',...(dt==='Warehouse'?{disabled:0}:{}),...fields}));
		},
		async submit(dt:string,name:string){
			const doc=table(dt).get(name)!;
			if(Number(doc['docstatus'])===1)return;
			for(const line of doc['items'] as Row[]){
				const warehouse=String(line['s_warehouse']??line['warehouse']);
				const source=[...table('Bin').values()].find(b=>b['warehouse']===warehouse&&b['item_code']===line['item_code']);
				if(!source||Number(source['actual_qty'])<Number(line['qty']))throw Error('Insufficient stock');
				source['actual_qty']=Number(source['actual_qty'])-Number(line['qty']);
				if(dt==='Stock Entry'){
					let target=[...table('Bin').values()].find(b=>b['warehouse']===line['t_warehouse']);
					if(!target)target=put('Bin',{name:`bin-${++seq}`,warehouse:line['t_warehouse'],item_code:line['item_code'],actual_qty:0,reserved_qty:0});
					target['actual_qty']=Number(target['actual_qty'])+Number(line['qty']);
				}
			}
			doc['docstatus']=1;
			if(loseSubmitResponse){loseSubmitResponse=false;throw Error('Connection lost after commit');}
		},
		async update(dt:string,name:string,fields:Row){const row=table(dt).get(name)!;Object.assign(row,fields);return structuredClone(row);},
		async delete(dt:string,name:string){table(dt).delete(name);},
	};
	return {erp:api as unknown as ErpClient,table,put,loseResponse:()=>{loseSubmitResponse=true;}};
}
const input=(changes:Partial<StockConditionChange>={}):StockConditionChange=>({productId:5110,store:'Склад',from:'Обычный',to:'Сток',qty:1,comment:'Проверка',operationId:randomUUID(),...changes});
const allow=async()=>{};

test('10 normal → 9 normal + 1 stock → sale of stock leaves only 9 normal',async()=>{
	const f=fake();const original=structuredClone(f.table('Item').get('5110'));
	const result=await changeStockCondition(f.erp,input(),'Иван #7',allow);
	assert.ok(result.name);
	const balances=await readConditionBalances(f.erp,5110);
	assert.deepEqual(balances.map(b=>[b.condition,b.actual]).sort(),[['Обычный',9],['Сток',1]].sort());
	assert.equal(balances.reduce((s,b)=>s+b.actual,0),10);
	assert.deepEqual(f.table('Item').get('5110'),original);
	const draft=await createRealizationDraft(f.erp,{dealId:77,lines:[{productId:5110,qty:1,rate:100,storeTitle:conditionStoreTitle('Склад','Сток')}]});
	await submitRealization(f.erp,draft.name);
	const after=await readConditionBalances(f.erp,5110);
	assert.equal(after.find(b=>b.condition==='Обычный')?.actual,9);
	assert.equal(after.find(b=>b.condition==='Сток')?.actual,0);
	const history=await readConditionHistory(f.erp,5110);
	assert.equal(history[0]?.actor,'Иван #7');assert.equal(history[0]?.qty,1);assert.equal(history[0]?.submitted,true);
});
test('supports reverse change and state-to-state change without changing total',async()=>{
	const f=fake();await changeStockCondition(f.erp,input({qty:2}),'actor',allow);
	await changeStockCondition(f.erp,input({from:'Сток',to:'После ремонта'}),'actor',allow);
	await changeStockCondition(f.erp,input({from:'После ремонта',to:'Обычный'}),'actor',allow);
	const balances=await readConditionBalances(f.erp,5110);
	assert.equal(balances.find(b=>b.condition==='Обычный')?.actual,9);assert.equal(balances.find(b=>b.condition==='Сток')?.actual,1);assert.equal(balances.reduce((s,b)=>s+b.actual,0),10);
});
test('rejects overdraw, fractions for pieces, invalid status, zero and non-finite quantities',async()=>{
	for(const qty of [0,-1,NaN,Infinity])assert.throws(()=>validateConditionChange(input({qty})));
	assert.throws(()=>validateConditionChange(input({from:'Сток',to:'Сток'})));
	for(const qty of [11,0.5]){const f=fake();await assert.rejects(changeStockCondition(f.erp,input({qty}),'actor',allow));assert.equal(f.table('Stock Entry').size,0);}
});
test('preserves Bin reservations and draft delivery quantities',async()=>{
	const f=fake();f.table('Bin').get('original')!['reserved_qty']=8;
	f.put('Delivery Note Item',{name:'draft-row',item_code:'5110',warehouse:'Склад - УД',qty:1,docstatus:0});
	assert.equal((await readConditionBalances(f.erp,5110))[0]?.available,1);
	await assert.rejects(changeStockCondition(f.erp,input({qty:2}),'actor',allow),/свободно 1/);
	await assert.rejects(changeStockCondition(f.erp,input(),'actor',async()=>{throw Error('transfer reserved');}),/transfer reserved/);
	assert.equal(f.table('Stock Entry').size,0);
});
test('retries same operation after committed response loss without a second transfer',async()=>{
	const f=fake(),request=input();f.loseResponse();
	const first=await changeStockCondition(f.erp,request,'actor',allow);
	const again=await changeStockCondition(f.erp,request,'actor',allow);
	assert.equal(first.name,again.name);assert.equal(f.table('Stock Entry').size,1);
	assert.equal(f.table('Bin').get('original')!['actual_qty'],9);
	await assert.rejects(changeStockCondition(f.erp,{...request,qty:2},'actor',allow),/других данных/);
});
test('refuses disabled, service, serialized, batch and negative-stock configurations',async()=>{
	for(const [field,value] of [['disabled',1],['is_stock_item',0],['has_serial_no',1],['has_batch_no',1],['allow_negative_stock',1]] as const){const f=fake();f.table('Item').get('5110')![field]=value;await assert.rejects(changeStockCondition(f.erp,input(),'actor',allow));assert.equal(f.table('Stock Entry').size,0);}
	const f=fake();f.table('Stock Settings').get('Stock Settings')!['allow_negative_stock']=1;await assert.rejects(changeStockCondition(f.erp,input(),'actor',allow));
});
test('condition locations retain physical store identity without nested conditions',()=>{
	assert.deepEqual(splitConditionStore(conditionStoreTitle('Склад','После ремонта')),{store:'Склад',condition:'После ремонта'});
	assert.throws(()=>conditionStoreTitle(conditionStoreTitle('Склад','Сток'),'Б/у'));
	assert.equal(stockChoiceLabel('Склад',9),'Обычный — 9 шт. · Склад');
});
test('hydrates name-only Frappe child rows before counting reserved quantity',async()=>{
	const erp={list:async()=>[{name:'child'}],get:async()=>({name:'child',item_code:'5110',warehouse:'Склад - УД',qty:9,docstatus:0})} as unknown as ErpClient;
	const rows=await readDraftDeliveryReservations(erp,[5110]);assert.equal(rows[0]?.['qty'],9);
	const broken={list:async()=>[{name:'child'}],get:async()=>null} as unknown as ErpClient;
	await assert.rejects(readDraftDeliveryReservations(broken,[5110]),/Не удалось проверить/);
});
test('physical transfer through transit preserves stock condition at destination',async()=>{
	const f=fake();
	for(const title of ['Goods In Transit','Второй склад'])f.put('Warehouse',{name:`${title} - УД`,company:'Умный дом',is_group:0,disabled:0,warehouse_type:title==='Goods In Transit'?'Transit':'',parent_warehouse:'All Warehouses - УД'});
	await changeStockCondition(f.erp,input(),'actor',allow);
	const fromStore=conditionStoreTitle('Склад','Сток');
	await shipTransferToTransit(f.erp,{lines:[{productId:5110,qty:1,fromStore}]});
	await completeTransferFromTransit(f.erp,{shippedLines:[{productId:5110,qty:1}],finalLines:[{productId:5110,qty:1}],fromStore,toStore:'Второй склад'});
	const balances=await readConditionBalances(f.erp,5110);
	assert.equal(balances.find(b=>b.store==='Второй склад'&&b.condition==='Сток')?.actual,1);
	assert.equal(balances.find(b=>b.store==='Склад'&&b.condition==='Обычный')?.actual,9);
	assert.equal(balances.some(b=>b.store==='Goods In Transit'),false);
});
