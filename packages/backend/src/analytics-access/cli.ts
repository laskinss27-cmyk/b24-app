/** Trusted server CLI; the secret is written once to a private file, never stdout/arguments. */
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AnalyticsKeyStore, analyticsStorePath } from './store.js';

const store = new AnalyticsKeyStore(analyticsStorePath());
try {
	const command = process.argv[2];
	let raw = ''; for await (const chunk of process.stdin) raw += String(chunk);
	const input: unknown = raw ? JSON.parse(raw) : {};
	let result: unknown;
	if (command === 'create') {
		const args = z.object({ ownerId: z.number().int().positive(), label: z.string().trim().min(1).max(160), output: z.string().refine(isAbsolute) }).strict().parse(input);
		const key = store.create(args.ownerId, args.label);
		try { await writeFile(args.output, JSON.stringify({ token: key.token }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
		catch (error) { store.revoke(key.id); throw error; }
		result = { id: key.id, ownerId: key.ownerId, label: key.label, output: args.output };
	} else if (command === 'revoke') {
		const args = z.object({ id: z.string().uuid() }).strict().parse(input);
		result = { revoked: store.revoke(args.id) };
	} else if (command === 'list') result = store.list();
	else throw new Error('Usage: create | list | revoke; JSON via stdin');
	process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); }
