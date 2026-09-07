// Local-only UI fixture. Not imported by the application or included in its production entry.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {StockConditionEditor} from './StockConditionEditor.js';
import {QuickSaleCartModal} from './QuickSaleCartModal.js';
import {conditionStoreTitle,type StockConditionBalance,type StockConditionChange} from '@b24-app/shared';
import type {BaseRow} from './product-catalog.js';
import './catalog-product-card.css';
import './product-catalog.css';
import './global.css';
import './inventory.css';
import './quick-sale.css';
import './catalog-modal-overlays.css';
window.__B24_CONTEXT__={domain:'local-fixture.invalid',accessToken:'fixture',dealId:null,memberId:null};
let balances:StockConditionBalance[]=[{store:'Тестовый склад',condition:'Обычный',stockTitle:'Тестовый склад',actual:10,reserved:0,available:10}];
const history:unknown[]=[];
window.fetch=(async(url,init)=>{
	if(String(url)!=='/api/stock/conditions')throw Error('Fixture blocks external requests');
	const input=JSON.parse(String(init?.body??'{}')) as StockConditionChange&{action:string};
	if(input.action==='change'&&!history.some(h=>(h as StockConditionChange).operationId===input.operationId)){
		const source=balances.find(b=>b.condition===input.from)!;
		if(source.available<input.qty)return new Response(JSON.stringify({ok:false,error:'Недостаточно остатка',safeToEdit:true}),{status:400});
		source.actual-=input.qty;source.available-=input.qty;
		let target=balances.find(b=>b.condition===input.to);
		if(!target){target={store:input.store,condition:input.to,stockTitle:conditionStoreTitle(input.store,input.to),actual:0,reserved:0,available:0};balances.push(target);}
		target.actual+=input.qty;target.available+=input.qty;
		history.push({...input,actor:'Тестовый сотрудник',at:'07.09.2026 10:00',document:'TEST-1',submitted:true});
	}
	return new Response(JSON.stringify({ok:true,canManage:true,balances,history,document:'TEST-1'}));
}) as typeof fetch;
function Preview(){const [revision,setRevision]=useState(0);const [cart,setCart]=useState(false);const [selected,setSelected]=useState<Record<number,string>>({});
	const row:BaseRow={id:5110,iblockId:24,name:'Монитор CTV-5110',isService:false,retail:10000,purchase:8000,total:balances.reduce((s,b)=>s+b.actual,0),stockByStore:Object.fromEntries(balances.map((b,i)=>[i+1,b.actual]))};
	return <div style={{maxWidth:1000,margin:'30px auto',padding:24,fontFamily:'Arial',background:'white'}}><h1>Тестовые данные: 5110</h1><p>Никакие рабочие остатки не меняются. Обновление: {revision}</p><StockConditionEditor productId={5110} onChanged={async()=>setRevision(r=>r+1)}/><button onClick={()=>setCart(true)}>Проверить выбор при продаже</button>{cart&&<QuickSaleCartModal items={[{row,qty:1}]} stores={balances.map((b,i)=>({id:i+1,title:b.stockTitle,active:true}))} selectedStores={selected} onStoreChange={(id,title)=>setSelected({...selected,[id]:title})} discountPercent={()=>0} lineFinal={()=>10000} cartSum={10000} cartFinal={10000} cartSaved={0} error={null} creatingSale={false} onQuantityChange={()=>{}} onDiscountChange={()=>{}} onClear={()=>{}} onClose={()=>setCart(false)} onCreate={async()=>setCart(false)}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
