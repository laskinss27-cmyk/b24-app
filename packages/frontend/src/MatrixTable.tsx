import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MatrixColumn { id: string; label: string; width: number; min?: number }
const WIDTH_KEY = 'b24-matrix-column-widths-v1';
const clamp = (value: number, column: MatrixColumn): number => Math.max(column.min ?? 72, Math.min(600, value));

/** One scroll surface for both axes; the second scrollbar stays above the rows. */
export function MatrixTable({ columns, children }: { columns: MatrixColumn[]; children: ReactNode }): JSX.Element {
	const [widths, setWidths] = useState<Record<string, number>>(() => {
		try {
			const saved: unknown = JSON.parse(localStorage.getItem(WIDTH_KEY) ?? '{}');
			return saved && typeof saved === 'object' && !Array.isArray(saved)
				? Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) : {};
		} catch { return {}; }
	});
	const [edgeScroll, setEdgeScroll] = useState(false);
	const viewport = useRef<HTMLDivElement>(null);
	const topScroll = useRef<HTMLDivElement>(null);
	const topTrack = useRef<HTMLDivElement>(null);
	const table = useRef<HTMLTableElement>(null);
	const animation = useRef(0);
	const delay = useRef<ReturnType<typeof setTimeout>>();
	const drag = useRef<{ id: string; x: number; width: number } | null>(null);
	const width = (column: MatrixColumn): number => clamp(widths[column.id] ?? column.width, column);
	const totalWidth = columns.reduce((sum, column) => sum + width(column), 0);
	const resize = (column: MatrixColumn, value: number): void => setWidths((current) => ({ ...current, [column.id]: clamp(value, column) }));
	const stop = (): void => { clearTimeout(delay.current); cancelAnimationFrame(animation.current); };
	const scroll = (direction: number): void => { if (viewport.current) viewport.current.scrollLeft += direction * 240; };
	const start = (direction: number): void => {
		stop();
		if (!edgeScroll || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		delay.current = setTimeout(() => {
			let previous = performance.now();
			const tick = (now: number): void => {
				if (!viewport.current) return;
				viewport.current.scrollLeft += direction * Math.min(now - previous, 32) * .6;
				previous = now;
				animation.current = requestAnimationFrame(tick);
			};
			animation.current = requestAnimationFrame(tick);
		}, 350);
	};
	useEffect(() => {
		try { localStorage.setItem(WIDTH_KEY, JSON.stringify(widths)); } catch { /* Storage may be disabled in the host iframe. */ }
	}, [widths]);
	useEffect(() => {
		const observer = new ResizeObserver(() => {
			if (topTrack.current && viewport.current) topTrack.current.style.width = `${viewport.current.scrollWidth}px`;
			if (topScroll.current && viewport.current) topScroll.current.scrollLeft = viewport.current.scrollLeft;
		});
		if (table.current) observer.observe(table.current);
		if (viewport.current) observer.observe(viewport.current);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		window.addEventListener('blur', stop);
		document.addEventListener('visibilitychange', stop);
		return () => { stop(); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', stop); };
	}, []);

	return <div className="matrix-grid">
		<div className="matrix-grid-tools">
			<label><input type="checkbox" checked={edgeScroll} onChange={(event) => { stop(); setEdgeScroll(event.target.checked); }} /> Прокрутка у краёв</label>
			<span>Ширина колонок: потяни границу заголовка или выбери её и нажми ← / →</span>
			<button type="button" onClick={() => setWidths({})}>Сбросить ширину</button>
		</div>
		<div className="matrix-scrollbar-row">
			<button type="button" aria-label="Прокрутить таблицу влево" onClick={() => scroll(-1)}>←</button>
			<div ref={topScroll} className="matrix-top-scroll" tabIndex={0} role="region" aria-label="Горизонтальная прокрутка матрицы" onScroll={(event) => { if (viewport.current && viewport.current.scrollLeft !== event.currentTarget.scrollLeft) viewport.current.scrollLeft = event.currentTarget.scrollLeft; }}><div ref={topTrack} style={{ width: totalWidth, height: 1 }} /></div>
			<button type="button" aria-label="Прокрутить таблицу вправо" onClick={() => scroll(1)}>→</button>
		</div>
		<div className="matrix-grid-frame">
			{([-1, 1] as const).map((direction) => <button key={direction} className={`matrix-edge matrix-edge-${direction < 0 ? 'left' : 'right'}`} type="button" aria-label={direction < 0 ? 'Левый край: прокрутить влево' : 'Правый край: прокрутить вправо'} title={edgeScroll ? 'Наведи мышь для прокрутки; нажми для шага' : 'Нажми для прокрутки'} onPointerEnter={(event) => { if (event.pointerType === 'mouse') start(direction); }} onPointerLeave={stop} onPointerCancel={stop} onBlur={stop} onClick={() => scroll(direction)}>{direction < 0 ? '‹' : '›'}</button>)}
			<div ref={viewport} className="assortment-matrix-table-wrap" tabIndex={0} role="region" aria-label="Товары матрицы заказов" onScroll={(event) => { if (topScroll.current && topScroll.current.scrollLeft !== event.currentTarget.scrollLeft) topScroll.current.scrollLeft = event.currentTarget.scrollLeft; }}>
				<table ref={table} style={{ width: totalWidth }}><colgroup>{columns.map((column) => <col key={column.id} style={{ width: width(column) }} />)}</colgroup><thead><tr>{columns.map((column) => <th key={column.id} scope="col"><span>{column.label}</span><button type="button" className="matrix-column-resizer" aria-label={`Ширина колонки «${column.label}»: ${width(column)} пикселей`} title="Потяни для изменения ширины. Стрелки ← / → — шаг 16 пикселей, Home — исходная ширина." onPointerDown={(event) => {
					if (event.button !== 0) return;
					stop(); event.currentTarget.setPointerCapture(event.pointerId);
					drag.current = { id: column.id, x: event.clientX, width: width(column) };
				}} onPointerMove={(event) => { if (drag.current?.id === column.id) resize(column, drag.current.width + event.clientX - drag.current.x); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={(event) => {
					if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home') {
						event.preventDefault(); resize(column, event.key === 'Home' ? column.width : width(column) + (event.key === 'ArrowLeft' ? -16 : 16));
					}
				}} /></th>)}</tr></thead><tbody>{children}</tbody></table>
			</div>
		</div>
	</div>;
}
