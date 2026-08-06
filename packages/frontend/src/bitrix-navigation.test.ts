import assert from 'node:assert/strict';
import test from 'node:test';

const openedPaths: string[] = [];
const openedWindows: Array<{ url: string; target: string }> = [];

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: {
		__B24_CONTEXT__: { dealId: null, domain: 'mobile.example', memberId: null, accessToken: 'mobile-token' },
		open: (url: string, target: string) => { openedWindows.push({ url, target }); },
	} as unknown as Window,
});

const { openDeal, openProductCard, openRealization } = await import('./b24.js');

test('Bitrix navigation preserves native slider paths', () => {
	openedPaths.length = 0;
	window.BX24 = {
		openPath: (path: string) => { openedPaths.push(path); },
		getAuth: () => ({ domain: 'portal.example' }),
	} as NonNullable<Window['BX24']>;

	openDeal(501);
	openRealization(926);
	openProductCard(17, 42);
	assert.deepEqual(openedPaths, [
		'/crm/deal/details/501/',
		'/shop/documents/details/sales_order/926/?inventoryManagementSource=inventory',
		'/shop/documents-catalog/17/product/42/',
	]);
});

test('Bitrix navigation preserves browser fallback URLs', () => {
	openedWindows.length = 0;
	window.BX24 = {
		getAuth: () => ({ domain: 'portal.example' }),
	} as NonNullable<Window['BX24']>;

	openDeal(501);
	openProductCard(17, 42);
	assert.deepEqual(openedWindows, [
		{ url: 'https://portal.example/crm/deal/details/501/', target: '_blank' },
		{ url: 'https://portal.example/shop/documents-catalog/17/product/42/', target: '_blank' },
	]);
});
