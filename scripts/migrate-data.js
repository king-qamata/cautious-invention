import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { runDataMigrations } from '../src/migrations.js';

const target = resolve(process.env.DATA_FILE || 'data/mindset.json');

const raw = await readFile(target, 'utf8');
const data = JSON.parse(raw);
const report = runDataMigrations(data);
await writeFile(target, `${JSON.stringify(data, null, 2)}\n`);

console.log('Data migration completed.');
console.log(JSON.stringify(report, null, 2));
