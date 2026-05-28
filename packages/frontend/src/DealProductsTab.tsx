import { useEffect, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';

/**
 * Заглушка вкладки «Товары». Цель этого компонента в Sprint 1 — доказать
 * что placement работает: фронт грузится в iframe, контекст приходит,
 * BX24.js инициализируется, можно дёрнуть метод (показываем имя текущего юзера).
 *
 * После того как Володя зарегистрирует приложение, мы заменяем заглушку
 * на настоящую таблицу товаров.
 */
export function DealProductsTab(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [bx24Ready, setBx24Ready] = useState(false);
	const [currentUser, setCurrentUser] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (ctx.__mock) {
			// На dev SDK BX24 не подгружен — нет смысла его дёргать.
			return;
		}
		const bx24 = window.BX24;
		if (!bx24) {
			setError('BX24 SDK не загружен. Проверьте что <script src="//api.bitrix24.com/api/v1/"> вставлен в HTML.');
			return;
		}
		bx24.init(() => {
			setBx24Ready(true);
			bx24.callMethod('user.current', {}, (res) => {
				const err = res.error();
				if (err) {
					setError(`user.current failed: ${JSON.stringify(err)}`);
					return;
				}
				const data = res.data() as { NAME?: string; LAST_NAME?: string };
				setCurrentUser(`${data.NAME ?? ''} ${data.LAST_NAME ?? ''}`.trim() || '(имя не пришло)');
			});
		});
	}, [ctx]);

	return (
		<div className="deal-products-tab">
			<header>
				<h1>Товары сделки</h1>
				<p className="subtitle">Sprint 1 — заглушка для проверки placement</p>
			</header>

			<section>
				<h2>Контекст из Битрикса</h2>
				<dl>
					<dt>Deal ID</dt>
					<dd>{ctx.dealId ?? '—'}</dd>
					<dt>Domain</dt>
					<dd>{ctx.domain ?? '—'}</dd>
					<dt>Member ID</dt>
					<dd>{ctx.memberId ?? '—'}</dd>
					<dt>Режим</dt>
					<dd>{ctx.__mock ? 'dev (mock)' : 'prod (от Битрикса)'}</dd>
				</dl>
			</section>

			<section>
				<h2>BX24 SDK</h2>
				{ctx.__mock ? (
					<p>Локальный dev — SDK не инициализируется (нет родительского окна Битрикса).</p>
				) : error ? (
					<p className="error">⛔ {error}</p>
				) : !bx24Ready ? (
					<p>Инициализация BX24…</p>
				) : (
					<p>
						✅ BX24 готов. Текущий пользователь: <strong>{currentUser ?? 'загружается…'}</strong>
					</p>
				)}
			</section>

			<footer>
				<small>
					Дальше — таблица товаров сделки с N/M, селектором склада (фильтр остаток&gt;0),
					чекбоксами «Реализовать», блоком итогов (Сумма работ × коэф + Сумма товаров − Σ закупок).
				</small>
			</footer>
		</div>
	);
}
