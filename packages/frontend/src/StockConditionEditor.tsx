import {useEffect,useState} from 'react';
import {STOCK_CONDITIONS,type StockCondition,type StockConditionChange} from '@b24-app/shared';
import {fetchStockConditions,type ConditionResult} from './stock-conditions.js';

export function StockConditionEditor({productId,onChanged,readOnly=false}:{productId:number;onChanged:()=>Promise<void>;readOnly?:boolean}):JSX.Element{
	const pendingKey=`stock-condition-pending:${productId}`;
	const [data,setData]=useState<ConditionResult|null>(null);
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');
	const [busy,setBusy]=useState(false);
	const [editing,setEditing]=useState(false);
	const [store,setStore]=useState('');
	const [from,setFrom]=useState<StockCondition>('Обычный');
	const [to,setTo]=useState<StockCondition>('Сток');
	const [qty,setQty]=useState('1');
	const [comment,setComment]=useState('');
	// Retain the exact request after an uncertain network result; retry cannot move twice.
	const [pending,setPending]=useState<StockConditionChange|null>(()=>{try{return JSON.parse(sessionStorage.getItem(pendingKey)??'null') as StockConditionChange|null;}catch{return null;}});
	useEffect(()=>{if(!pending)return;setEditing(true);setStore(pending.store);setFrom(pending.from);setTo(pending.to);setQty(String(pending.qty));setComment(pending.comment);},[]);
	useEffect(()=>{let disposed=false;fetchStockConditions(productId).then(result=>{if(!disposed){setData(result);if(!pending)setStore(result.balances.find(x=>x.actual>0)?.store??result.balances[0]?.store??'');}}).catch(reason=>{if(!disposed)setError(String(reason.message??reason));});return()=>{disposed=true;};},[productId]);
	const stores=[...new Set(data?.balances.map(b=>b.store)??[])];
	const available=data?.balances.find(b=>b.store===store&&b.condition===from)?.available??0;
	async function save():Promise<void>{
		const amount=Number(qty.replace(',','.'));
		if(!pending&&(!Number.isFinite(amount)||amount<=0||amount>available||from===to)){setError('Проверьте количество и состояния. Нельзя перевести больше свободного остатка.');return;}
		const request=pending??{productId,store,from,to,qty:amount,comment,operationId:crypto.randomUUID()};
		try{sessionStorage.setItem(pendingKey,JSON.stringify(request));}catch{setError('Для безопасного повтора нужен доступ к хранилищу вкладки браузера. Операция не отправлена.');return;}
		setPending(request);setBusy(true);setError('');setNotice('');
		try{const result=await fetchStockConditions(productId,request);setData(result);sessionStorage.removeItem(pendingKey);setPending(null);setEditing(false);setNotice(`Сохранено: ${request.qty} шт., ${request.from} → ${request.to}. Документ ${result.document}.`);try{await onChanged();}catch{setNotice(current=>`${current} Обновите каталог для свежего общего остатка.`);}}
		catch(reason){const safe=(reason as {safeToEdit?:boolean})?.safeToEdit===true;if(safe){sessionStorage.removeItem(pendingKey);setPending(null);}setError(`${String(reason instanceof Error?reason.message:reason)}${safe?'':'. Повторная отправка проверит ту же операцию, без повторного перемещения.'}`);}
		finally{setBusy(false);}
	}
	return <section className="stock-condition-panel">
		<h3>Остаток по состояниям</h3>
		<p className="muted">Состояние относится к указанному количеству. Общий остаток товара не меняется.</p>
		<p className="muted">Старые метки карточки не распределяются автоматически. Здесь укажите фактическое количество; черновики реализаций и резервы учитываются при проверке.</p>
		{!data&&!error&&<p>Загрузка…</p>}
		{data&&<table><thead><tr><th>Склад</th><th>Состояние</th><th>В наличии</th><th>Свободно в ядре</th></tr></thead><tbody>{data.balances.filter(b=>b.actual!==0).map(b=><tr key={b.stockTitle}><td>{b.store}</td><td>{b.condition}</td><td>{b.actual}</td><td>{b.available}</td></tr>)}</tbody></table>}
		{data?.canManage&&!readOnly&&!editing&&<button type="button" className="btn-secondary" onClick={()=>setEditing(true)}>Изменить состояние части остатка</button>}
		{editing&&<div className="catalog-product-form">
			<label>Склад<select value={store} disabled={busy||Boolean(pending)} onChange={e=>setStore(e.target.value)}>{stores.map(s=><option key={s}>{s}</option>)}</select></label>
			<label>Из состояния<select value={from} disabled={busy||Boolean(pending)} onChange={e=>setFrom(e.target.value as StockCondition)}>{STOCK_CONDITIONS.map(s=><option key={s}>{s}</option>)}</select></label>
			<label>В состояние<select value={to} disabled={busy||Boolean(pending)} onChange={e=>setTo(e.target.value as StockCondition)}>{STOCK_CONDITIONS.filter(s=>s!==from).map(s=><option key={s}>{s}</option>)}</select></label>
			<label>Количество (свободно до {available})<input inputMode="decimal" value={qty} disabled={busy||Boolean(pending)} onChange={e=>setQty(e.target.value)}/></label>
			<label className="wide">Комментарий<textarea maxLength={1000} value={comment} disabled={busy||Boolean(pending)} onChange={e=>setComment(e.target.value)}/></label>
			<button type="button" className="btn-primary" disabled={busy} onClick={()=>void save()}>{busy?'Сохраняю…':pending?'Повторить проверку операции':'Применить'}</button>
			{!pending&&<button type="button" className="btn-secondary" disabled={busy} onClick={()=>setEditing(false)}>Отмена</button>}
		</div>}
		{error&&<p role="alert" className="cart-err">{error}</p>}{notice&&<p role="status">{notice}</p>}
		{Boolean(data?.history.length)&&<details><summary>История изменений состояния</summary><ul>{data!.history.map(h=><li key={h.document}>{h.at} · {h.actor} · {h.qty} шт.: {h.from} → {h.to} · {h.store}. {h.comment} ({h.document}{h.submitted?'':', черновик — не проведён'})</li>)}</ul></details>}
	</section>;
}
