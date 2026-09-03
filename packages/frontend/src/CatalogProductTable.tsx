import { photoFullUrl, type BaseRow } from './b24.js';
import { formatCatalogNumber as fmt, productStatuses } from './catalog-product-display.js';
import { CatalogQuantityInput } from './CatalogQuantityInput.js';

const CORE_ENGINEER_VISIT_SERVICE_ID = 9814001;

export type CatalogSortKey = 'id' | 'marketplaceOldId' | 'name' | 'model' | 'manufacturer' | 'section' | 'retail' | 'purchase' | 'stock' | 'total';

export interface CatalogTableRow {
	d: BaseRow;
	qty: number;
	others: Array<{ id: number; qty: number }>;
}

export function CatalogProductTable({
	view,
	marketplaceMode,
	isAll,
	canQuickSale,
	pickMode,
	canEditPrices,
	canEditMarketplaceBundlePrices,
	priceTagMode,
	sid,
	cart,
	priceTagQty,
	sortMark,
	toggleSort,
	storeName,
	setCardRow,
	setPriceRow,
	setCartQty,
	addToCart,
	setPriceTagCopies,
}: {
	view: CatalogTableRow[];
	marketplaceMode: boolean;
	isAll: boolean;
	canQuickSale: boolean;
	pickMode: boolean;
	canEditPrices: boolean;
	canEditMarketplaceBundlePrices: boolean;
	priceTagMode: boolean;
	sid: number | null;
	cart: ReadonlyMap<number, number>;
	priceTagQty: ReadonlyMap<number, number>;
	sortMark: (key: CatalogSortKey) => string;
	toggleSort: (key: CatalogSortKey) => void;
	storeName: (id: number) => string;
	setCardRow: (row: BaseRow) => void;
	setPriceRow: (row: BaseRow) => void;
	setCartQty: (id: number, quantity: number) => void;
	addToCart: (id: number) => void;
	setPriceTagCopies: (id: number, copies: number) => void;
}): JSX.Element {
	return (
			<div className="base-tablewrap">
				<table className={`base-table${isAll ? ' hide-store' : ''}`}>
					<thead>
						<tr>
							<th className="num" onClick={() => toggleSort('id')}>ID{sortMark('id')}</th>
							{marketplaceMode && <th onClick={() => toggleSort('marketplaceOldId')}>Старый ID{sortMark('marketplaceOldId')}</th>}
							<th className="ph-col" />
							<th onClick={() => toggleSort('name')}>Название{sortMark('name')}</th>
							<th onClick={() => toggleSort('model')}>Модель{sortMark('model')}</th>
							<th onClick={() => toggleSort('manufacturer')}>Производитель{sortMark('manufacturer')}</th>
							<th onClick={() => toggleSort('section')}>Раздел{sortMark('section')}</th>
							<th className="num" onClick={() => toggleSort('retail')}>Розница ₽{sortMark('retail')}</th>
							<th className="num" onClick={() => toggleSort('purchase')}>Закупка ₽{sortMark('purchase')}</th>
							<th className="num c-store" onClick={() => toggleSort('stock')}>Остаток{sortMark('stock')}</th>
							<th onClick={() => toggleSort('total')}>Остатки по складам{sortMark('total')}</th>
							{(canQuickSale || pickMode) && <th className="sale-col">{pickMode ? 'Кол-во' : 'В продажу'}</th>}
							{priceTagMode && <th className="sale-col">Ценники</th>}
						</tr>
					</thead>
					<tbody>
						{view.length ? view.map(({ d, qty, others }) => {
							const photo = d.photoPath ? photoFullUrl(d.photoPath) : null;
							const canEditRowPrices = canEditPrices
								|| (marketplaceMode && canEditMarketplaceBundlePrices && Boolean(d.isMarketplaceBundle));
							return (
								<tr key={d.id} onClick={() => d.id !== CORE_ENGINEER_VISIT_SERVICE_ID && setCardRow(d)} title={d.id === CORE_ENGINEER_VISIT_SERVICE_ID ? undefined : 'Открыть нашу карточку товара'}>
									<td className="num idcol">{d.id}</td>
									{marketplaceMode && <td className="marketplace-old-id-col">{d.marketplaceOldId || <span className="muted">—</span>}</td>}
									<td className="ph-col">
										{photo
											? <img className="ph" src={photo} loading="lazy" alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
											: <div className="no-ph">▦</div>}
									</td>
									<td className="nm">
										<div>{d.name}</div>
										{d.status && <div className="catalog-row-statuses">{productStatuses(d.status).map((status) => <span key={status} className="catalog-product-status">{status}</span>)}</div>}
									</td>
									<td>{d.article || d.model ? <span className="art">{d.article ?? d.model}</span> : <span className="muted">—</span>}</td>
									<td>{d.manufacturer ? <span className="brand">{d.manufacturer}</span> : <span className="muted">—</span>}</td>
									<td className="muted">{d.sectionName ?? '—'}</td>
									<td className="num money" onClick={(event) => event.stopPropagation()}>
										{canEditRowPrices && !pickMode
											? <button type="button" className="catalog-price-button" title="Изменить розничную и закупочную цены" onClick={() => setPriceRow(d)}><span>{fmt(d.retail)}</span><span aria-hidden="true">✎</span></button>
											: fmt(d.retail)}
									</td>
									<td className="num money" onClick={(event) => event.stopPropagation()}>
										{canEditRowPrices && !pickMode
											? <button type="button" className="catalog-price-button" title="Изменить розничную и закупочную цены" onClick={() => setPriceRow(d)}><span>{d.purchase ? fmt(d.purchase) : '0'}</span><span aria-hidden="true">✎</span></button>
											: d.purchase ? fmt(d.purchase) : <span className="muted">0</span>}
									</td>
									<td className="num c-store"><span className={`stock${qty > 0 ? '' : ' zero'}`}>{isAll ? '' : qty}</span></td>
									<td>
										<div className="whs">
											{others.length ? others.map((o) => <span className={`wh${o.id === sid ? ' sel' : ''}`} key={o.id} title={`Свободно: ${o.qty}; резерв этой сделки: ${d.ownReservedByStore?.[o.id] ?? 0}; другие резервы: ${d.reservedByStore?.[o.id] ?? 0}`}>{storeName(o.id)}: <b>{o.qty}</b>{Number(d.ownReservedByStore?.[o.id] ?? 0) > 0 && <em style={{ color: '#185fa5', fontStyle: 'normal' }}> 🔒{d.ownReservedByStore![o.id]}</em>}{Number(d.reservedByStore?.[o.id] ?? 0) > 0 && <em style={{ color: '#c0392b', fontStyle: 'normal' }}> 🔒{d.reservedByStore![o.id]}</em>}</span>) : <span className="muted">—</span>}
										</div>
									</td>
									{(canQuickSale || pickMode) && (
										<td className="sale-col" onClick={(e) => e.stopPropagation()}>
											{cart.has(d.id) ? (
												<div className="qty-stepper">
													<button onClick={() => setCartQty(d.id, (cart.get(d.id) ?? 1) - 1)} aria-label="меньше">−</button>
															<CatalogQuantityInput value={cart.get(d.id) ?? 1} onChange={(n) => setCartQty(d.id, n)} />
													<button onClick={() => setCartQty(d.id, (cart.get(d.id) ?? 0) + 1)} aria-label="больше">+</button>
												</div>
											) : (
												<button className="btn-add" onClick={() => addToCart(d.id)} title="Добавить в быструю продажу">＋</button>
											)}
										</td>
									)}
									{priceTagMode && (
										<td className="sale-col" onClick={(e) => e.stopPropagation()}>
											{d.isService ? <span className="muted">—</span> : priceTagQty.has(d.id) ? (
												<div className="qty-stepper">
													<button onClick={() => setPriceTagCopies(d.id, (priceTagQty.get(d.id) ?? 1) - 1)} aria-label="меньше">−</button>
															<CatalogQuantityInput value={priceTagQty.get(d.id) ?? 1} onChange={(n) => setPriceTagCopies(d.id, n)} />
													<button onClick={() => setPriceTagCopies(d.id, (priceTagQty.get(d.id) ?? 0) + 1)} aria-label="больше">+</button>
												</div>
											) : <button className="btn-add" onClick={() => setPriceTagCopies(d.id, 1)} title="Добавить ценник">＋</button>}
										</td>
									)}
								</tr>
							);
						}) : <tr><td colSpan={10 + (marketplaceMode ? 1 : 0) + ((canQuickSale || pickMode) ? 1 : 0) + (priceTagMode ? 1 : 0)} className="base-empty">Ничего не найдено</td></tr>}
					</tbody>
				</table>
			</div>
	);
}
