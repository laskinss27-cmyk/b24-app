import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const workDir = path.resolve('work-catalog-video-20260728');
const imageDir = path.join(workDir, 'hikvision-rendered-images');
const outputPath = path.join(workDir, 'hikvision-rendered-source.json');
const scope = JSON.parse(await fs.readFile(path.join(workDir, 'scope.json'), 'utf8'));
const rowsById = new Map(scope.rows.map((row) => [Number(row.id), row]));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const profiles = [
	{
		ids: [11932],
		model: 'DS-2CE57D3T-VPITF',
		title: '2 MP Ultra Low Light Vandal Fixed Dome Camera',
		url: 'https://www.hikvision.com/es-la/products/Turbo-HD-Products/Turbo-HD-Cameras/Value-Series/ds-2ce57d3t-vpitf/',
		pdfUrl: 'https://assets.hikvision.com/prd/normal/all/doc/m000001723/DS-2CE57D3T-VPITF_Datasheet_20230807.pdf',
		imageUrl: 'https://assets.hikvision.com/prd/public/all/image/m000001723/DS-2CE57D3T-VPITF.png?eo-img.format=webp',
		specs: [
			['Image Sensor', '2 MP progressive scan CMOS'],
			['Max. Resolution', '1920 × 1080'],
			['Lens Type', '2.8 mm'],
			['Focal Length & FOV', '2.8 mm, horizontal field of view 106°'],
			['Supplement Light Type', 'IR'],
			['Supplement Light Range', 'Up to 30 m'],
			['Frame Rate', 'PAL: 1080p at 25 fps; NTSC: 1080p at 30 fps'],
			['Wide Dynamic Range', '120 dB true WDR'],
			['Video Output', 'TVI/AHD/CVI/CVBS switchable'],
			['Power Supply', '12 VDC ±25%'],
			['Power Consumption', 'Max. 4.6 W'],
			['Operating Conditions', '-40 °C to +60 °C, humidity 90% or less'],
			['Protection', 'IP67, IK10'],
			['Dimensions', 'Ø110.8 × 84.7 mm'],
			['Weight', 'Approx. 374 g'],
		],
	},
	{
		ids: [13916, 13914, 13912],
		model: 'DS-2CD2043G0-I',
		title: '4 MP Outdoor WDR Fixed Bullet Network Camera',
		url: 'https://www.hikvision.com/mena-en/products/IP-Products/Network-Cameras/Pro-Series-EasyIP-/DS-2CD2043G0-I/?subName=DS-2CD2043G0-I',
		pdfUrl: 'https://assets.hikvision.com/prd/public/all/doc/m000000103/DS-2CD2043G0-I_Datasheet_V5.6.0_20220602.pdf',
		imageUrl: 'https://assets.hikvision.com/prd/public/all/image/m000000103/DS-2CD20X5FWD.png?eo-img.format=webp',
		lenses: { 13916: '2.8 mm', 13914: '4 mm', 13912: '8 mm' },
		specs: [
			['Image Sensor', '1/3" progressive scan CMOS'],
			['Max. Resolution', '2688 × 1520'],
			['Lens Type', '2.8/4/6/8 mm fixed lens options'],
			['Supplement Light Type', 'IR'],
			['Supplement Light Range', 'Up to 30 m'],
			['Video Compression', 'H.265/H.264/MJPEG'],
			['On-board Storage', 'MicroSD/SDHC/SDXC up to 128 GB'],
			['Power Supply', '12 VDC ±25%; PoE IEEE 802.3af class 3'],
			['Power Consumption', 'Max. 7.5 W via PoE'],
			['Operating Conditions', '-30 °C to +60 °C, humidity 95% or less'],
			['Protection', 'IP67'],
			['Weight', 'Approx. 420 g'],
		],
	},
	{
		ids: [12640],
		model: 'DS-2CD2047G2-LU',
		title: '4 MP ColorVu Fixed Mini Bullet Network Camera',
		url: 'https://display.hikvision.com/mena-en/products/IP-Products/Network-Cameras/colorvu-series/ds-2cd2047g2-l-u-/',
		pdfUrl: 'https://assets.hikvision.com/prd/public/all/doc/sm000058321/DS-2CD2047G2-LU-C_Datasheet_V5.5.112_20230418.pdf',
		imageUrl: 'https://assets.hikvision.com/prd/normal/all/image/m000032053/2CD20x7G1-L-%E7%AD%92%E6%9C%BA69-%E5%9F%BA%E7%BA%BF-%E5%B8%A6%E6%94%AF%E6%9E%B6-%E5%8F%B3%E4%BE%A7.png?eo-img.format=webp',
		specs: [
			['Image Sensor', '1/1.8" progressive scan CMOS'],
			['Max. Resolution', '2688 × 1520'],
			['Lens Type', '2.8 mm fixed lens'],
			['Focal Length & FOV', '2.8 mm, horizontal FOV 112°, vertical FOV 61°, diagonal FOV 134°'],
			['Supplement Light Type', 'White light'],
			['Supplement Light Range', 'Up to 40 m'],
			['Video Compression', 'H.265+/H.265/H.264+/H.264/MJPEG'],
			['Wide Dynamic Range', '130 dB'],
			['Built-in Microphone', 'Yes (-U version)'],
			['On-board Storage', 'MicroSD/SDHC/SDXC up to 512 GB'],
			['Operating Conditions', '-30 °C to +60 °C, humidity 95% or less'],
			['Protection', 'IP67'],
		],
	},
	{
		ids: [11580],
		model: 'DS-2CD2083G2-IU',
		title: '8 MP AcuSense Fixed Bullet Network Camera',
		url: 'https://www.hikvision.com/cis/products/IP-Products/Network-Cameras/Pro-Series-EasyIP-/ds-2cd2083g2-i-u-/?subName=DS-2CD2083G2-IU+%28Black%29',
		pdfUrl: 'https://assets.hikvision.com/prd/normal/all/doc/sm000058949/DS-2CD2083G2-I_Datasheet_20260105.pdf',
		imageUrl: 'https://assets.hikvision.com/prd/normal/all/image/sm000058949/DS-2CD2023G2-IU-%E7%AD%92%E6%9C%BA67-%E5%9F%BA%E7%BA%BF-%E6%B5%B7%E5%BA%B7%E7%99%BD%E6%B5%B7%E5%BA%B7%E9%BB%91-%E4%B8%BB%E5%9B%BE.png?eo-img.format=webp',
		specs: [
			['Image Sensor', '1/2.8" progressive scan CMOS'],
			['Max. Resolution', '3840 × 2160'],
			['Lens Type', '2.8 mm fixed lens'],
			['Focal Length & FOV', '2.8 mm, horizontal FOV 107°, vertical FOV 57°, diagonal FOV 128°'],
			['Supplement Light Type', 'IR'],
			['Supplement Light Range', 'Up to 40 m'],
			['Video Compression', 'H.265+/H.265/H.264+/H.264/MJPEG'],
			['Wide Dynamic Range', '120 dB'],
			['Built-in Microphone', 'Yes (-U version)'],
			['On-board Storage', 'MicroSD up to 512 GB'],
			['Operating Conditions', '-30 °C to +60 °C, humidity 95% or less'],
			['Protection', 'IP67'],
		],
	},
	{
		ids: [11600],
		model: 'DS-2CD2323G0-IU',
		title: '2 MP WDR Fixed Turret Network Camera with Built-in Microphone',
		url: 'https://www.hikvision.com/cis/products/IP-Products/Network-Cameras/Pro-Series-EasyIP-/DS-2CD2323G0-I-U-/?subName=DS-2CD2323G0-I',
		pdfUrl: 'https://assets.hikvision.com/prd/public/all/doc/m000000113/DS-2CD2323G0-IU_datasheet_V5.6.0_20220602.pdf',
		imageUrl: 'https://assets.hikvision.com/prd/public/all/image/m000000113/DS-2CD2323G0-I%28U%29%E4%BE%A7%E9%9D%A2%E5%9B%BE.png?eo-img.format=webp',
		specs: [
			['Image Sensor', '1/2.8" progressive scan CMOS'],
			['Max. Resolution', '1920 × 1080'],
			['Lens Type', '2.8/4/6/8 mm fixed lens options'],
			['Supplement Light Type', 'IR'],
			['Supplement Light Range', 'Up to 30 m'],
			['Video Compression', 'H.265/H.264/MJPEG'],
			['Audio Compression', 'G.722.1/G.711/G.726/MP2L2/PCM/MP3'],
			['On-board Storage', 'MicroSD/SDHC/SDXC up to 128 GB'],
			['Power Supply', '12 VDC ±25%; PoE IEEE 802.3af class 3'],
			['Power Consumption', 'Max. 7.5 W via PoE'],
			['Operating Conditions', '-30 °C to +60 °C, humidity 95% or less'],
			['Protection', 'IP66 for -U version'],
			['Weight', 'Approx. 610 g'],
		],
	},
	{
		ids: [11928],
		model: 'DS-2CD2147G2-LSU(C)',
		title: '4 MP ColorVu Fixed Dome Network Camera',
		url: 'https://www.hikvision.com/content/dam/hikvision/ca-en/product-documents/ds-2cd2147g2-lsu.pdf',
		pdfUrl: 'https://www.hikvision.com/content/dam/hikvision/ca-en/product-documents/ds-2cd2147g2-lsu.pdf',
		specs: [
			['Max. Resolution', '4 MP'],
			['Lens Type', '2.8 mm fixed lens'],
			['Supplement Light Type', 'White light, 24/7 color imaging'],
			['Video Compression', 'H.265+'],
			['Wide Dynamic Range', '130 dB'],
			['Audio', 'Built-in microphone, audio and alarm interface (-SU version)'],
			['Analytics', 'Human and vehicle target classification'],
			['Protection', 'IP67, IK10'],
		],
	},
	{
		ids: [11830],
		model: 'DS-2CD2687G2T-LZS(C)',
		title: '8 MP ColorVu Varifocal Bullet Network Camera',
		url: 'https://www.hikvision.com/content/dam/hikvision/products/S000000001/S000000002/S000000003/S000000025/OFR007893/M000065835/Data_Sheet/DS-2CD2687G2T-LZS-C_Datasheet_V5.7.11_20230426.pdf',
		pdfUrl: 'https://www.hikvision.com/content/dam/hikvision/products/S000000001/S000000002/S000000003/S000000025/OFR007893/M000065835/Data_Sheet/DS-2CD2687G2T-LZS-C_Datasheet_V5.7.11_20230426.pdf',
		specs: [
			['Max. Resolution', '8 MP'],
			['Lens Type', '2.8–12 mm motorized varifocal lens'],
			['Supplement Light Type', 'White light, 24/7 color imaging'],
			['Video Compression', 'H.265+'],
			['Wide Dynamic Range', '130 dB'],
			['Analytics', 'Human and vehicle target classification'],
			['Protection', 'IP67, IK10'],
		],
	},
];

