import { useState } from 'react';

const supplierNorm = (name: string): string =>
	name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function SupplySupplierField({
	id,
	label,
	value,
	suppliers,
	placeholder = 'поставщик',
	onChange,
	onCreate,
}: {
	id: string;
	label?: string;
	value: string;
	suppliers: string[];
	placeholder?: string;
	onChange: (value: string) => void;
	onCreate: (name: string) => Promise<string>;
}): JSX.Element {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const clean = value.trim();
	const exists = suppliers.some((supplier) => supplierNorm(supplier) === supplierNorm(clean));
	const canCreate = clean.length >= 2 && clean !== 'Поставщик не выбран' && !exists;
	const create = async (): Promise<void> => {
		if (!canCreate || busy) return;
		setBusy(true);
		setError('');
		try { onChange(await onCreate(clean)); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setBusy(false); }
	};
	return (
		<div className="supply-supplier-field">
			{label && <label htmlFor={id}>{label}</label>}
			<input id={id} list={`${id}-list`} value={value} onChange={(event) => { setError(''); onChange(event.target.value); }} placeholder={placeholder} autoComplete="off" />
			<datalist id={`${id}-list`}>{suppliers.map((supplier) => <option key={supplier} value={supplier} />)}</datalist>
			{canCreate && <button className="supply-create-supplier" type="button" disabled={busy} onClick={() => void create()}>{busy ? 'Создаю...' : `+ Создать «${clean}»`}</button>}
			{error && <small className="supply-create-supplier-error">{error}</small>}
		</div>
	);
}
