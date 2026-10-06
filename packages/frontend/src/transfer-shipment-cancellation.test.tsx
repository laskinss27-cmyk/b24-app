import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupplyDocumentDetail } from './SupplyDocumentDetail.js';
import { confirmMistakenShipment } from './transfer-shipment-cancellation.js';
import { cancelTransfer, cancelTransferRequest } from './stock-transfers.js';

test('shipment cancellation requires a meaningful reason and physical confirmation', (t) => {
	let reason: string | null = '  Goods never left the source  ', confirmed = true, alerts = 0, confirmations = 0;
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: {
		prompt: () => reason, confirm: () => { confirmations++; return confirmed; }, alert: () => { alerts++; },
	} });
	t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
	assert.deepEqual(confirmMistakenShipment('Source'), { reason: 'Goods never left the source', goodsStayedAtSource: true });
	confirmed = false; assert.equal(confirmMistakenShipment('Source'), null);
	reason = ''; assert.equal(confirmMistakenShipment('Source'), null);
	reason = null; assert.equal(confirmMistakenShipment('Source'), null);
	assert.equal(confirmations, 2); assert.equal(alerts, 1);
});

test('transfer API sends cancellation confirmation; request cancellation stays unchanged', async (t) => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { __B24_CONTEXT__: { domain: 'test.example', accessToken: 'fake' } } });
	t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
	const bodies: Record<string, unknown>[] = [];
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ok: true, transfer: { id: 123 }, request: { id: 456 } }));
	});
	await cancelTransfer(123, { reason: 'Test reason', goodsStayedAtSource: true });
	await cancelTransferRequest(456);
	assert.equal(bodies[0]!['reason'], 'Test reason'); assert.equal(bodies[0]!['goodsStayedAtSource'], true);
	assert.equal(bodies[1]!['reason'], undefined); assert.equal(bodies[1]!['goodsStayedAtSource'], undefined);
});

test('supply detail offers mistaken cancellation only before reception and displays pending recovery', () => {
	const noop = () => {};
	const props = { suppliers: [], busy: false, canDelete: false, onClose: noop, onDelete: noop, onCreateSupplier: async () => '',
		onSavePurchase: noop, onReceivePurchase: noop, onCreatePurchaseTransfer: noop, onChangeTransferDestination: async () => ({}),
		onUpdateTransfer: noop, onCollectTransfer: noop, onShipTransfer: noop, onReceiveTransfer: noop, onPostTransfer: noop, onCancelTransfer: noop, onResolveShortage: noop,
		document: { kind: 'transfer', order: { name: 'Test', standalone: true }, transfer: { id: 123, name: 'Test transfer', status: 'in_transit',
			fromStore: 'Source', toStore: 'Destination', lines: [], collectedLines: [], shippedLines: [], acceptedLines: [], history: [] } },
	} as unknown as ComponentProps<typeof SupplyDocumentDetail>;
	assert.match(renderToStaticMarkup(<SupplyDocumentDetail {...props} />), /Отменить ошибочную отправку/);
	if (props.document.kind !== 'transfer') throw new Error('Fixture');
	props.document.transfer.status = 'accepted';
	assert.doesNotMatch(renderToStaticMarkup(<SupplyDocumentDetail {...props} />), /Отменить ошибочную отправку/);
	props.document.transfer.status = 'in_transit';
	props.document.transfer.shipmentCancellation = { reason: 'Test', at: '', byId: '1', byName: 'Test' };
	const html = renderToStaticMarkup(<SupplyDocumentDetail {...props} />);
	assert.match(html, /приёмка заблокирована/); assert.match(html, /disabled=""[^>]*>Принять/);
});