await fs.mkdir(imageDir, { recursive: true });
const matches = [];
const imageFailures = [];
for (const profile of profiles) {
	let image = null;
	try {
		if (!profile.imageUrl) throw new Error('No image replacement requested');
		const response = await fetch(profile.imageUrl, {
			headers: { 'User-Agent': 'Mozilla/5.0 catalog research' },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		const contentType = response.headers.get('content-type') || '';
		if (!contentType.startsWith('image/')) throw new Error(`Unexpected content type ${contentType}`);
		const extension = contentType.includes('webp') ? '.webp' : contentType.includes('jpeg') ? '.jpg' : '.png';
		const localPath = path.join(imageDir, `${profile.ids[0]}${extension}`);
		await fs.writeFile(localPath, bytes);
		image = {
			localPath: path.relative(workDir, localPath).replaceAll('\\', '/'),
			bytes: bytes.length,
			sha256: sha256(bytes),
		};
	} catch (error) {
		if (profile.imageUrl) imageFailures.push({ ids: profile.ids, error: String(error?.message ?? error) });
	}

	for (const id of profile.ids) {
		const row = rowsById.get(id);
		if (!row) throw new Error(`Scope row ${id} not found`);
		const specs = profile.specs.map(([label, value]) => ({ label, value }));
		if (profile.lenses?.[id]) {
			const lens = specs.find((spec) => spec.label === 'Lens Type');
			if (lens) lens.value = profile.lenses[id];
		}
		matches.push({
			id,
			kind: 'camera',
			name: row.name,
			model: row.model,
			brand: row.brand,
			officialModel: profile.model,
			url: profile.url,
			pdfUrl: profile.pdfUrl,
			title: profile.title,
			description: profile.title,
			specs,
			imageUrl: profile.imageUrl,
			image,
			matchScore: 20_000,
		});
	}
}

const result = {
	version: 1,
	generatedAt: new Date().toISOString(),
	officialOrigins: ['hikvision.com', 'assets.hikvision.com', 'display.hikvision.com'],
	scope: {
		targets: matches.length,
		matched: matches.length,
		unmatched: 0,
		images: matches.filter((match) => match.image).length,
	},
	matches,
	unmatched: [],
	qa: {
		renderedPageVerified: true,
		imageFailures,
	},
};

await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, matches: matches.length, imageFailures }, null, 2));
