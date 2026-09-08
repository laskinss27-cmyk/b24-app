import { inventoryMoneyTotals } from '@b24-app/shared';
import type { InvResult } from './inventory-api.js';

export const inventoryRubles = (value: number): string => value.toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2 });

export function InventoryMoneySummary({ result }: { result: InvResult }): JSX.Element {
	const totals = inventoryMoneyTotals(result.lines);
	return <div className="inventory-money-summary">
		<span className="short">Недостача: <b>{totals.shortage === null ? 'не рассчитана полностью' : inventoryRubles(totals.shortage)}</b></span>
		<span className="over">Излишки: <b>{totals.surplus === null ? 'не рассчитаны полностью' : inventoryRubles(totals.surplus)}</b></span>
		<small>Последний отправленный отчёт. По розничным ценам на момент отправки.
			{totals.missingShortage + totals.missingSurplus > 0 && ` Нет сохранённой цены для ${totals.missingShortage + totals.missingSurplus} поз. с расхождением.`}
		</small>
	</div>;
}
