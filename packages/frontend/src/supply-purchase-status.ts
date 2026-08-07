import { type SupplyPurchaseChild } from './b24.js';

export const purchaseStatus = (purchase: SupplyPurchaseChild): { label: string; tone: string } => {
	const ordered = purchase.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0);
	const received = purchase.receipts.reduce((sum, receipt) => sum + receipt.lines.reduce((subtotal, line) => subtotal + Number(line.qty || 0), 0), 0);
	const stage = String(purchase.supplyStage ?? purchase.status ?? '').toLowerCase();
	if (ordered > 0 && received >= ordered) return { label: 'Получено', tone: 'ok' };
	if (received > 0) return { label: 'Частично получено', tone: 'warn' };
	if (stage.includes('order') || stage.includes('submit') || stage.includes('receive')) return { label: 'Заказано', tone: 'info' };
	if (stage.includes('approval')) return { label: 'На согласовании', tone: 'violet' };
	return { label: 'Черновик', tone: 'muted' };
};

export const purchaseQuantities = (purchase: SupplyPurchaseChild): { ordered: number; received: number } => ({
	ordered: purchase.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0),
	received: purchase.receipts.reduce((sum, receipt) => sum + receipt.lines.reduce((subtotal, line) => subtotal + Number(line.qty || 0), 0), 0),
});

export const purchaseIsCancelled = (purchase: SupplyPurchaseChild): boolean =>
	String(purchase.supplyStage ?? '').toLowerCase() === 'cancelled';

export const purchaseIsShortage = (purchase: SupplyPurchaseChild): boolean => {
	const { ordered, received } = purchaseQuantities(purchase);
	return !purchaseIsCancelled(purchase) && received > 0 && received < ordered;
};

export const purchaseIsWaiting = (purchase: SupplyPurchaseChild): boolean => {
	const { ordered, received } = purchaseQuantities(purchase);
	return !purchaseIsCancelled(purchase) && ordered > 0 && received < ordered;
};

export const purchaseAmount = (purchase: SupplyPurchaseChild): number =>
	purchase.lines.reduce((sum, line) => sum + Number(line.qty || 0) * Number(line.rate || 0), 0);
