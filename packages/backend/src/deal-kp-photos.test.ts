import assert from 'node:assert/strict';
import test from 'node:test';
import { dealKpPhotoUrl } from './deal-kp-photos.js';

test('builds authenticated photo URL only for the current Bitrix portal', () => {
	const auth = { domain: 'company.bitrix24.ru', accessToken: 'secret token' };
	const relative = dealKpPhotoUrl('/bitrix/tools/disk/uf.php?fileId=42', auth);
	assert.equal(relative?.origin, 'https://company.bitrix24.ru');
	assert.equal(relative?.searchParams.get('fileId'), '42');
	assert.equal(relative?.searchParams.get('auth'), 'secret token');

	const absolute = dealKpPhotoUrl('https://company.bitrix24.ru/photo.png', auth);
	assert.equal(absolute?.searchParams.get('auth'), 'secret token');
	assert.equal(dealKpPhotoUrl('https://attacker.example/photo.png', auth), null);
	assert.equal(dealKpPhotoUrl('http://company.bitrix24.ru/photo.png', auth), null);
});
