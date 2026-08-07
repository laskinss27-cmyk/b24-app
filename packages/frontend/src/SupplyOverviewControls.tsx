export function SupplyStatusPill({ tone, children }: { tone: string; children: string }): JSX.Element {
	return <span className={`supply-proto-pill ${tone}`}>{children}</span>;
}

export function SupplySearch({ value, onChange }: { value: string; onChange: (value: string) => void }): JSX.Element {
	return (
		<label className="supply-proto-search">
			<span>Поиск</span>
			<input type="search" value={value} placeholder="Сделка, склад, товар или поставщик" onChange={(event) => onChange(event.target.value)} />
		</label>
	);
}
