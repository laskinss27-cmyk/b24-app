import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m:string,p:Record<string,unknown>={},tries=4):Promise<T>{let last:any;for(let i=0;i<tries;i++){try{return await client.call<T>(m,p)}catch(e){last=e;if(String(e).includes('fetch failed')){await new Promise(r=>setTimeout(r,1500));continue;}throw e;}}throw last;}
const PID=17130, STORE=8, QTY=1, PRICE=45, USER=1858;
async function allStocks():Promise<Record<number,number>>{const r:any=await call('catalog.storeproduct.list',{filter:{productId:PID},select:['storeId','amount']});const m:Record<number,number>={};(r?.storeProducts||[]).forEach((s:any)=>m[Number(s.storeId)]=Number(s.amount));return m;}
function diff(a:Record<number,number>,b:Record<number,number>){const out:string[]=[];for(const k of new Set([...Object.keys(a),...Object.keys(b)])){const k2=Number(k);if((a[k2]??0)!==(b[k2]??0))out.push('склад '+k2+': '+(a[k2]??0)+'→'+(b[k2]??0));}return out.length?out.join(', '):'(без изменений)';}
(async()=>{
  let orderId=0, shipmentId=0, deducted=false, delId=6;
  const before=await allStocks(); console.log('ОСТАТКИ до: '+JSON.stringify(before));
  try{
    const o:any=await call('sale.order.add',{fields:{lid:'s1',personTypeId:6,currency:'RUB',userId:USER}}); orderId=Number(o?.order?.id??o?.id); console.log('заказ '+orderId);
    const b:any=await call('sale.basketitem.add',{fields:{orderId,productId:PID,quantity:QTY,price:PRICE,currency:'RUB'}}); const basketId=Number(b?.basketItem?.id??b?.id); console.log('корзина '+basketId);
    const s:any=await call('sale.shipment.add',{fields:{orderId,deliveryId:delId,responsibleId:USER,allowDelivery:'N',deducted:'N'}}); shipmentId=Number(s?.shipment?.id??s?.id); console.log('отгрузка '+shipmentId);
    const si:any=await call('sale.shipmentitem.add',{fields:{orderDeliveryId:shipmentId,basketId,quantity:QTY}}); const siId=Number(si?.shipmentItem?.id??si?.id); console.log('позиция отгрузки '+siId);
    console.log('ПРОВОЖУ (allowDelivery=Y, deducted=Y)…');
    await call('sale.shipment.update',{id:shipmentId,fields:{deliveryId:delId,allowDelivery:'Y',deducted:'Y'}}); deducted=true;
    const after=await allStocks(); console.log('ОСТАТКИ после: '+JSON.stringify(after));
    console.log('ИЗМЕНЕНИЕ: '+diff(before,after));
    console.log('склад '+STORE+': было '+before[STORE]+', стало '+after[STORE]);
    console.log('СВЯЗКА: сделка 36694 ↔ заказ '+orderId+' / отгрузка '+shipmentId);
  }catch(e){console.log('⛔ ОШИБКА: '+(e instanceof B24ApiError?e.code+':'+(e.description??''):e));}
  finally{
    console.log('\n=== ОТКАТ ===');
    if(deducted){try{await call('sale.shipment.update',{id:shipmentId,fields:{deliveryId:delId,allowDelivery:'Y',deducted:'N'}});console.log('снято проведение');}catch(e){console.log('⚠ не снял: '+e);}}
    if(shipmentId){try{await call('sale.shipment.delete',{id:shipmentId});console.log('удалена отгрузка');}catch(e){console.log('⚠ отгрузка: '+e);}}
    if(orderId){try{await call('sale.order.delete',{id:orderId});console.log('удалён заказ');}catch(e){console.log('⚠ заказ: '+e);}}
    const fin=await allStocks(); console.log('ОСТАТКИ итог: склад '+STORE+'='+fin[STORE]+(fin[STORE]===before[STORE]?' ✅ как было':' ❗расхождение!')+' | дельта по всем: '+diff(before,fin));
  }
})().catch(e=>console.error('FATAL',e));
