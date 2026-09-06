import { modules, nodes, schemas } from './schema.js';
/** Returns reviewable statements only. Never creates users or executes grants. */
export function remainingGrants(database: string, user: string, role: 'runtime' | 'backfill'): string[] {
	if (!/^[a-z][a-z0-9_]{0,63}$/.test(database) || !/^[a-z][a-z0-9_]{0,79}$/.test(user) || user==='root') throw new Error('Invalid SQL grant target');
	const grants: Record<string,string> = {
		app_state_heads:'SELECT, INSERT, UPDATE', app_state_revisions:'SELECT, INSERT',
		app_log_identities:'SELECT, INSERT', app_contract_commands:'SELECT, INSERT',
		app_contract_files:'SELECT, INSERT, UPDATE',app_realization_identities:'SELECT, INSERT, UPDATE',
		app_state_module_gates:role==='runtime'?'SELECT':'SELECT, INSERT, UPDATE',
	};
	if (role==='backfill') grants['app_state_checkpoints']='SELECT, INSERT';
	for(const module of modules) for(const node of nodes(schemas[module])) grants[node.table]='SELECT, INSERT';
	return Object.entries(grants).map(([table,permissions])=>`GRANT ${permissions} ON \`${database}\`.\`${table}\` TO '${user}'@'%';`);
}
