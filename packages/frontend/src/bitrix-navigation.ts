/** Открыть карточку сделки в Б24 (слайдером). */
export function openDeal(dealId: number): void {
	const path = `/crm/deal/details/${dealId}/`;
	const bx = window.BX24;
	if (bx && typeof bx.openPath === 'function') bx.openPath(path);
	else {
		const a = bx ? bx.getAuth() : false;
		window.open(`https://${a ? (a.domain ?? '') : ''}${path}`, '_blank');
	}
}

/** Открыть нативную карточку РЕАЛИЗАЦИИ (складского документа) по id отгрузки — слайдером.
 *  URL подтверждён: /shop/documents/details/sales_order/<shipmentId>/?inventoryManagementSource=inventory
 *  (1520 → реализация #926/2; id в пути = id отгрузки = «Идентификатор» из карточки). */
export function openRealization(shipmentId: number): void {
	const path = `/shop/documents/details/sales_order/${shipmentId}/?inventoryManagementSource=inventory`;
	const bx = window.BX24;
	if (bx && typeof bx.openPath === 'function') bx.openPath(path);
	else {
		const a = bx ? bx.getAuth() : false;
		window.open(`https://${a ? (a.domain ?? '') : ''}${path}`, '_blank');
	}
}

/** Открыть нативную карточку товара Б24 (слайдером, не уходя из приложения). */
export function openProductCard(iblockId: number, productId: number): void {
	const path = `/shop/documents-catalog/${iblockId}/product/${productId}/`;
	const bx = window.BX24;
	if (bx && typeof bx.openPath === 'function') bx.openPath(path);
	else {
		const auth = bx ? bx.getAuth() : false;
		window.open(`https://${auth ? (auth.domain ?? '') : ''}${path}`, '_blank');
	}
}
