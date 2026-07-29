import type { FastifyInstance } from 'fastify';
import type { AccessPermissionId } from '@b24-app/shared';
import { hasAppPermissions, type AccessAuthBody } from './access-policy.js';

const ROUTE_PERMISSIONS: Readonly<Record<string, readonly AccessPermissionId[]>> = {
	'/api/catalog/stores': ['catalog.view'],
	'/api/catalog/browse': ['catalog.view', 'catalog.search'],
	'/api/catalog/export-comparison': ['catalog.export_comparison'],
	'/api/catalog/update-prices': ['catalog.edit_retail_prices', 'catalog.edit_purchase_prices'],
	'/api/catalog/update-product': [
		'catalog.edit_card',
		'catalog.edit_descriptions',
		'catalog.edit_retail_prices',
		'catalog.edit_purchase_prices',
	],
	'/api/catalog/create-product': ['catalog.create'],
	'/api/catalog/erp-stocks': ['catalog.view_all_stores'],

	'/api/deal/fulfillment-setup': ['deals.view'],
	'/api/deal/realize-core': ['realizations.create', 'realizations.post'],
	'/api/deal/search-products': ['deals.view', 'catalog.search'],
	'/api/deal/add-products': ['deals.add_products'],
	'/api/deal/remove-product': ['deals.remove_products'],
	'/api/deal/update-product': ['deals.edit_quantity', 'deals.edit_prices', 'deals.apply_discount'],
	'/api/deal/collapse-service': ['deals.edit_quantity'],
	'/api/deal/plan': ['deals.view'],
	'/api/deal/stages': ['deals.view'],
	'/api/deal/stage-rename': ['deals.edit_quantity'],
	'/api/deal/variants': ['deals.view'],
	'/api/deal/variant-create': ['deals.edit_quantity'],
	'/api/deal/variant-rename': ['deals.edit_quantity'],
	'/api/deal/variant-delete': ['deals.edit_quantity'],
	'/api/deal/variant-select': ['deals.edit_quantity'],
	'/api/deal/variant-selection-cancel': ['deals.edit_quantity'],
	'/api/deal/stage-item-update': ['deals.edit_quantity'],
	'/api/deal/stage-item-remove': ['deals.remove_products'],
	'/api/deal/plan-set': ['deals.edit_quantity'],
	'/api/deal/export-xlsx': ['deals.export_xlsx'],
	'/api/deal/kp': ['deals.create_quote'],
	'/api/deal/kp-docx': ['deals.create_quote'],
	'/api/deal/kp-xlsx': ['deals.create_quote'],
	'/api/deal/shipped': ['realizations.post'],
	'/api/deal/supply-request': ['deals.create_supply_request'],
	'/api/deal/realize': ['realizations.create', 'realizations.post'],
	'/api/deal/add-product': ['deals.add_products'],

	'/api/realizations/list': ['realizations.view'],
	'/api/quicksale/create': ['realizations.create'],
	'/api/contracts/context': ['deals.view'],
	'/api/contracts/generate': ['deals.create_contract'],
	'/api/reports/sales': ['reports.sales'],

	'/api/stock/movements': ['stock.view_movements'],
	'/api/stock/doc': ['stock.view'],
	'/api/stock/item-history': ['stock.view_movements'],
	'/api/stock/turnover-report': ['reports.stock_movements'],
	'/api/stock/turnover-report.xlsx': ['reports.stock_movements', 'reports.export'],
	'/api/stock/form-data': ['stock.view'],
	'/api/stock/search-items': ['stock.view'],
	'/api/stock/create-product': ['stock.create_product'],

	'/api/transfer-requests/create': ['transfers.create_request'],
	'/api/transfer-requests/create-supply': ['deals.create_supply_request'],
	'/api/transfer-requests/list': ['transfers.view_own'],
	'/api/transfer-requests/cancel': ['transfers.cancel_own_request'],
	'/api/transfer-requests/convert': ['transfers.manage_requests', 'transfers.create'],
	'/api/transfers/create': ['transfers.create'],
	'/api/transfers/create-manual': ['transfers.create'],
	'/api/transfers/list': ['transfers.view_own'],
	'/api/transfers/update-destination': ['transfers.edit_destination'],
	'/api/transfers/update-lines': ['transfers.edit_quantity'],
	'/api/transfers/collect': ['transfers.collect'],
	'/api/transfers/ship': ['transfers.ship'],
	'/api/transfers/receive': ['transfers.receive'],
	'/api/transfers/post': ['transfers.post'],
	'/api/transfers/resolve-shortage': ['transfers.resolve_shortage'],
	'/api/transfers/cancel': ['transfers.cancel'],
	'/api/transfers/delete': ['transfers.delete'],

	'/api/supply/orders': ['supply.view', 'supply.view_all_requests'],
	'/api/supply/request': ['deals.create_supply_request'],
	'/api/supply/request-note': ['supply.edit_request_note'],
	'/api/supply/create-documents': ['supply.manage_requests'],
	'/api/supply/suppliers': ['supply.view'],
	'/api/supply/supplier/create': ['supply.create_supplier'],
	'/api/supply/purchase-order': ['supply.create_purchase'],
	'/api/supply/purchase-order/standalone': ['supply.create_purchase'],
	'/api/supply/purchase-order/update': ['supply.edit_purchase'],
	'/api/supply/purchase-order/delete': ['supply.delete_documents'],
	'/api/supply/purchase-stage': ['supply.change_purchase_stage'],
	'/api/supply/purchase-receive': ['supply.receive_purchase'],
	'/api/supply/purchase-transfer': ['supply.receive_purchase', 'transfers.create'],

	'/api/repairs/list': ['repairs.view'],
	'/api/repairs/create': ['repairs.create'],
	'/api/repairs/store-stock': ['repairs.view'],
	'/api/repairs/create-presale': ['repairs.edit'],
	'/api/repairs/update': ['repairs.edit'],
	'/api/repairs/update-internal-comment': ['repairs.edit_internal_comment'],
	'/api/repairs/set-pay': ['repairs.edit_prices'],
	'/api/repairs/request-price-approval': ['repairs.request_price_approval'],
	'/api/repairs/delete': ['repairs.delete'],
	'/api/repairs/update-status': ['repairs.change_status'],
	'/api/repairs/set-issue-store': ['repairs.change_issue_store'],
	'/api/repairs/find-by-phone': ['repairs.view'],
	'/api/repairs/search-contacts': ['repairs.view'],
	'/api/repairs/file-link': ['repairs.view'],
	'/api/repairs/upload-photo': ['repairs.edit'],

	'/api/marketplaces/form-data': ['marketplaces.view'],
	'/api/marketplaces/list': ['marketplaces.view'],
	'/api/marketplaces/return-options': ['marketplaces.view'],
	'/api/marketplaces/sale': ['marketplaces.create_sale', 'marketplaces.post_sale'],
	'/api/marketplaces/return': ['marketplaces.create_return', 'marketplaces.post_return'],
	'/api/marketplaces/bundle': ['marketplaces.create_bundle'],

	'/api/inventory/list': ['inventory.view'],
	'/api/inventory/stock': ['inventory.view'],
	'/api/inventory/search-products': ['inventory.view'],
	'/api/inventory/create': ['inventory.create'],
	'/api/inventory/update': ['inventory.count'],
	'/api/inventory/build-documents': ['inventory.post'],
	'/api/inventory/erp-doc-preview': ['inventory.manage'],
	'/api/inventory/erp-doc-save': ['inventory.manage'],
	'/api/inventory/erp-doc-submit': ['inventory.post'],
	'/api/inventory/delete': ['inventory.delete'],
};

