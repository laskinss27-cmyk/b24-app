import type { SupplyOrderRow } from './b24.js';
import { requestItemsForOrder } from './supply-decision-planning.js';

export type SupplyOrderStatus = 'needs_action' | 'in_progress' | 'closed';
export type OrderStatusFilter = SupplyOrderStatus[];

export const SUPPLY_ORDER_STATUS_OPTIONS: Array<{ value: SupplyOrderStatus; label: string }> = [
	{ value: 'needs_action', label: 'Требуют обработки' },
	{ value: 'in_progress', label: 'В исполнении' },
	{ value: 'closed', label: 'Закрытые' },
];

export const orderStatus = (order: SupplyOrderRow): SupplyOrderStatus =>
	order.closed ? 'closed' : requestItemsForOrder(order).length > 0 ? 'needs_action' : 'in_progress';

export const orderMatchesStatusFilter = (order: SupplyOrderRow, filter: OrderStatusFilter): boolean =>
	filter.length === 0 || filter.includes(orderStatus(order));

export const toggleOrderStatusFilter = (filter: OrderStatusFilter, status: SupplyOrderStatus): OrderStatusFilter =>
	filter.includes(status) ? filter.filter((value) => value !== status) : [...filter, status];
