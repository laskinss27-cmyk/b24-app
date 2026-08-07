import { Fragment } from 'react';
import { isWorkRow, type DealStage } from './b24.js';
import { dealProductLine } from './deal-product-row-values.js';
import type { EnrichedRow } from './deal-products-table-types.js';
import { DealProductGroupBand, DealStageSectionBand } from './DealProductsTableBands.js';

export function DealProductsTable({
	workingMode,
	summaryView,
	goods,
	works,
	goodsTotal,
	worksTotal,
	baseRows,
	stageSections,
	activeVariant,
	renderGoodsRows,
	renderWorkRow,
	onAddToStage,
	onRenameStage,
}: {
	workingMode: boolean;
	summaryView: boolean;
	goods: EnrichedRow[];
	works: EnrichedRow[];
	goodsTotal: number;
	worksTotal: number;
	baseRows: EnrichedRow[];
	stageSections: Array<{ stage: DealStage; number: number; rows: EnrichedRow[] }>;
	activeVariant: { name: string } | null;
	renderGoodsRows: (row: EnrichedRow) => JSX.Element[];
	renderWorkRow: (row: EnrichedRow) => JSX.Element;
	onAddToStage: (stageId: string, stageName: string) => void;
	onRenameStage: (stageId: string, stageName: string) => void;
}): JSX.Element {
	return (
		<div className="table-wrap">
			<table className="products-table">
				<thead>
					<tr>
						<th className="check-col" title={workingMode ? 'Выбор строк для действий' : undefined}></th>
						<th>Товар / работа</th>
						<th>Тип</th>
						<th className="num">Цена</th>
						<th className="num">Скидка</th>
						<th className="num">Кол-во</th>
						<th className="num">{workingMode ? 'Реализовано' : ''}</th>
						<th className="num">{workingMode ? 'К отгрузке' : ''}</th>
						<th className="num">Сумма</th>
						<th>Остатки по складам</th>
						<th>{workingMode ? 'Склад · статус' : 'Статус'}</th>
					</tr>
				</thead>
				<tbody>
					{summaryView ? <>
						{goods.length > 0 && <DealProductGroupBand label="Оборудование" count={goods.length} sum={goodsTotal} />}
						{goods.flatMap(renderGoodsRows)}
						{works.length > 0 && <DealProductGroupBand label="Работы и услуги" count={works.length} sum={worksTotal} />}
						{works.map(renderWorkRow)}
					</> : <>
						{(() => {
							const baseWorks = baseRows.filter((row) => isWorkRow(row.type));
							const baseGoods = baseRows.filter((row) => !isWorkRow(row.type));
							const all = [...baseGoods, ...baseWorks];
							return <Fragment key="base-deal">
								<DealStageSectionBand title={activeVariant && !workingMode ? activeVariant.name : 'Основная сделка'} subtitle="" rows={all} />
								{baseGoods.length > 0 && <DealProductGroupBand label="Оборудование" count={baseGoods.length} sum={baseGoods.reduce((sum, row) => sum + dealProductLine(row), 0)} />}
								{baseGoods.flatMap(renderGoodsRows)}
								{baseWorks.length > 0 && <DealProductGroupBand label="Работы и услуги" count={baseWorks.length} sum={baseWorks.reduce((sum, row) => sum + dealProductLine(row), 0)} />}
								{baseWorks.map(renderWorkRow)}
							</Fragment>;
						})()}
						{stageSections.map(({ stage, number, rows }) => {
							const at = new Date(stage.at);
							const when = Number.isNaN(at.getTime()) ? stage.at : at.toLocaleDateString('ru-RU');
							const stageName = stage.name?.trim() || `Этап ${number}`;
							const stageGoods = rows.filter((row) => !isWorkRow(row.type));
							const stageWorks = rows.filter((row) => isWorkRow(row.type));
							return <Fragment key={stage.id}>
								<DealStageSectionBand title={stageName} subtitle={`${when}${stage.byName ? ` · ${stage.byName}` : ''}`} rows={rows} onAddItems={() => onAddToStage(stage.id, stageName)} onRename={() => onRenameStage(stage.id, stageName)} />
								{stageGoods.length > 0 && <DealProductGroupBand label="Оборудование" count={stageGoods.length} sum={stageGoods.reduce((sum, row) => sum + dealProductLine(row), 0)} />}
								{stageGoods.flatMap(renderGoodsRows)}
								{stageWorks.length > 0 && <DealProductGroupBand label="Работы и услуги" count={stageWorks.length} sum={stageWorks.reduce((sum, row) => sum + dealProductLine(row), 0)} />}
								{stageWorks.map(renderWorkRow)}
							</Fragment>;
						})}
					</>}
				</tbody>
			</table>
		</div>
	);
}
