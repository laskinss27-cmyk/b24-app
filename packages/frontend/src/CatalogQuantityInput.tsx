import { useEffect, useState } from 'react';

/**
 * Поле ввода количества с локальным состоянием: можно очистить и вписать своё, не теряя
 * позицию. В корзину уходит только валидное число ≥1 (пустое/0 при редактировании не
 * трогает корзину — иначе backspace удалял бы товар). На blur пустое возвращается к value.
 */
export function CatalogQuantityInput({ value, onChange }: { value: number; onChange: (n: number) => void }): JSX.Element {
	const [text, setText] = useState(String(value));
	useEffect(() => { setText(String(value)); }, [value]);
	return (
		<input
			className="qty-input"
			type="number"
			min={1}
			value={text}
			onClick={(e) => e.stopPropagation()}
			onChange={(e) => {
				const t = e.target.value;
				setText(t);
				const n = Math.floor(Number(t));
				if (t !== '' && Number.isFinite(n) && n >= 1) onChange(n);
			}}
			onBlur={() => {
				const n = Math.floor(Number(text));
				if (!(Number.isFinite(n) && n >= 1)) setText(String(value));
			}}
		/>
	);
}
