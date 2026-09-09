import type { InventoryStockCheck as Check } from './inventory-api.js';

export function InventoryStockCheck({ check }: { check: Check | undefined }): JSX.Element {
	if (!check) return <p>Проверка остатков не получена. Проведение заблокировано — нажмите «Обновить проверку».</p>;
	const attention = [...new Map([...check.shortages, ...check.changed].map(row => [row.productId, row])).values()];
	return <section aria-label="Проверка остатков ревизии">
		<p><b>Проверено позиций: {check.rows.length}. Нехваток для проведения: {check.shortages.length}.</b> Остаток изменился у {check.changed.length} позиций. Проверка: {new Date(check.checkedAt).toLocaleString('ru-RU')}.</p>
		{check.changed.length > 0 && <p>Число «Введено» относится к моменту подсчёта. Документы применяют разницу с базой ревизии к текущему учёту, а не устанавливают введённое число. Сверьте изменения с отгрузками и перемещениями; сам факт движения не означает недостачу.</p>}
		{attention.length > 0 && <div style={{ overflowX: 'auto' }}><table className="disc-table">
			<thead><tr><th>Товар</th><th>База ревизии</th><th>Введено</th><th>Учёт сейчас</th><th>Корректировка</th><th>После документов*</th><th>Не хватает</th></tr></thead>
			<tbody>{attention.map(row => <tr key={row.productId}><td>{row.productId}: {row.name}</td><td>{row.book}</td><td>{row.fact ?? 'Не считали'}</td><td>{row.current}</td><td>{row.adjustment}</td><td>{row.projected}</td><td>{row.shortage > 0 ? row.shortage : '—'}</td></tr>)}</tbody>
		</table><p className="muted">* Прогноз без новых движений, в учётных единицах товара. Отрицательный остаток провести нельзя.</p></div>}
	</section>;
}
