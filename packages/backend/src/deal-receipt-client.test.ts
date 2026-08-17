import assert from 'node:assert/strict';
import test from 'node:test';
import { contactCaption, receiptContactId } from './deal-receipt-client.js';

test('receipt uses the first additional deal contact instead of the primary contact', () => {
	assert.equal(receiptContactId([
		{ CONTACT_ID: '12926', IS_PRIMARY: 'Y', SORT: 10 },
		{ CONTACT_ID: '17148', IS_PRIMARY: 'N', SORT: 20 },
	], 12926), 17148);
});

test('receipt falls back to the primary contact when no additional participant exists', () => {
	assert.equal(receiptContactId([{ CONTACT_ID: '12926', IS_PRIMARY: 'Y', SORT: 10 }], 12926), 12926);
	assert.equal(receiptContactId([], 12926), 12926);
});

test('contact caption follows the displayed Bitrix name order and keeps the first phone', () => {
	assert.deepEqual(contactCaption({
		LAST_NAME: 'Дмитрий',
		NAME: 'Сакирин',
		PHONE: [{ VALUE: '+7 921 941-01-34' }],
	}), { name: 'Дмитрий Сакирин', phone: '+7 921 941-01-34' });
});

test('contact caption does not reverse a two-part name entered in Bitrix', () => {
	assert.deepEqual(contactCaption({
		LAST_NAME: 'Наталья',
		NAME: 'Николаевна',
	}), { name: 'Наталья Николаевна', phone: '' });
});

test('contact caption includes the patronymic when Bitrix stores all three parts', () => {
	assert.deepEqual(contactCaption({
		LAST_NAME: 'Иванов',
		NAME: 'Иван',
		SECOND_NAME: 'Иванович',
	}), { name: 'Иванов Иван Иванович', phone: '' });
});
