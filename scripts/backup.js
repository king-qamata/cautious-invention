import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const source = resolve(process.env.DATA_FILE || 'data/mindset.json');
const target = resolve(process.argv[2] || `backups/mindset-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`Backup written to ${target}`);

