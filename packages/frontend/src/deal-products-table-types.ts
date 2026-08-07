import type {
	CoreRealization,
	DealPlanItem,
	DealProductRow,
	DealQuoteVariants,
	DealStage,
	StoreInfo,
	StoredDealContractDocument,
	SupplyCard,
} from './b24.js';

export interface EnrichedRow extends DealProductRow {
	stocks: Array<{ storeId: number; storeName: string; amount: number }>;
	purchasingPrice: number | null;
	/** В режиме по этапам одна агрегированная строка плана раскладывается на отдельные партии. */
	segmentKind?: 'base' | 'stage';
	stageId?: string;
	stageNumber?: number;
}

export interface TableData {
	rows: EnrichedRow[];
	coef: number;
	/** Реализации сделки ИЗ ЯДРА (Delivery Note по b24_deal_id): черновики + проведённые. */
	coreReals: CoreRealization[];
	/** Состав сделки ИЗ ЯДРА (план = строки черновика Sales Order) — сырой ответ ядра. */
	plan: DealPlanItem[];
	/** Товары сделки = строки плана, приведённые к формату таблицы (с остатками) — на них работает движок реализации. */
	planRows: EnrichedRow[];
	/** Оплата заказа сделки (из Б24): total/paid. null — заказа/оплаты нет. */
	payment: { total: number; paid: number } | null;
	/** Склад-источник сделки (из резервов заказа) — дефолт «Склада реализации». null — нет. */
	sourceStoreId: number | null;
	/** Заявки снабжения сделки. */
	supply: SupplyCard[];
	/** Сохранённые версии договоров, сформированные нашим конструктором. */
	contracts: StoredDealContractDocument[];
	/** Активные склады каталога. */
	stores: StoreInfo[];
	/** Дополнительные этапы комплектации сделки. */
	stages: DealStage[];
	/** Альтернативные комплектации КП. Старые сделки: enabled=false. */
	quoteVariants: DealQuoteVariants;
	variantRows: Record<string, EnrichedRow[]>;
}
