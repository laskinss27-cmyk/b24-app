import type { DeliveryEnvelope } from './contract.js';
import type { Customer } from './store.js';
import { money, safeText } from './message-format.js';
import { orderItemMessages } from './message-items.js';
export { safeText } from './message-format.js';

type Touch = NonNullable<DeliveryEnvelope['order']['attribution']>['first'];
export function attributionText(touch: Touch): string {
	if (!touch || (!touch.source && !touch.medium && !touch.referrerHost)) return 'Источник не определён';
	const source = touch.source.toLowerCase(), medium = touch.medium.toLowerCase();
	if (source === 'direct' && touch.kind === 'direct') return 'Прямой заход';
	if (source === 'yandex' && medium === 'maps') return 'Яндекс Карты';
	const names: Record<string, string> = { yandex: 'Яндекс', google: 'Google', '2gis': '2ГИС', telegram: 'Telegram', vk: 'ВКонтакте', unknown: 'Источник не определён' };
	return safeText(names[source] || touch.source || touch.referrerHost || 'Источник не определён');
}
export function customerLink(customer: Customer, portal: string): string {
	if (!/^[a-z0-9.-]+$/i.test(portal) || !/^[1-9]\d*$/.test(customer.id)) throw new Error('Invalid customer link');
	const path = { CONTACT: 'contact', COMPANY: 'company', LEAD: 'lead' }[customer.kind];
	return `[URL=https://${portal}/crm/${path}/details/${customer.id}/]Карточка клиента[/URL]`;
}

export function orderMessages(envelope: DeliveryEnvelope, _receipt: string, customer: Customer | null, candidates: Customer[], portal: string): string[] {
	const order = envelope.order;
	const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(envelope.occurredAt));
	const heading = `${order.test ? '[ТЕСТ] ' : ''}Новый заказ №${safeText(order.number.slice(0, 120))} · ${time} МСК`;
	const lines = [
		`Покупатель: ${safeText(order.contact.name)}${customer ? ' · ' + customerLink(customer, portal) : ''}`,
		customer ? '' : 'Нужен ручной разбор: найдено несколько клиентов. Новый лид не создан.',
		...candidates.map(c => 'Кандидат: ' + customerLink(c, portal)),
		`Телефон: ${safeText(order.contact.phone)}${order.contact.email ? ' · Email: ' + safeText(order.contact.email) : ''}`,
		order.business ? `Организация: ${safeText(order.business.name)}` : '',
		order.business ? `ИНН: ${safeText(order.business.inn)}${order.business.kpp ? ' · КПП: ' + safeText(order.business.kpp) : ''}` : '',
		order.business?.details ? `Реквизиты: ${safeText(order.business.details)}` : '',
		!order.fulfillment ? 'Получение: Не указано · уточнить у клиента' : order.fulfillment.method === 'pickup' ? 'Получение: Самовывоз · точку и время уточнить' : 'Получение: Доставка',
		order.fulfillment?.method === 'delivery' ? `Адрес: ${safeText(order.fulfillment.address)}` : '',
		'Источник: ' + attributionText(order.attribution?.last ?? order.attribution?.first ?? null),
		...orderItemMessages(order),
		order.totals.discountMinor > 0 ? `Скидка: ${money(order.totals.discountMinor)}${order.promo ? ' · Промокод: ' + safeText(order.promo.code) : ''}` : order.promo ? 'Промокод: ' + safeText(order.promo.code) : '',
		order.totals.totalMinor === null && order.totals.knownSubtotalMinor > 0 ? 'Позиции с указанной ценой: ' + money(order.totals.knownSubtotalMinor) : '',
		`Итого: ${money(order.totals.totalMinor)}`,
		order.contact.comment ? 'Комментарий: ' + safeText(order.contact.comment) : '',
	];
	const chunks: string[] = [];
	let chunk = '';
	for (const line of lines.filter(Boolean)) {
		if (chunk.length + line.length > 12000) { chunks.push(chunk); chunk = ''; }
		chunk += (chunk ? '\n' : '') + line;
	}
	if (chunk) chunks.push(chunk);
	// Exact notification_plan and message IDs remain in SQLite for uncertain-write review.
	// Search by order number, then compare saved full plan, customer, time and part; never blind-resend.
	return chunks.map((part, index) => `${heading}${chunks.length > 1 ? ' · часть ' + (index + 1) + '/' + chunks.length : ''}\n\n${part}`);
}
