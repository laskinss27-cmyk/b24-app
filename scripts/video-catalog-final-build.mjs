import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const cameraPath = path.resolve('work-catalog-video-20260728/camera-master.json');
const recorderPath = path.resolve('work-catalog-video-20260728/recorder-master.json');
const outputPath = path.resolve('work-catalog-video-20260728/final-video-catalog.json');
const camera = JSON.parse(await fs.readFile(cameraPath, 'utf8'));
const recorder = JSON.parse(await fs.readFile(recorderPath, 'utf8'));
const products = [...camera.products, ...recorder.products];
const alreadyApplied = [...camera.alreadyApplied, ...recorder.alreadyApplied];
const blocked = [
	...camera.blocked.map((entry) => ({ ...entry, kind: 'camera' })),
	...recorder.blocked.map((entry) => ({ ...entry, kind: 'recorder' })),
];
const excluded = [
	...camera.excluded.map((entry) => ({ ...entry, kind: 'camera' })),
	...recorder.excluded.map((entry) => ({ ...entry, kind: 'recorder' })),
];

const allowedOrigins = new Set([
	'alti-group.ru',
	'amatek.su',
	'assets.hikvision.com',
	'born-shop.ru',
	'com-hikvision.ru',
	'ctv.market',
	'ctvcctv.ru',
	'dahuasystems.ru',
	'display.hikvision.com',
	'en.tiandy.com',
	'eurotechnology.az',
	'fox-cctv.ru',
	'gfcctv.ru',
	'hcsb.ru',
	'hik.ua',
	'hikvision.az',
	'hikvision.co.az',
	'hikvision.org.ua',
	'hiwatch.ru',
	'hiwatch.market',
	'iflow-tech.ru',
	'manualzz.com',
	'market-telecom.kz',
	'material.dahuasecurity.com',
	'materialfile.dahuasecurity.com',
	'mcgrp.ru',
	'redline-cctv.ru',
	'ru-hiwatch.com',
	'sale-sb.ru',
	'secumarket.ru',
	'systemelectronics.it',
	'tiandy.pl',
	'trassir.com',
	'trassir.ru',
	'umniydom.pro',
	'us-legacy.hikvision.com',
	'vencon.ua',
	'vstarcam.ru',
	'www.dahua.market',
	'www.dahuasecurity.com',
	'www.dns-shop.ru',
	'www.dssl.ru',
	'www.hikvision.com',
	'www.hikvisionindia.com',
	'www.hikvisionjapan.com',
	'www.kns.ru',
	'www.layta.ru',
	'www.mvideo.ru',
	'www.sourceipcameras.com',
	'www.systemelectronics.it',
	'www.technopark.ru',
	'www.telecamera.ru',
	'www.tiandy.com.tr',
	'www.tinko.ru',
]);

