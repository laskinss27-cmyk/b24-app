import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolConnection } from 'mariadb';
import type { B24Client } from '../b24/client.js';
import { MatrixFileSchema } from '../assortment-matrix-template-store.js';
import { ReportStoreFileSchema } from '../report-builder/store.js';
import { validateReportDefinition } from '../report-builder/model.js';
import { isOperationLogEvent } from '../operation-log/model.js';
import { canonical, contentHash, encode } from './codec.js';
import { empty, modules, type Module } from './schema.js';
import { head, locked, readState, validateOwner, writeState } from './store.js';
import { parseRealizationMemory, readRealizationSource } from './realizations.js';

export interface Collection { module: Module; owner: string; value: unknown }
export interface FileManifest { documentId: string; dealId: number; hash: string; size: number }
export interface StatePlan {
	version: 1; collections: Collection[]; files: FileManifest[];
	identities: Array<{shipmentId:number;externalId:number}>; sourceHash: string; planHash: string;
}
const rawHash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export function makePlan(input: Omit<StatePlan,'version'|'planHash'>): StatePlan {
	const keys = new Set<string>();
	for (const collection of input.collections) {
		validateOwner(collection.module,collection.owner); encode(collection.module,collection.value);
		const key = `${collection.module}:${collection.owner}`;
		if (keys.has(key)) throw new Error('Duplicate backfill collection'); keys.add(key);
	}
	for (const module of ['matrix','sequences','realizations','log']) if (!keys.has(`${module}:global`)) throw new Error('Incomplete source modules');
	const documents = new Map<string,number>();
	for (const collection of input.collections.filter(row=>row.module==='contracts')) {
		for (const document of collection.value as Array<{id:string;dealId:number}>) {
			if (documents.has(document.id) || String(document.dealId)!==collection.owner) throw new Error('Invalid contract ownership');
			documents.set(document.id,document.dealId);
		}
	}
	const fileIds = new Set<string>();
	for (const file of input.files) {
		if (fileIds.has(file.documentId) || documents.get(file.documentId)!==file.dealId || !/^[0-9a-f]{64}$/.test(file.hash) || !Number.isSafeInteger(file.size) || file.size<=0) throw new Error('Invalid file manifest');
		fileIds.add(file.documentId);
	}
	if (fileIds.size!==documents.size) throw new Error('Incomplete file manifests');
	const realizations = input.collections.find(row=>row.module==='realizations')!.value as Array<{shipmentId:number}>;
	const shipmentIds = new Set(realizations.map(row=>row.shipmentId)), identityIds = new Set<number>(), externalIds = new Set<number>();
	if (shipmentIds.size!==realizations.length) throw new Error('Duplicate shipment identity');
	for (const identity of input.identities) {
		if (!shipmentIds.has(identity.shipmentId) || identityIds.has(identity.shipmentId) || externalIds.has(identity.externalId) || !Number.isSafeInteger(identity.externalId) || identity.externalId<=0) throw new Error('Invalid realization identity');
		identityIds.add(identity.shipmentId); externalIds.add(identity.externalId);
	}
	if (identityIds.size!==shipmentIds.size) throw new Error('Incomplete realization identities');
	if (!/^[0-9a-f]{64}$/.test(input.sourceHash)) throw new Error('Invalid source hash');
	const body = { version:1 as const,...input };
	return {...body,planHash:contentHash(body)};
}
export interface SourcePaths { state: string; contracts: string; sequences: string }
export function sourcePaths(env = process.env): SourcePaths {
	return { state:env['B24_STATE_DIR'] ?? '/app/state', contracts:env['CONTRACT_DOCUMENTS_PATH'] ?? '/app/state/contracts', sequences:env['CONTRACT_SEQUENCE_PATH'] ?? '/app/state/contract-sequences.json' };
}
export async function readSourcePlan(client: B24Client, paths = sourcePaths()): Promise<StatePlan> {
	const evidence: Record<string,string | null> = {};
	async function bytes(path: string): Promise<Buffer> {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64*1024*1024) throw new Error('Invalid source file');
		const value = await readFile(path); evidence[path] = rawHash(value); return value;
	}
	async function optional(path: string): Promise<Buffer | null> {
		try { return await bytes(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; evidence[path] = null; return null; }
	}
	async function entries(path: string) {
		try {
			const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Invalid source directory');
			const result = await readdir(path,{withFileTypes:true});
			if (result.some(entry => entry.isSymbolicLink())) throw new Error('Source symlink');
			evidence[`${path}/`] = contentHash(result.map(entry => entry.name).sort());
			return result.sort((a,b) => a.name.localeCompare(b.name,'en'));
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; evidence[`${path}/`]=null; return []; }
	}
	const collections: Collection[] = [], files: FileManifest[] = [];
	const matrixBytes = await optional(join(paths.state,'assortment-matrix','templates.json'));
	const matrix = matrixBytes ? MatrixFileSchema.parse(JSON.parse(matrixBytes.toString())) : {templates:[]};
	collections.push({module:'matrix',owner:'global',value:matrix.templates});
	for (const template of matrix.templates) if (new Set(template.rows.map(row => row.productId)).size !== template.rows.length) throw new Error('Duplicate matrix product');
	for (const entry of await entries(join(paths.state,'report-builder'))) {
		if (!entry.isFile() || !/^\d{1,12}\.json$/.test(entry.name)) throw new Error('Unexpected report entry');
		const source = ReportStoreFileSchema.parse(JSON.parse((await bytes(join(paths.state,'report-builder',entry.name))).toString()));
		for (const report of source.reports) validateReportDefinition(report.definition);
		collections.push({module:'reports',owner:entry.name.slice(0,-5),value:source.reports});
	}
	const sequenceBytes = await optional(paths.sequences);
	const sequences = sequenceBytes ? JSON.parse(sequenceBytes.toString()) as Record<string,number> : {};
	if (!sequences || typeof sequences !== 'object' || Array.isArray(sequences)) throw new Error('Invalid sequence source');
	const options = await client.call<Record<string,unknown>>('app.option.get',{});
	const sequenceOptions = Object.fromEntries(Object.entries(options).filter(([key]) => key.startsWith('contract_seq_')));
	for (const [key,value] of Object.entries(sequenceOptions)) {
		if (!Number.isSafeInteger(Number(value)) || Number(value)<0) throw new Error('Invalid contract option');
		sequences[key] = Math.max(sequences[key] ?? 0,Number(value));
	}
	if (Object.entries(sequences).some(([key,value]) => !/^contract_seq_(?:inn_)?\d+$/.test(key) || !Number.isSafeInteger(value) || value<0)) throw new Error('Invalid sequence state');
	collections.push({module:'sequences',owner:'global',value:sequences});
	for (const entry of await entries(paths.contracts)) {
		if (!entry.isDirectory() || !/^\d{1,12}$/.test(entry.name)) throw new Error('Unexpected contract directory');
		const documents: Array<Record<string,unknown>> = [];
		const directory = join(paths.contracts,entry.name);
		const list = await entries(directory), names = new Set(list.map(file => file.name));
		for (const file of list) {
			if (!file.isFile()) throw new Error('Unexpected contract entry');
			if (/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.pending\.docx$/.test(file.name) || /^[0-9a-f-]{36}\.(?:json|docx)\.[0-9a-f.-]+\.tmp$/.test(file.name)) continue;
			if (file.name.endsWith('.json')) {
				const document = JSON.parse((await bytes(join(directory,file.name))).toString()) as Record<string,unknown>;
				if (String(document['dealId']) !== entry.name || `${document['id']}.json` !== file.name || !/^[0-9a-f-]{36}\.json$/.test(file.name)) throw new Error('Invalid contract identity');
				const docx = await bytes(join(directory,file.name.replace(/\.json$/,'.docx')));
				if (!docx.length) throw new Error('Empty DOCX');
				files.push({documentId:String(document['id']),dealId:Number(document['dealId']),hash:rawHash(docx),size:docx.length});
				documents.push(document);
			} else if (!file.name.endsWith('.docx') || !names.has(file.name.replace(/\.docx$/,'.json'))) throw new Error('Orphan contract file');
		}
		documents.sort((a,b) => String(b['createdAt']).localeCompare(String(a['createdAt'])) || String(a['id']).localeCompare(String(b['id'])));
		collections.push({module:'contracts',owner:entry.name,value:documents});
	}
	const logBytes = await optional(join(paths.state,'operation-log','events.jsonl'));
	const events = (logBytes?.toString() ?? '').split('\n').filter(line=>line.trim()).map(line => JSON.parse(line) as unknown);
	if (events.length>5000 || events.some(event=>!isOperationLogEvent(event))) throw new Error('Invalid operation log');
	collections.push({module:'log',owner:'global',value:events});
	const items = await readRealizationSource(client);
	const realizations = parseRealizationMemory(items);
	collections.push({module:'realizations',owner:'global',value:realizations});
	const identities = items.map(item => ({shipmentId:Number(JSON.parse(String(item['DETAIL_TEXT'])).shipmentId),externalId:Number(item['ID'])}));
	if (identities.some(identity=>!Number.isSafeInteger(identity.externalId) || identity.externalId<=0) || new Set(identities.map(identity=>identity.externalId)).size !== identities.length) throw new Error('Invalid source identity');
	return makePlan({collections,files,identities,sourceHash:contentHash({evidence,items,sequenceOptions})});
}
export async function comparePlan(c: PoolConnection, plan: StatePlan): Promise<{matches:boolean;differences:string[]}> {
	const differences: string[] = [];
	const expected = new Map(plan.collections.map(row=>[`${row.module}:${row.owner}`,row]));
	const actual = await c.query('SELECT module_name,owner_key FROM app_state_heads');
	for (const row of actual) if (!expected.has(`${row.module_name}:${row.owner_key}`) && contentHash(await readState(c,row.module_name,row.owner_key)) !== contentHash(empty(row.module_name))) differences.push(`${row.module_name}:extra_collection`);
	for (const row of plan.collections) if (contentHash(await readState(c,row.module,row.owner)) !== contentHash(row.value)) differences.push(`${row.module}:content`);
	const fileCount = await c.query('SELECT COUNT(*) AS n FROM app_contract_files');
	if (Number(fileCount[0].n)!==plan.files.length) differences.push('contracts:file_manifest_count');
	const identityCount = await c.query('SELECT COUNT(*) AS n FROM app_realization_identities');
	if (Number(identityCount[0].n)!==plan.identities.length) differences.push('realizations:identity_count');
	for (const file of plan.files) {
		const rows = await c.query('SELECT deal_id,file_hash,byte_length,status FROM app_contract_files WHERE document_id=?',[file.documentId]);
		if (rows.length!==1 || Number(rows[0].deal_id)!==file.dealId || rows[0].file_hash!==file.hash || Number(rows[0].byte_length)!==file.size || rows[0].status!=='ready') differences.push('contracts:file_manifest');
	}
	for (const identity of plan.identities) {
		const rows = await c.query('SELECT bitrix_external_id FROM app_realization_identities WHERE shipment_id=?',[identity.shipmentId]);
		if (rows.length!==1 || Number(rows[0].bitrix_external_id)!==identity.externalId) differences.push('realizations:identity');
	}
	return {matches:!differences.length,differences};
}
/** Read sources again under the same lock as all enabled runtime mutations. */
export async function applyPlan(pool: Pool, getFresh: () => Promise<StatePlan>, expectedHash: string) {
	return locked(pool,async c => {
		const plan = await getFresh(), second = await getFresh();
		if (plan.planHash!==expectedHash || second.planHash!==expectedHash || makePlan({collections:plan.collections,files:plan.files,identities:plan.identities,sourceHash:plan.sourceHash}).planHash!==expectedHash) throw new Error('Source changed or plan hash differs');
		await c.beginTransaction();
		try {
			const previous = await c.query('SELECT plan_hash FROM app_state_checkpoints WHERE plan_hash=?',[expectedHash]);
			if (previous.length) {
				if (!(await comparePlan(c,plan)).matches) throw new Error('Checkpoint exists but data differs');
				await c.commit(); return {applied:false,planHash:expectedHash};
			}
			for (const row of plan.collections) {
				const current = await head(c,row.module,row.owner);
				if (current.revision && canonical(await readState(c,row.module,row.owner))!==canonical(row.value)) throw new Error('SQL has a different revision; automatic overwrite forbidden');
				await writeState(c,row.module,row.owner,row.value,true);
			}
			for (const file of plan.files) {
				const rows = await c.query('SELECT document_id FROM app_contract_files WHERE document_id=?',[file.documentId]);
				if (!rows.length) await c.query('INSERT INTO app_contract_files(document_id,deal_id,file_hash,byte_length,status) VALUES (?,?,?,?,\'ready\')',[file.documentId,file.dealId,file.hash,file.size]);
			}
			for (const identity of plan.identities) {
				const rows = await c.query('SELECT shipment_id FROM app_realization_identities WHERE shipment_id=?',[identity.shipmentId]);
				if (!rows.length) await c.query('INSERT INTO app_realization_identities(shipment_id,bitrix_external_id) VALUES (?,?)',[identity.shipmentId,identity.externalId]);
			}
			if (!(await comparePlan(c,plan)).matches) throw new Error('Post-backfill parity failure');
			await c.query('INSERT INTO app_state_checkpoints(plan_hash,collection_count) VALUES (?,?)',[expectedHash,plan.collections.length]);
			for (const module of modules) await c.query('INSERT INTO app_state_module_gates(module_name,plan_hash) VALUES (?,?) ON DUPLICATE KEY UPDATE plan_hash=VALUES(plan_hash)',[module,expectedHash]);
			await c.commit(); return {applied:true,planHash:expectedHash};
		} catch(error) { await c.rollback(); throw error; }
	});
}
