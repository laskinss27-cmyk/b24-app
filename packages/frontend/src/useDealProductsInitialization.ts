import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { call, setupDealFulfillment } from './b24.js';
import type { B24Context } from './b24-context.js';
import { loadDealProductsData } from './deal-products-data-loader.js';
import { DEAL_PRODUCTS_MOCK_DATA, dealProductsMockVariantData } from './deal-products-mock-data.js';
import type { TableData } from './deal-products-table-types.js';

export type DealProductsState =
	| { phase: 'init' }
	| { phase: 'loading' }
	| { phase: 'error'; message: string }
	| { phase: 'ready'; data: TableData; viewer: string; dev: boolean; canReturn: boolean };

export function useDealProductsInitialization({
	context,
	setState,
	setActiveVariantId,
}: {
	context: B24Context;
	setState: Dispatch<SetStateAction<DealProductsState>>;
	setActiveVariantId: (variantId: string | null) => void;
}): void {
	useEffect(() => {
		// dev / mock: BX24 нет — показываем таблицу на мок-данных, чтоб видеть UI
		if (context.__mock) {
			const params = new URLSearchParams(window.location.search);
			const data = params.has('variants') ? dealProductsMockVariantData(params.has('selected'), params.has('activity')) : DEAL_PRODUCTS_MOCK_DATA;
			setState({ phase: 'ready', data, viewer: 'dev (mock)', dev: true, canReturn: true });
			setActiveVariantId(data.quoteVariants.selectedId ?? data.quoteVariants.variants[0]?.id ?? null);
			return;
		}
		const bx24 = window.BX24;
		if (!bx24) {
			setState({ phase: 'error', message: 'BX24 SDK не загружен.' });
			return;
		}
		if (context.dealId == null) {
			setState({ phase: 'error', message: 'Не пришёл ID сделки из placement-контекста.' });
			return;
		}
		const dealId = context.dealId;
		bx24.init(() => {
			call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current')
				.then((user) => {
					const viewerId = String(user.ID ?? '');
					const viewerName = `${user.NAME ?? ''} ${user.LAST_NAME ?? ''}`.trim() || viewerId;
					const setupKey = 'b24-fulfillment-setup-2026-07-20-v1';
					if (window.BX24?.isAdmin() && window.localStorage.getItem(setupKey) !== 'done') {
						void setupDealFulfillment('2026-07-20', dealId)
							.then((result) => {
								if (result.failed === 0) window.localStorage.setItem(setupKey, 'done');
							})
							.catch(() => undefined);
					}
					setState({ phase: 'loading' });
					loadDealProductsData(dealId)
						.then((data) => {
							setState({ phase: 'ready', data, viewer: viewerName, dev: false, canReturn: true });
							setActiveVariantId(data.quoteVariants.selectedId ?? data.quoteVariants.variants[0]?.id ?? null);
						})
						.catch((error: unknown) => setState({ phase: 'error', message: String(error instanceof Error ? error.message : error) }));
				})
				.catch((error: unknown) => setState({ phase: 'error', message: `user.current: ${String(error instanceof Error ? error.message : error)}` }));
		});
	}, [context]);
}
