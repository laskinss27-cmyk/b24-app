import type { StoreInfo } from './b24.js';
import { plural } from './deal-display-formatters.js';

interface SupplyOrderRow {
	id: string;
	name: string;
	measure: string;
	remaining: number;
}

export function DealSupplyOrderModal({
	rows,
	stores,
	busy,
	toStore,
	deadline,
	minimumDate,
	orderNote,
	formError,
	quantities,
	notes,
	onClose,
	onStoreChange,
	onDeadlineChange,
	onOrderNoteChange,
	onQuantityChange,
	onNoteChange,
	onSubmit,
}: {
	rows: SupplyOrderRow[];
	stores: StoreInfo[];
	busy: boolean;
	toStore: string;
	deadline: string;
	minimumDate: string;
	orderNote: string;
	formError: string | null;
	quantities: Record<string, string>;
	notes: Record<string, string>;
	onClose: () => void;
	onStoreChange: (value: string) => void;
	onDeadlineChange: (value: string) => void;
	onOrderNoteChange: (value: string) => void;
	onQuantityChange: (rowId: string, value: string) => void;
	onNoteChange: (rowId: string, value: string) => void;
	onSubmit: () => void;
}): JSX.Element {
	return (
		<div className="deal-supply-order-overlay" onClick={() => !busy && onClose()}>
			<section className="deal-supply-order-modal" role="dialog" aria-modal="true" aria-label="Заказ снабжению" onClick={(event) => event.stopPropagation()}>
				<header>
					<div><h2>Заказ снабжению</h2><span>{rows.length} {plural(rows.length, 'позиция', 'позиции', 'позиций')}</span></div>
					<button type="button" aria-label="Закрыть" title="Закрыть" disabled={busy} onClick={onClose}>×</button>
				</header>
				<div className="deal-supply-order-fields">
					<label><span>Конечный склад</span><select value={toStore} disabled={busy} onChange={(event) => onStoreChange(event.target.value)}><option value="">Выберите склад</option>{stores.map((store) => <option key={store.id} value={store.title}>{store.title}</option>)}</select></label>
					<label><span>Привезти не позднее</span><input type="date" min={minimumDate} value={deadline} disabled={busy} onChange={(event) => onDeadlineChange(event.target.value)} /></label>
					<label className="wide"><span>Общий комментарий</span><textarea rows={2} maxLength={500} value={orderNote} disabled={busy} placeholder="Комментарий ко всему заказу" onChange={(event) => onOrderNoteChange(event.target.value)} /></label>
				</div>
				<div className={`deal-supply-order-destination${toStore ? '' : ' is-empty'}`}>
					{toStore
						? <>Конечный склад: <b>{toStore}</b>. Заявка будет создана только после нажатия кнопки ниже.</>
						: 'Выберите конечный склад вручную — он не берётся из отмеченных строк.'}
				</div>
				{formError && <div className="deal-supply-order-error">{formError}</div>}
				<div className="deal-supply-order-lines">
					{rows.map((row) => (
						<label key={row.id} className="deal-supply-order-line">
							<span className="deal-supply-order-line-head"><b>{row.name}</b><small>Нужно по сделке: {row.remaining} {row.measure}</small></span>
							<span className="deal-supply-order-qty"><small>Заказать</small><input
								type="number"
								min="0.001"
								step="any"
								value={quantities[row.id] ?? ''}
								disabled={busy}
								onChange={(event) => onQuantityChange(row.id, event.target.value)}
							/></span>
							<textarea
								value={notes[row.id] ?? ''}
								maxLength={500}
								rows={2}
								placeholder="Комментарий к позиции"
								disabled={busy}
								onChange={(event) => onNoteChange(row.id, event.target.value)}
							/>
						</label>
					))}
				</div>
				<footer>
					<button type="button" disabled={busy} onClick={onClose}>Отмена</button>
					<button className="primary" type="button" disabled={busy} onClick={onSubmit}>{busy ? 'Создаю…' : 'Создать заказ'}</button>
				</footer>
			</section>
		</div>
	);
}
