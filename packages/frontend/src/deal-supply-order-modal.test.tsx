import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DealSupplyOrderModal } from './DealSupplyOrderModal.js';
import { requireSupplyOrderNote } from '@b24-app/shared';

function render(note: string) {
	const noop = () => {};
	return renderToStaticMarkup(<DealSupplyOrderModal rows={[{ id: '1', name: 'Монитор', measure: 'шт', remaining: 10 }]}
		stores={[]} busy={false} toStore="Склад" deadline="2099-09-09" minimumDate="2026-09-08" orderNote={note}
		formError={null} quantities={{ 1: '1' }} onClose={noop} onStoreChange={noop} onDeadlineChange={noop}
		onOrderNoteChange={noop} onQuantityChange={noop} onSubmit={noop} />);
}

test('supply form has only one mandatory comment and no per-item comment', () => {
	const html = render('   ');
	assert.equal((html.match(/<textarea/g) ?? []).length, 1);
	assert.match(html, /<textarea[^>]*required/);
	assert.doesNotMatch(html, /Комментарий к позиции/);
	assert.match(html, /<button[^>]*disabled=""[^>]*>Создать заказ/);
	assert.doesNotMatch(render('Для монтажа'), /<button[^>]*disabled=""[^>]*>Создать заказ/);
});

test('common note validation rejects missing, whitespace, wrong type and oversized values', () => {
	for (const value of [undefined, null, '', ' \n\t ', {}, 123]) assert.throws(() => requireSupplyOrderNote(value), /Заполните общий/);
	assert.throws(() => requireSupplyOrderNote('x'.repeat(501)), /500/);
	assert.equal(requireSupplyOrderNote('  Для объекта\nДоставка утром  '), 'Для объекта\nДоставка утром');
	assert.equal(requireSupplyOrderNote('x'.repeat(500)).length, 500);
});
