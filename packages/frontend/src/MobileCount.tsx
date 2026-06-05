import { useEffect, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { listInventories, type InvPoint, type InvResult } from './b24.js';
import { InventoryCount } from './InventoryReport.js';

/**
 * Мобильный экран подсчёта точки (вход с телефона по QR → /m?inv&store, вне iframe Б24).
 *
 * Точка уже выбрана на ПК (в QR зашиты inventoryId + storeId), здесь телефон только считает
 * и отправляет факты в ту же базу — десктоп подхватывает их (в т.ч. черновик, saveDraft).
 * Отличия от ПК: остатки грузятся серверно (нет BX24 SDK), «Добавить товар» недоступно.
 */

type Phase =
	| { k: 'loading' }
	| { k: 'error'; msg: string }
	| { k: 'counting'; point: InvPoint; sectionIds?: number[] | undefined }
	| { k: 'done' };

export function MobileCount(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [phase, setPhase] = useState<Phase>({ k: 'loading' });

	useEffect(() => {
		const inventoryId = ctx.inventoryId ?? '';
		const storeId = ctx.storeId;
		if (!inventoryId || storeId == null) {
			setPhase({ k: 'error', msg: 'Нет точки в ссылке. Отсканируйте QR у нужной точки на ПК.' });
			return;
		}
		let alive = true;
		void (async () => {
			try {
				const invs = await listInventories();
				if (!alive) return;
				const inv = invs.find((x) => x.id === inventoryId);
				if (!inv) {
					setPhase({ k: 'error', msg: 'Инвентаризация не найдена (возможно, удалена).' });
					return;
				}
				const point = inv.points.find((p) => p.storeId === storeId);
				if (!point) {
					setPhase({ k: 'error', msg: 'Точка не найдена в этой инвентаризации.' });
					return;
				}
				setPhase({ k: 'counting', point, sectionIds: inv.sectionIds });
			} catch (e: unknown) {
				if (alive) setPhase({ k: 'error', msg: String(e instanceof Error ? e.message : e) });
			}
		})();
		return () => {
			alive = false;
		};
	}, [ctx]);

	if (phase.k === 'loading') {
		return <Shell><p>Загрузка инвентаризации…</p></Shell>;
	}
	if (phase.k === 'error') {
		return <Shell><p className="error">⛔ {phase.msg}</p></Shell>;
	}
	if (phase.k === 'done') {
		return (
			<Shell>
				<div className="beta-banner ok">✅ Отчёт по точке отправлен. На ПК он уже виден — можно закрыть вкладку.</div>
			</Shell>
		);
	}

	const me = ctx.me ?? { id: '', name: '' };
	const { point, sectionIds } = phase;
	return (
		<InventoryCount
			inventoryId={ctx.inventoryId ?? ''}
			storeId={point.storeId}
			storeName={point.storeName}
			sectionIds={sectionIds}
			me={me}
			initialDraft={point.draft}
			mobile
			onBack={() => {
				/* на мобиле возврата к списку точек нет — точка задана QR */
			}}
			onSubmitted={(_result: InvResult) => setPhase({ k: 'done' })}
		/>
	);
}

function Shell({ children }: { children: JSX.Element }): JSX.Element {
	return (
		<div className="inv">
			<header>
				<h1>Инвентаризация</h1>
			</header>
			<section>{children}</section>
		</div>
	);
}
