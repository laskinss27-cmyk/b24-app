import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { catalogCopyFields } from './catalog-product-copy.js';
import { NewCatalogProductModal } from './NewCatalogProductModal.js';
import type { BaseRow } from './product-catalog.js';
const row: BaseRow = { id: 10, name: 'Комплект камер', iblockId: 24, isService: false, isMarketplaceBundle: true, model: 'KIT', manufacturer: 'Brand', article: 'ART', sectionId: 1, sectionName: 'Камеры', retail: 100, purchase: null, photoPath: '/old-photo.jpg', total: 20, stockByStore: { 1: 20 }, reservedByStore: { 1: 4 }, marketplaceOldId: 'OLD', content: { version: 1, summary: 'Описание', attributes: [{ id: 'a', key: 'wifi', label: 'Wi-Fi', type: 'boolean', rawValue: 'Да', normalizedValue: 'true', group: 'Связь', unit: '', filterable: true, numberValue: null, numberMin: null, numberMax: null, booleanValue: true }] } };
test('copy fields preserve editable content with independent attributes and no photo, stock, identity or unknown-price zero', () => {
 const value = catalogCopyFields(row); assert.equal(value.name, row.name); assert.equal(value.purchase, ''); assert.equal(value.attributes[0]?.rawValue, 'Да');
 for (const key of ['id', 'photoPath', 'stockByStore', 'reservedByStore', 'marketplaceOldId', 'total']) assert.equal(key in value, false);
 value.attributes[0]!.rawValue = 'Нет'; assert.equal(row.content?.attributes[0]?.rawValue, 'Да');
});
test('copy form renders editable bundle, content and full name without photo upload or original image', () => {
 const html = renderToStaticMarkup(<NewCatalogProductModal rows={[row, { ...row, id: 11, name: 'Камера', isMarketplaceBundle: false }]} initialQuery="" copyDraft={{ row, bundle: { sourceProductId: 11, units: 3 } }} onClose={() => {}} onUse={() => {}} />);
 assert.match(html, /Копия карточки без фото/); assert.match(html, /Название новой карточки/); assert.match(html, /Состав комплекта/); assert.match(html, /Штук в комплекте/); assert.match(html, /Описание/); assert.doesNotMatch(html, /old-photo|type="file"/);
});
