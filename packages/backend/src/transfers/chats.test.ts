import assert from 'node:assert/strict';
import test from 'node:test';
import { receivingChatStore, storeChat } from './chats.js';

test('routes stores to the new Админка по ТТ chats', () => {
	assert.equal(storeChat('Железноводская, секция 23'), 'chat4150');
	assert.equal(storeChat('Железноводская, секция 34'), 'chat17424');
	assert.equal(storeChat('Максидом Богатырский 15'), 'chat17416');
	assert.equal(storeChat('Максидом Дунайский 64'), 'chat17422');
	assert.equal(storeChat('Максидом Московский 131'), 'chat17420');
	assert.equal(storeChat('Максидом Тельмана 31'), 'chat17414');
	assert.equal(storeChat('Максидом ул. Фаворского 12'), 'chat17412');
});

test('normalizes a store name and selects the point that receives the transfer', () => {
	assert.equal(storeChat('Максидом Московский 131 - УД'), 'chat17420');
	assert.equal(receivingChatStore('Склад прихода', 'Максидом Дунайский 64'), 'Максидом Дунайский 64');
	assert.equal(receivingChatStore('Максидом Тельмана 31', 'Склад прихода'), 'Максидом Тельмана 31');
	assert.equal(receivingChatStore('Склад прихода', 'Маркетплейс'), null);
});
