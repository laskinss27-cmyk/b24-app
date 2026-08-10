import type { BaseRow } from './b24.js';
import { formatCatalogNumber as fmt } from './catalog-product-display.js';
import { CatalogQuantityInput } from './CatalogQuantityInput.js';

export function QuickSaleCartModal({
	items,
	discountPercent,
	lineFinal,
	cartSum,
	cartFinal,
	cartSaved,
	error,
	creatingSale,
	onQuantityChange,
	onDiscountChange,
	onClear,
	onClose,
	onCreate,
}: {
	items: Array<{ row: BaseRow; qty: number }>;
	discountPercent: (id: number) => number;
	lineFinal: (row: BaseRow, qty: number) => number;
	cartSum: number;
	cartFinal: number;
	cartSaved: number;
	error: string | null;
	creatingSale: boolean;
	onQuantityChange: (id: number, qty: number) => void;
	onDiscountChange: (id: number, discount: number) => void;
	onClear: () => void;
	onClose: () => void;
	onCreate: () => Promise<void>;
}): JSX.Element {
	return (
		<div className="cart-overlay" onClick={onClose}>
			<div className="cart-modal" onClick={(e) => e.stopPropagation()}>
				<h2>🛒 Быстрая продажа</h2>
				{items.length ? (
					<>
						<div className="cart-head">
							<span>Товар</span><span>Цена</span><span>Кол-во</span><span>Скидка %</span><span>Сумма</span><span />
						</div>
						<div className="cart-items">
							{items.map((item) => (
								<div className="cart-item" key={item.row.id}>
									<span className="cart-nm">{item.row.name}</span>
									<span className="cart-unit money">{fmt(item.row.retail)} ₽</span>
									<div className="qty-stepper">
										<button onClick={() => onQuantityChange(item.row.id, item.qty - 1)} aria-label="меньше">−</button>
										<CatalogQuantityInput value={item.qty} onChange={(quantity) => onQuantityChange(item.row.id, quantity)} />
										<button onClick={() => onQuantityChange(item.row.id, item.qty + 1)} aria-label="больше">+</button>
									</div>
									<input className="disc-input sm" type="number" min={0} max={99} value={discountPercent(item.row.id)} onChange={(event) => onDiscountChange(item.row.id, Number(event.target.value))} />
									<span className="cart-line money">{fmt(lineFinal(item.row, item.qty))} ₽</span>
									<button className="cart-del" onClick={() => onQuantityChange(item.row.id, 0)} aria-label="убрать">✕</button>
								</div>
							))}
						</div>
						<div className="cart-total">
							{cartSaved > 0 && <div className="cart-disc-line">Скидка суммарно: −{fmt(cartSaved)} ₽ (без скидки {fmt(cartSum)} ₽)</div>}
							<div className="cart-grand">К оплате: <b>{fmt(cartFinal)} ₽</b></div>
						</div>
						{error && <div className="cart-err">⛔ {error}</div>}
						<div className="cart-actions">
							<button className="btn-secondary" onClick={onClear}>Очистить</button>
							<button className="btn-secondary" onClick={onClose}>Закрыть</button>
							<button className="btn-primary" disabled={creatingSale} onClick={() => void onCreate()}>{creatingSale ? 'Создаю…' : 'Создать продажу'}</button>
						</div>
						<p className="cart-hint muted">Создастся сделка в воронке «Быстрая продажа» (стадия «Подбор оборудования») с этими позициями и сразу откроется. Оплату/кассу проводишь в сделке нативно, клиента добавишь в карточке.</p>
					</>
				) : (
					<p className="muted">Корзина пуста.</p>
				)}
			</div>
		</div>
	);
}
