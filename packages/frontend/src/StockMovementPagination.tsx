export function StockMovementPagination({ page, pages, first, last, total, onPage }: {
	page: number; pages: number; first: number; last: number; total: number; onPage: (page: number) => void;
}): JSX.Element {
	return <nav aria-label="Страницы документов" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0' }}>
		<button className="btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Назад</button>
		<span aria-live="polite">{first}–{last} из {total} · Страница {page} из {pages}</span>
		<button className="btn-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Далее →</button>
	</nav>;
}