const errors = [];
const warnings = [];
const ids = new Set();
for (const product of products) {
	if (ids.has(product.productId)) errors.push({ type: 'duplicate_product_id', productId: product.productId });
	ids.add(product.productId);
	const expectedCategory = product.sourcePackage?.includes('recorder') || recorder.products.some((entry) => entry.productId === product.productId)
		? 'video_recorder'
		: 'camera';
	if (product.categoryKey !== expectedCategory) {
		errors.push({ type: 'category_mismatch', productId: product.productId, categoryKey: product.categoryKey, expectedCategory });
	}
	if (!(product.sourceUrls?.length)) errors.push({ type: 'missing_source', productId: product.productId });
	for (const sourceUrl of product.sourceUrls ?? []) {
		try {
			const origin = new URL(sourceUrl).hostname.toLowerCase();
			if (!allowedOrigins.has(origin)) errors.push({ type: 'non_official_source', productId: product.productId, sourceUrl });
		} catch {
			errors.push({ type: 'invalid_source_url', productId: product.productId, sourceUrl });
		}
	}
	const filterable = (product.attributes ?? []).filter((attribute) => attribute.filterable);
	if (!filterable.length) errors.push({ type: 'missing_filterable_attributes', productId: product.productId });
	for (const attribute of filterable) {
		if (/^(?:and video|standard|\(mm\s*\[?inch\]?\))$/iu.test(attribute.rawValue)
			|| /these technologies|detect\s+observe\s+recognize\s+identify/iu.test(attribute.rawValue)) {
			errors.push({ type: 'garbage_filter_value', productId: product.productId, key: attribute.key, value: attribute.rawValue });
		}
		if (attribute.type === 'number') {
			const value = attribute.numberValue;
			if (!Number.isFinite(value)) errors.push({ type: 'invalid_number', productId: product.productId, key: attribute.key, value });
			const limits = {
				illumination_distance: [0, 1000],
				view_angle: [0, 360],
				channel_count: [1, 512],
				incoming_bandwidth: [1, 5000],
				outgoing_bandwidth: [1, 5000],
				drive_bays: [1, 64],
				drive_capacity: [1, 1000],
				poe_ports: [1, 128],
				power_consumption: [0, 5000],
				weight: [0, 500000],
			};
			const baseKey = attribute.key.replace(/_\d+$/u, '');
			const limit = limits[baseKey];
			if (limit && (value < limit[0] || value > limit[1])) {
				errors.push({ type: 'number_out_of_range', productId: product.productId, key: attribute.key, value });
			}
		}
		if (attribute.type === 'range'
			&& (!Number.isFinite(attribute.numberMin)
				|| !Number.isFinite(attribute.numberMax)
				|| attribute.numberMin > attribute.numberMax
				|| attribute.numberMin < -100
				|| attribute.numberMax > 150)) {
			errors.push({
				type: 'invalid_range',
				productId: product.productId,
				key: attribute.key,
				min: attribute.numberMin,
				max: attribute.numberMax,
			});
		}
	}
	if (product.image?.localPath) {
		const imagePath = path.resolve(product.image.localPath);
		try {
			const buffer = await fs.readFile(imagePath);
			const hash = createHash('sha256').update(buffer).digest('hex');
			if (buffer.length < 5000) warnings.push({ type: 'small_image', productId: product.productId, bytes: buffer.length });
			if (product.image.sha256 && product.image.sha256 !== hash) {
				errors.push({ type: 'image_hash_mismatch', productId: product.productId, localPath: product.image.localPath });
			}
		} catch {
			errors.push({ type: 'missing_image_file', productId: product.productId, localPath: product.image.localPath });
		}
	}
}

const imageGroups = new Map();
for (const product of products.filter((entry) => entry.image?.sha256)) {
	const group = imageGroups.get(product.image.sha256) ?? [];
	group.push(product.productId);
	imageGroups.set(product.image.sha256, group);
}
for (const [sha256, productIds] of imageGroups) {
	if (productIds.length >= 5) warnings.push({ type: 'reused_official_image', sha256, productIds });
}

const totalScope = camera.scope.total + recorder.scope.total;
const classified = products.length + alreadyApplied.length + blocked.length + excluded.length;
if (classified !== totalScope) errors.push({ type: 'incomplete_classification', classified, totalScope });

const result = {
	version: 1,
	generatedAt: new Date().toISOString(),
	scope: {
		total: totalScope,
		prepared: products.length,
		alreadyApplied: alreadyApplied.length,
		blocked: blocked.length,
		excluded: excluded.length,
		classified,
		cameras: camera.scope,
		recorders: recorder.scope,
		officialImageReplacements: products.filter((product) => product.image).length,
		imagesKept: products.filter((product) => product.keepExistingImage).length,
	},
	products,
	alreadyApplied,
	blocked,
	excluded,
	sourcePackages: [...camera.sourcePackages, ...recorder.sourcePackages],
	qa: {
		passed: errors.length === 0,
		errors,
		warnings,
		officialSourceOrigins: [...new Set([
			...camera.qa.sourceOrigins,
			...recorder.qa.sourceOrigins,
		])].sort(),
	},
};

await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, scope: result.scope, qa: result.qa }, null, 2));
if (errors.length) process.exitCode = 1;
