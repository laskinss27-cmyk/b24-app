/** Verified uploader and ERPNext retention. See docs/core-backup-retention.md. */
import 'dotenv/config';
import { main } from './core-backup-retention.mjs';

main().catch((error: Error) => {
  console.error(`core backup failed: ${error.message}`);
  process.exitCode = 1;
});
