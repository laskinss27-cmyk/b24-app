import { useId, useRef, useState } from 'react';

/** Пустой выбор означает все значения; пункты можно отмечать без закрытия списка. */
export function CatalogMultiSelect({ label, allLabel, options, value, onChange }: {
	label: string;
	allLabel: string;
	options: Array<{ id: number; label: string }>;
	value: number[];
	onChange: (value: number[]) => void;
}): JSX.Element {
	const labelId = useId();
	const details = useRef<HTMLDetailsElement>(null);
	const [query, setQuery] = useState('');
	const selectedLabels = options.filter((option) => value.includes(option.id)).map((option) => option.label);
	const summary = value.length ? selectedLabels.join(', ') : allLabel;
	const visible = options.filter((option) => option.label.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')));
	return <div className="tb-field tb-multi-field">
		<span id={labelId}>{label}</span>
		<details className="tb-multi" ref={details}
			onToggle={() => { if (!details.current?.open) setQuery(''); }}
			onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }}
			onKeyDown={(event) => {
				if (event.key !== 'Escape') return;
				event.preventDefault();
				event.currentTarget.open = false;
				event.currentTarget.querySelector('summary')?.focus();
			}}>
			<summary aria-labelledby={labelId} title={summary}>
				<span className="tb-multi-value">{summary}</span>
				{value.length > 1 && <span className="tb-multi-count">{value.length}</span>}
				<span aria-hidden="true">▾</span>
			</summary>
			<div className="tb-multi-menu" role="group" aria-labelledby={labelId}>
				<input type="search" aria-label={`Поиск: ${label}`} placeholder="Найти…" value={query} onChange={(event) => setQuery(event.target.value)} />
				<button type="button" className="tb-multi-all" onClick={() => onChange([])}>{allLabel}{value.length === 0 ? ' ✓' : ''}</button>
				<div className="tb-multi-options">
					{visible.map((option) => <label className="tb-multi-option" key={option.id}>
						<input type="checkbox" checked={value.includes(option.id)} onChange={(event) => onChange(event.target.checked ? [...value, option.id] : value.filter((id) => id !== option.id))} />
						<span>{option.label}</span>
					</label>)}
					{!visible.length && <span className="tb-multi-empty">Ничего не найдено</span>}
				</div>
			</div>
		</details>
	</div>;
}
