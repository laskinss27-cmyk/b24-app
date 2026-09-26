// Production maintenance entry point, restored into version control.
import { backupQueue, inspectQueue, verifySnapshot } from './maintenance.js';
async function main() {
    const command = process.argv[2], path = process.env['UMNIYDOM_ORDERS_DB'];
    if (!path || path === ':memory:') throw Error('A persistent orders database is required');
    if (command === 'status') console.log(JSON.stringify(inspectQueue(path)));
    else if (command === 'verify') console.log(JSON.stringify(verifySnapshot(path)));
    else if (command === 'backup' && process.argv[3]) console.log(JSON.stringify(await backupQueue(path, process.argv[3])));
    else throw Error('Expected status, verify or backup <new-directory>');
}
main().catch(() => { console.error('Orders maintenance failed; verify database, permissions and a new backup directory.'); process.exitCode = 1; });