function permissionsFor(route: string, body: Record<string, unknown>): readonly AccessPermissionId[] {
	if (route === '/api/stock/create') {
		return body['kind'] === 'receipt' ? ['stock.create_receipt'] : ['stock.create_issue'];
	}
	if (route === '/api/stock/submit') return ['stock.post_documents'];
	return ROUTE_PERMISSIONS[route] ?? [];
}

export function registerAccessPolicyHook(app: FastifyInstance): void {
	app.decorateRequest('appAccess', null);
	app.addHook('preHandler', async (req, reply) => {
		const route = String(req.routeOptions.url ?? '');
		if (!route.startsWith('/api/') || route.startsWith('/api/access-control/')) return;
		const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
		const permissionIds = permissionsFor(route, body);
		if (!permissionIds.length) return;
		const domain = typeof body['domain'] === 'string' ? body['domain'] : '';
		const accessToken = typeof body['accessToken'] === 'string' ? body['accessToken'] : '';
		// Отсутствующую/битую авторизацию по-прежнему обрабатывает сам маршрут.
		if (!domain || !accessToken) return;
		const auth: AccessAuthBody = { domain, accessToken };
		try {
			const result = await hasAppPermissions(app, auth, permissionIds);
			req.appAccess = result.access;
			if (result.allowed) return;
			app.log.warn({
				userId: result.access?.user.id,
				route,
				denied: result.denied,
			}, '[access-policy] request denied');
			return reply.code(403).send({
				ok: false,
				error: 'Действие запрещено настройками доступа приложения.',
				deniedPermissions: result.denied,
			});
		} catch (error) {
			// Битрикс иногда кратковременно не отвечает. Новая модель не должна положить
			// рабочее приложение: старые проверки маршрута продолжат действовать.
			app.log.error({ route, error: String(error) }, '[access-policy] check failed; legacy access preserved');
		}
	});
}
