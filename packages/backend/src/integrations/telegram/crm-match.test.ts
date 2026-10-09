import test from 'node:test';
import assert from 'node:assert/strict';
import { newestOpenDeal, telegramPhone, type CrmReader } from './crm-match.js';
const reader = (call: (method: string, params: Record<string, unknown>) => unknown) => ({ call: async (m: string, p: Record<string, unknown> = {}) => call(m, p) }) as CrmReader;

test('Telegram phone matching requires a complete international number, never invents suffix/country matches', () => {
    assert.equal(telegramPhone('+7 (999) 123-45-67'), '+79991234567');
    for (const value of [undefined, '', '12345', '00079991234567', 'name', '+79991234567 ext 5']) assert.equal(telegramPhone(value), null);
});
test('Auto binding chooses newest creation date across contacts and leads, ID breaks ties, checks access/open state', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const client = reader((m, p) => {
        calls.push([m, p]);
        if (m === 'crm.duplicate.findbycomm') return p.entity_type === 'CONTACT' ? { CONTACT: [11, '12'] } : { LEAD: [22] };
        if (m === 'crm.item.list') {
            assert.deepEqual(p.order, { createdTime: 'DESC', id: 'DESC' });
            assert.equal((p.filter as Record<string, unknown>)['=stageSemanticId'], 'P');
            return { items: (p.filter as Record<string, unknown>)['@contactIds'] ? [
                { id: 999, createdTime: '2025-01-01T00:00:00Z', stageSemanticId: 'P', contactIds: [12] },
                { id: 100, createdTime: '2026-01-01T00:00:00Z', stageSemanticId: 'P', contactIds: [11] },
            ] : [{ id: 101, createdTime: '2026-01-01T00:00:00Z', stageSemanticId: 'P', leadId: 22 }] };
        }
        assert.deepEqual(p, { id: 101 });
        return { ID: '101', CLOSED: 'N', STAGE_SEMANTIC_ID: 'P' };
    });
    assert.equal(await newestOpenDeal(client, '79991234567'), 101);
    assert.equal(calls.length, 5);
});
test('No phone or no CRM customer never queries all deals', async () => {
    let calls = 0;
    const client = reader((m) => { calls++; assert.equal(m, 'crm.duplicate.findbycomm'); return {}; });
    assert.equal(await newestOpenDeal(client, ''), null); assert.equal(calls, 0);
    assert.equal(await newestOpenDeal(client, '+79991234567'), null); assert.equal(calls, 2);
});
test('Ignoring filters, malformed dates, closed deals and CRM lookup failures cannot create a binding', async () => {
    for (const bad of [
        { id: 1, contactIds: [99], stageSemanticId: 'P', createdTime: '2026-01-01' },
        { id: 1, contactIds: [11], stageSemanticId: 'S', createdTime: '2026-01-01' },
        { id: 1, contactIds: [11], stageSemanticId: 'P', createdTime: 'invalid' },
    ]) {
        const client = reader((m, p) => m === 'crm.duplicate.findbycomm' ? p.entity_type === 'CONTACT' ? { CONTACT: [11] } : {} : { items: [bad] });
        await assert.rejects(newestOpenDeal(client, '+79991234567'));
    }
    const client = reader(m => { if (m === 'crm.duplicate.findbycomm') throw new Error('ACCESS_DENIED'); return {}; });
    await assert.rejects(newestOpenDeal(client, '+79991234567'));
});
test('Deal closed between search and final check is not bound', async () => {
    const client = reader((m, p) => m === 'crm.duplicate.findbycomm' ? p.entity_type === 'CONTACT' ? { CONTACT: [11] } : {} : m === 'crm.item.list' ? { items: [{ id: 1, contactIds: [11], stageSemanticId: 'P', createdTime: '2026-01-01' }] } : { ID: '1', CLOSED: 'Y', STAGE_SEMANTIC_ID: 'S' });
    assert.equal(await newestOpenDeal(client, '+79991234567'), null);
});
test('Every duplicate chunk contributes its newest deal; no partial result on failed chunks', async () => {
    let chunks = 0;
    const client = reader((m, p) => {
        if (m === 'crm.duplicate.findbycomm') return p.entity_type === 'CONTACT' ? { CONTACT: Array.from({ length: 45 }, (_, i) => i + 1) } : {};
        if (m === 'crm.item.list') {
            chunks++;
            const contacts = (p.filter as Record<string, number[]>)['@contactIds']!;
            assert.ok(contacts.length <= 20);
            return { items: [{ id: chunks, contactIds: [contacts[0]], createdTime: `2026-01-0${chunks}`, stageSemanticId: 'P' }] };
        }
        return { ID: String(p.id), CLOSED: 'N', STAGE_SEMANTIC_ID: 'P' };
    });
    assert.equal(await newestOpenDeal(client, '+79991234567'), 3); assert.equal(chunks, 3);
});
