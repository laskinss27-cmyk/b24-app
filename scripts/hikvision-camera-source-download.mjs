import fs from 'node:fs/promises';
import path from 'node:path';

const outputDir = path.resolve('tmp/pdfs/hikvision-wave1');
const sources = [
	['ds-2cd2522fwd-is.pdf', 'https://us-legacy.hikvision.com/sites/default/files/data_sheet/10370_ninformationproductinformation05dsdatasheetssourcefiles8currentdatasheetsvpvalueplusvpds2cd2522fwdisseriesvpds2cd2522fwdisseries122016us.pdf'],
	['ds-2cd2543g0-is.pdf', 'https://assets.hikvision.com/prd/public/all/doc/sm000058548/DS-2CD2543G0-IWS-D_Datasheet_V5.6.5_20220602.pdf'],
	['ds-2cd2047g2h-liu.pdf', 'https://assets.hikvision.com/prd/normal/all/doc/sm000051119/DS-2CD2047G2H-LI_Datasheet_20260105.pdf'],
	['ds-2cd2432f-iw.pdf', 'https://us-legacy.hikvision.com/sites/default/files/data_sheet/10153_cusersrick.kitamuradesktopwfds2cd2432fiw050217na.pdf'],
	['ds-2de2a404iw-de3.pdf', 'https://assets.hikvision.com/prd/public/all/doc/m000045324/DS-2DE2A404IW-DE3S6-C_Datasheet_20250226.pdf'],
	['ds-2cd2022wd-i.pdf', 'https://us-legacy.hikvision.com/sites/default/files/data_sheet/10132_ninformationproductinformation05dsdatasheetssourcefiles8currentdatasheetsvpvalueplusvpds2cd2022wdivpds2cd2022wdi122116na.pdf'],
	['ds-2cd2043g2-iu.pdf', 'https://assets.hikvision.com/prd/public/all/doc/m000037850/DS-2CD2043G2-IU_Datasheet_V5.5.113_20230303.pdf'],
	['ds-2cd2087g2-lu.pdf', 'https://assets.hikvision.com/prd/public/all/doc/sm000064598/DS-2CD2087G2-LU-C_Datasheet_V5.5.115_20230418.pdf'],
	['hikvision-pro-iberia-2022.pdf', 'https://www.hikvision.com/content/dam/hikvision/es/cat%C3%A1logos-y-folletos/espa%C3%B1ol/Catalogue-PRO-Iberia-2022.pdf'],
	['ds-2cd2683g2-izs.pdf', 'https://assets.hikvision.com/prd/public/all/doc/sm000058894/DS-2CD2683G2-IZS_Datasheet_V5.5.113_20230303.pdf'],
	['ds-2cd2683g2-lizs2u.pdf', 'https://assets.hikvision.com/prd/normal/all/doc/m000117799/de-de/DS-2CD2683G2-LIZS2U_Datasheet_20250716.pdf'],
	['ds-2cd2t87g2-l.pdf', 'https://assets.hikvision.com/prd/public/all/doc/sm000064614/DS-2CD2T87G2-L-C_Datasheet_V5.5.115_20230418.pdf'],
	['ds-2de5225w-ae.pdf', 'https://assets.hikvision.com/prd/public/all/doc/m000048401/Datasheet-of-DS-2DE5225W-AES6_V5.7.1_20220714.pdf'],
	['ds-i215.pdf', 'https://assets.hikvision.com/prd/public/all/doc/m000057139/RU_Datasheet-of-DS-I215D_V5.7.1_20210722_211111_220512.pdf'],
];

await fs.mkdir(outputDir, { recursive: true });
const downloaded = [];
const failed = [];
for (const [fileName, sourceUrl] of sources) {
	try {
		const url = new URL(sourceUrl);
		if (!/(^|\.)hikvision\.com$/i.test(url.hostname)) {
			throw new Error(`Non-Hikvision source blocked: ${url.hostname}`);
		}
		const response = await fetch(url, {
			headers: {
				'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36',
				accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
			},
			redirect: 'follow',
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.subarray(0, 4).toString('ascii') !== '%PDF') {
			throw new Error('source is not a PDF');
		}
		await fs.writeFile(path.join(outputDir, fileName), buffer);
		downloaded.push({ fileName, bytes: buffer.length, sourceUrl });
	} catch (error) {
		failed.push({ fileName, sourceUrl, error: error instanceof Error ? error.message : String(error) });
	}
}

console.log(JSON.stringify({ outputDir, downloaded, failed }, null, 2));
if (downloaded.length === 0) process.exitCode = 1;
