import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { syncDealFulfillmentStatus } from '../deal-fulfillment.js';
import { syncDealServiceSum } from '../deal-service-sum.js';
import { registerDealCoreRealizationRoute } from './deal-core-realization-route.js';
import { registerDealCommercialProposalFileRoutes } from './deal-commercial-proposal-file-routes.js';
import { registerDealCommercialProposalRoute } from './deal-commercial-proposal-route.js';
import { registerDealBitrixRealizationRoute } from './deal-bitrix-realization-route.js';
import { registerDealPlanExportRoute } from './deal-plan-export-route.js';
import { registerDealLegacyProductRoute } from './deal-legacy-product-route.js';
import { registerDealPlanProductReplacementRoute } from './deal-plan-product-replacement-route.js';
import { registerDealPlanRoute } from './deal-plan-route.js';
import { registerDealPlanUpdateRoute } from './deal-plan-update-route.js';
import { registerDealProductManagementRoutes } from './deal-product-management-routes.js';
import { registerDealProductSearchRoute } from './deal-product-search-route.js';
import { registerDealQuoteVariantRoutes } from './deal-quote-variant-routes.js';
import { registerDealStageRoutes } from './deal-stage-routes.js';
import { registerDealSupplyRoutes } from './deal-supply-routes.js';
import { registerDealTechnicalFieldsRoute } from './deal-technical-fields-route.js';

/**
 * API вкладки сделки — «Добавить товар» (пункт 2) и «Реализовать» (черновик реализации).
 *  - /api/deal/search-products — поиск товара по названию (iblock 24+26) + розничная цена (BASE).
 *  - /api/deal/add-product — добавить ОДНУ товарную строку в сделку (crm.item.productrow.add,
 *    ownerType='D'); существующие строки НЕ трогаются (не set-all). Проверено net-zero.
 *  - /api/deal/realize — ЧЕРНОВИК-ПАРТИЯ реализации по отмеченным строкам сделки (цикл пробит
 *    2026-06-11, партии — по нативной модели «один заказ → много отгрузок», как #558/2,/3,/4):
 *    storeId в crm-строки → заказ сделки ПЕРЕИСПОЛЬЗУЕМ (crm.orderentity.list по ownerId), если
 *    нет — sale.order.add + снос свежего дубль-сделки/контакта + crm.orderentity.add → корзина
 *    с xmlId=crm_pr_<rowId> и ПОЛНЫМ кол-вом строки → sale.shipment.add черновиком с ЧАСТИЧНЫМ
 *    кол-вом партии (deducted=N — СКЛАД НЕ ДВИГАЕМ). Проводит менеджер в нативном UI.
 *  - /api/deal/shipped — что уже отгружено по строкам сделки (по партиям заказа сделки)
 *    + заявки снабжения сделки (смарт-процесс «Снабжение» 1110).
 *  - /api/deal/supply-request — товар «нет на складах» → в снабжение: дополняет перечень
 *    существующей заявки сделки или создаёт карточку 1110 «Поставка № N_<сделка>_<название>»
 *    с ТОЧНЫМ перечнем (имя × кол-во) — лучше родного робота, который перечень не заполняет.
 *    Робот на дубль не пойдёт: ставим на сделке галку «Заявка снабжения создана».
 *
 * ЗАПИСЬ в сделку, но безопасная и обратимая (менеджер удалит строку в карточке).
 * Токен — самого юзера (права Битрикса соблюдаются). Домен — allowlist. За канарейкой (фронт).
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}


export function registerApiDealRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};
	const syncDealTechnicalFields = async (client: B24Client, erp: ErpClient, dealId: number): Promise<void> => {
		try {
			const result = await syncDealFulfillmentStatus(client, erp, dealId);
			app.log.info({ dealId, ...result }, '[deal-fulfillment] synchronized');
		} catch (err) {
			app.log.error({ dealId }, `[deal-fulfillment] synchronization failed — ${errInfo(err)}`);
		}
		try {
			const result = await syncDealServiceSum(client, erp, dealId);
			app.log.info({ dealId, ...result }, '[deal-service-sum] synchronized');
		} catch (err) {
			app.log.error({ dealId }, `[deal-service-sum] synchronization failed — ${errInfo(err)}`);
		}
	};

	registerDealTechnicalFieldsRoute(app, clientFrom);

	registerDealCoreRealizationRoute(app, clientFrom, syncDealTechnicalFields);

	registerDealProductSearchRoute(app, clientFrom);

	registerDealProductManagementRoutes(app, clientFrom, syncDealTechnicalFields);

	registerDealPlanRoute(app, clientFrom);

	registerDealStageRoutes(app, clientFrom, syncDealTechnicalFields);

	registerDealQuoteVariantRoutes(app, clientFrom, syncDealTechnicalFields);

	registerDealPlanUpdateRoute(app, clientFrom, syncDealTechnicalFields);

	registerDealPlanExportRoute(app, clientFrom);

	registerDealPlanProductReplacementRoute(app, clientFrom, syncDealTechnicalFields);

	registerDealCommercialProposalRoute(app, clientFrom);
	registerDealCommercialProposalFileRoutes(app, clientFrom);

	registerDealSupplyRoutes(app, clientFrom);

	registerDealBitrixRealizationRoute(app, clientFrom);

	registerDealLegacyProductRoute(app, clientFrom);
}
