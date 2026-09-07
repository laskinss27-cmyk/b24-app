import assert from 'node:assert/strict';
import test from 'node:test';
Object.defineProperty(globalThis,'window',{configurable:true,value:{__B24_CONTEXT__:{domain:'test.example',accessToken:'test-token'}}});
const {fetchStockConditions}=await import('./stock-conditions.js');
const {createQuickSale}=await import('./deal-product-actions.js');
test('condition request retains exact operation id, state and quantity',async()=>{
	let body:Record<string,unknown>={};
	globalThis.fetch=(async(_input,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({ok:true,canManage:true,balances:[],history:[],document:'STE-1'}),{status:200});}) as typeof fetch;
	await fetchStockConditions(5110,{productId:5110,store:'Склад',from:'Обычный',to:'Сток',qty:1,comment:'Проверка',operationId:'abc'});
	assert.equal(body['operationId'],'abc');assert.equal(body['qty'],1);assert.equal(body['to'],'Сток');assert.equal(body['action'],'change');
});
test('known rejection allows editing, uncertain network error does not',async()=>{
	globalThis.fetch=(async()=>new Response(JSON.stringify({ok:false,error:'Недостаточно',safeToEdit:true}),{status:400})) as typeof fetch;
	await assert.rejects(fetchStockConditions(5110),(error:Error&{safeToEdit?:boolean})=>error.safeToEdit===true);
	globalThis.fetch=(async()=>{throw new Error('Network lost');}) as typeof fetch;
	await assert.rejects(fetchStockConditions(5110),(error:Error&{safeToEdit?:boolean})=>error.safeToEdit!==true);
});
test('quick sale sends selected stock condition, and partial failures carry existing deal id',async()=>{
	let body:Record<string,unknown>={};
	globalThis.fetch=(async(_input,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({ok:false,partial:true,dealId:77,error:'ERP unavailable'}));}) as typeof fetch;
	await assert.rejects(createQuickSale([{productId:5110,name:'Монитор',quantity:1,price:100,stockTitle:'Склад · Состояние: Сток'}]),(error:Error&{createdDealId?:number})=>error.createdDealId===77);
	assert.equal((body['items'] as Array<Record<string,unknown>>)[0]?.['stockTitle'],'Склад · Состояние: Сток');
});
