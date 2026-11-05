import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { seedDatabase } from '../src/domain.js';

const target = resolve(process.env.DATA_FILE || 'data/mindset.json');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(seedDatabase(), null, 2)}\n`);
console.log(`Seed data written to ${target}`);

