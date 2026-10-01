import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDealRealizationQuantityAvailable } from './deal-realization-quantity.js';

test('a fully returned old sale does not enlarge a new one-unit plan line', () => {
	const plan = [{ productId: 12668, qty: 1, lineKey: 'new-line' }];
	const history = [
		{ items: [{ productId: 12668, qty: 2, segmentId: 'base' }] },
		{ items: [{ productId: 12668, qty: -1, segmentId: 'base' }] },
		{ items: [{ productId: 12668, qty: -1, segmentId: 'base' }] },
	];
	assert.doesNotThrow(() => assertDealRealizationQuantityAvailable(plan, [], history, [
		{ productId: 12668, qty: 1, segmentId: 'line:new-line' },
	]));
	assert.throws(() => assertDealRealizationQuantityAvailable(plan, [], history, [
		{ productId: 12668, qty: 2, segmentId: 'line:new-line' },
	]), /в плане осталось 1, к реализации передано 2/);
});

test('existing drafts consume the remaining realization quantity', () => {
	assert.throws(() => assertDealRealizationQuantityAvailable(
		[{ productId: 42, qty: 2, lineKey: 'line-42' }],
		[],
		[{ items: [{ productId: 42, qty: 1, segmentId: 'line:line-42' }] }],
		[{ productId: 42, qty: 2, segmentId: 'line:line-42' }],
	), /в плане осталось 1, к реализации передано 2/);
});

test('legacy base delivery consumes a unique keyed line and allows only its remainder', () => {
 const plan = [{productId: 18510, qty: 4, lineKey: 'camera'}];
 const request = [{productId: 18510, qty: 4, segmentId: 'line:camera'}];
 const history = [{items: [{productId: 18510, qty: 4, segmentId: 'base'}]}];
 assert.throws(() => assertDealRealizationQuantityAvailable(plan, [], history, request), /осталось 0/);
 history[0]!.items[0]!.qty = 3;
 assert.doesNotThrow(() => assertDealRealizationQuantityAvailable(plan, [], history, [{...request[0]!,qty:1}]));
 assert.throws(() => assertDealRealizationQuantityAvailable(plan, [], history, [{...request[0]!,qty:2}]), /осталось 1/);
});

test('legacy returns release only their net quantity, and keyed deliveries still consume it', () => {
 const plan = [{productId: 42,qty:4,lineKey:'new'}];
 const history = [{items:[{productId:42,qty:4,segmentId:'base'},{productId:42,qty:-2,segmentId:'base'},{productId:42,qty:1,segmentId:'line:new'}]}];
 assert.doesNotThrow(() => assertDealRealizationQuantityAvailable(plan,[],history,[{productId:42,qty:1,segmentId:'line:new'}]));
 assert.throws(() => assertDealRealizationQuantityAvailable(plan,[],history,[{productId:42,qty:2,segmentId:'line:new'}]), /осталось 1/);
});

test('legacy sale is not guessed across repeated product lines, unknown active keys also block', () => {
 const plan = [{productId:42,qty:4,lineKey:'a'},{productId:42,qty:4,lineKey:'b'}];
 for (const segmentId of ['base','line:removed']) {
  assert.throws(() => assertDealRealizationQuantityAvailable(plan,[],[{items:[{productId:42,qty:1,segmentId}]}],[{productId:42,qty:1,segmentId:'line:a'}]), /однозначно связать/);
 }
});

test('legacy base does not consume a genuinely new stage, but product total cannot be exceeded', () => {
 const plan = [{productId:42,qty:6,lineKey:'a'}];
 const stages = [{id:'extra',items:[{productId:42,qty:2}]}];
 const history = [{items:[{productId:42,qty:4,segmentId:'base'}]}];
 assert.doesNotThrow(() => assertDealRealizationQuantityAvailable(plan,stages,history,[{productId:42,qty:2,segmentId:'stage:extra'}]));
 history[0]!.items[0]!.qty=5;
 assert.throws(() => assertDealRealizationQuantityAvailable(plan,stages,history,[{productId:42,qty:2,segmentId:'stage:extra'}]), /всего в плане осталось 1/);
});
