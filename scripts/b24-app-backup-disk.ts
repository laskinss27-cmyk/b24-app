/**
 * Uploads one verified b24_app dump/checksum pair to an isolated Bitrix24 Disk folder.
 * The upload is read back and hashed before strict, folder-local retention is applied.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { request } from 'undici';

const webhook = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');
const dumpPath = process.argv[2] ?? '';
const checksumPath = process.argv[3] ?? '';

const folderName = 'b24_app_backups';
const maxBackups = 14;
const dumpNamePattern = /^\d{8}_\d{6}-b24_app-database\.sql\.gz$/;

type DiskItem = {
  ID?: number | string;
  NAME?: string;
  TYPE?: string;
  SIZE?: number | string;
  DOWNLOAD_URL?: string;
};

type B24Response<T> = {
  result?: T;
  next?: number;
  error?: string;
  error_description?: string;
};

function fail(message: string): never {
  throw new Error(message);
}

async function b24<T>(method: string, params: Record<string, unknown>): Promise<B24Response<T>> {
  const response = await request(`${webhook}/${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    headersTimeout: 120_000,
    bodyTimeout: 120_000,
  });
  const body = (await response.body.json()) as B24Response<T>;
  if (body.error) {
    fail(`${method}: ${body.error}: ${body.error_description ?? ''}`);
  }
  return body;
}

async function allChildren(method: string, id: number): Promise<DiskItem[]> {
  const items: DiskItem[] = [];
  let start = 0;
  for (;;) {
    const response = await b24<DiskItem[]>(method, { id, start });
    items.push(...(response.result ?? []));
    if (response.next === undefined) return items;
    start = response.next;
  }
}

async function storageId(): Promise<number> {
  try {
    const response = await b24<DiskItem>('disk.storage.getforapp', {});
    const id = Number(response.result?.ID);
    if (id > 0) return id;
  } catch {
    // The production uploader already uses the same fallback for webhook storage.
  }
  const response = await b24<DiskItem[]>('disk.storage.getlist', {});
  const id = Number(response.result?.[0]?.ID);
  if (!(id > 0)) fail('Bitrix24 Disk storage was not found');
  return id;
}

async function backupFolderId(storage: number): Promise<number> {
  const rootItems = await allChildren('disk.storage.getchildren', storage);
  const matching = rootItems.filter((item) => item.NAME === folderName && item.TYPE === 'folder');
  if (matching.length > 1) fail(`more than one ${folderName} folder exists`);
  if (matching.length === 1) return Number(matching[0]?.ID);

  const response = await b24<DiskItem>('disk.storage.addfolder', {
    id: storage,
    data: { NAME: folderName },
  });
  const id = Number(response.result?.ID);
  if (!(id > 0) || response.result?.NAME !== folderName) {
    fail(`failed to create ${folderName} folder`);
  }
  return id;
}

function localSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function remoteSha256(downloadUrl: string): Promise<string> {
  const response = await request(downloadUrl, {
    method: 'GET',
    headersTimeout: 120_000,
    bodyTimeout: 120_000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    fail(`Bitrix24 Disk read-back failed with HTTP ${response.statusCode}`);
  }
  const content = Buffer.from(await response.body.arrayBuffer());
  return createHash('sha256').update(content).digest('hex');
}

async function uploadAndVerify(folderId: number, path: string): Promise<DiskItem> {
  const name = basename(path);
  const size = statSync(path).size;
  const content = readFileSync(path).toString('base64');
  const response = await b24<DiskItem>('disk.folder.uploadfile', {
    id: folderId,
    data: { NAME: name },
    fileContent: [name, content],
    generateUniqueName: false,
  });
  const uploadedId = Number(response.result?.ID);
  if (!(uploadedId > 0)) fail(`upload returned no ID for ${name}`);

  const readBackResponse = await b24<DiskItem>('disk.file.get', { id: uploadedId });
  const readBack = readBackResponse.result;
  if (readBack?.NAME !== name || Number(readBack.SIZE) !== size || !readBack.DOWNLOAD_URL) {
    fail(`Bitrix24 Disk metadata mismatch for ${name}`);
  }
  if ((await remoteSha256(readBack.DOWNLOAD_URL)) !== localSha256(path)) {
    fail(`Bitrix24 Disk SHA-256 mismatch for ${name}`);
  }
  return readBack;
}

async function applyRetention(folderId: number): Promise<void> {
  const children = await allChildren('disk.folder.getchildren', folderId);
  const byName = new Map(children.filter((item) => item.TYPE === 'file').map((item) => [item.NAME ?? '', item]));
  const dumpNames = [...byName.keys()].filter((name) => dumpNamePattern.test(name)).sort().reverse();

  for (const dumpName of dumpNames.slice(maxBackups)) {
    const checksumName = `${dumpName}.sha256`;
    const dump = byName.get(dumpName);
    const checksum = byName.get(checksumName);
    if (!dump || !checksum) fail(`refusing retention for incomplete pair: ${dumpName}`);
    await b24<unknown>('disk.file.delete', { id: Number(dump.ID) });
    await b24<unknown>('disk.file.delete', { id: Number(checksum.ID) });
    console.log(`disk retention removed: ${dumpName}`);
  }
}

async function main(): Promise<void> {
  if (!webhook) fail('DEV_WEBHOOK is missing');
  const dumpName = basename(dumpPath);
  if (!dumpNamePattern.test(dumpName) || checksumPath !== `${dumpPath}.sha256`) {
    fail('expected one b24_app dump and its adjacent .sha256 file');
  }

  const storage = await storageId();
  const folder = await backupFolderId(storage);
  const existing = await allChildren('disk.folder.getchildren', folder);
  const requestedNames = new Set([dumpName, basename(checksumPath)]);
  if (existing.some((item) => requestedNames.has(item.NAME ?? ''))) {
    fail('refusing to overwrite an existing Bitrix24 Disk backup file');
  }

  const checksum = await uploadAndVerify(folder, checksumPath);
  const dump = await uploadAndVerify(folder, dumpPath);
  await applyRetention(folder);
  console.log(`disk verified: dump_id=${dump.ID} checksum_id=${checksum.ID} name=${dumpName}`);
}

main().catch((error) => {
  console.error(`b24_app disk FATAL: ${String(error).slice(0, 300)}`);
  process.exit(1);
});
