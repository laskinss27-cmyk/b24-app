import type {StockConditionBalance,StockConditionChange,StockConditionHistory} from '@b24-app/shared';
import {bx24Auth} from './bitrix-auth.js';
export interface ConditionResult {canManage:boolean;balances:StockConditionBalance[];history:StockConditionHistory[];document?:string}
export async function fetchStockConditions(productId:number,change?:StockConditionChange):Promise<ConditionResult>{
	const response=await fetch('/api/stock/conditions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...bx24Auth(),productId,action:change?'change':'read',...change})});
	const result=await response.json() as ConditionResult & {ok:boolean;error?:string;safeToEdit?:boolean};
	if(!response.ok||!result.ok)throw Object.assign(new Error(result.error??'Не удалось получить состояния остатка'),{safeToEdit:result.safeToEdit===true});
	return result;
}
