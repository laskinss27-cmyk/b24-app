import type {FastifyInstance} from 'fastify';
import type {StockConditionChange} from '@b24-app/shared';
import {ErpClient} from '../erp/client.js';
import {changeStockCondition,readConditionBalances,readConditionHistory,validateConditionChange} from '../erp/stock-conditions.js';
import {catalogClientFrom,errInfo} from './api-catalog-route-helpers.js';
import {canManageStock} from './api-stock-access.js';
import {validateFreeStock} from './api-stock-availability.js';
import {appPermission} from '../access-policy.js';
import {invalidateCatalogCache} from './api-catalog-cache.js';

export function registerStockConditionRoutes(app:FastifyInstance):void {
	app.post('/api/stock/conditions',async(req,reply)=>{
		const body=(req.body??{}) as Record<string,unknown> & {domain?:string;accessToken?:string};
		const client=catalogClientFrom(app,body);
		if(!client)return reply.code(403).send({ok:false,error:'bad auth / domain'});
		const erp=ErpClient.fromEnv();
		if(!erp)return reply.code(503).send({ok:false,error:'Ядро склада недоступно'});
		let attemptedOperation='';
		try{
			const me=await client.call<{ID?:string;NAME?:string;LAST_NAME?:string}>('user.current',{});
			if(!me?.ID)return reply.code(403).send({ok:false,error:'Не удалось подтвердить пользователя'});
			const productId=Number(body['productId']);
			if(!Number.isSafeInteger(productId)||productId<=0)return reply.code(400).send({ok:false,error:'Неверный товар'});
			const legacyManage=await canManageStock(client);
			const canManage=appPermission(req,'transfers.create',legacyManage)&&appPermission(req,'transfers.post',legacyManage);
			if(body['action']!=='read'&&body['action']!=='change')return reply.code(400).send({ok:false,error:'Неверная операция'});
			let document:string|undefined;
			if(body['action']==='change'){
				if(!canManage)return reply.code(403).send({ok:false,error:'Нет права изменять складской остаток'});
				const input={productId,store:String(body['store']??'').trim(),from:body['from'],to:body['to'],qty:Number(body['qty']),comment:String(body['comment']??'').trim(),operationId:String(body['operationId']??'')} as StockConditionChange;
				validateConditionChange(input);
				attemptedOperation=input.operationId;
				const result=await changeStockCondition(erp,input,`${me.LAST_NAME??''} ${me.NAME??''} (#${me.ID})`.trim(),
					async(fromStore,qty)=>validateFreeStock(client,erp,[{productId,qty,fromStore}], [], app.reservationRuntime));
				document=result.name;
				invalidateCatalogCache(body.domain??'');
			}
			const [balances,history]=await Promise.all([readConditionBalances(erp,productId),readConditionHistory(erp,productId)]);
			return {ok:true,canManage,balances,history,...(document?{document}:{})};
		}catch(error){
			let safeToEdit=!attemptedOperation;
			if(attemptedOperation)try{
				const field=await erp.get('Custom Field','Stock Entry-b24_condition_operation');
				safeToEdit=!field||!(await erp.list('Stock Entry',['name'],[['b24_condition_operation','=',attemptedOperation]],1)).length;
			}catch{/* An uncertain result must keep the original operation id. */}
			return reply.code(400).send({ok:false,error:errInfo(error),safeToEdit});
		}
	});
}
