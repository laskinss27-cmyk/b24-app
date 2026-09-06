import type { AssortmentMatrixTemplate } from '../assortment-matrix-template-store.js';
import type { StoredDealContractDocument } from '../deal-contract-types.js';
import type { SavedReport } from '../report-builder/model.js';
import type { OperationLogEvent } from '../operation-log/model.js';
export const matrix: AssortmentMatrixTemplate = {
	id:'be5fe614-99d2-4f68-a4e8-a96d570d8881',name:'Матрица',from:'2026-09-01',to:'2026-09-06',salesScope:'all',
	selectedStores:['Дунайский','Основной'],rows:[{productId:7,category:'Камеры',segment:'СВН',toOrderQty:2.5,comment:''}],
	createdAt:'2026-09-06T00:00:00.000Z',updatedAt:'2026-09-06T00:00:00.000Z',createdBy:{id:'1',name:'Автор'},updatedBy:{id:'2',name:'Редактор'},
};
export const report: SavedReport = {
	id:'88036793-f12c-4bbf-9a48-496c2b51771c',name:'Отчёт',createdAt:matrix.createdAt,updatedAt:matrix.updatedAt,
	definition:{datasetId:'sales_deals',columns:['manager','goodsSum'],groupBy:['manager'],filters:{from:'2026-09-01',to:'2026-09-06',categoryIds:[]},sort:[{field:'goodsSum',direction:'desc'}]},
};
export const contract: StoredDealContractDocument = {
	id:'a41b559d-c7a3-4ae2-af2c-de84628181ce',dealId:71,contractNumber:'501',templateId:'supply',templateTitle:'Поставка',companyId:8,companyName:'Компания',customerName:'Покупатель',contractDate:'06.09.2026',contractDateIso:'2026-09-06',createdAt:matrix.createdAt,filename:'Договор.docx',vatRate:5,total:1234.56,
};
export const event: OperationLogEvent = {id:'event-1',occurredAt:matrix.createdAt,level:'info',area:'test',operation:'create',outcome:'success',summary:'Сохранено',actor:{id:'1',name:'Автор'},deal:{id:71,title:''},documents:['DN-1','DN-2'],details:{text:'001',number:1.5,flag:false}};
