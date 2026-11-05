import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function withDefaults(source, defaults) {
  if (Array.isArray(defaults)) {
    return Array.isArray(source) ? source : [];
  }
  if (!defaults || typeof defaults !== 'object') {
    return source === undefined ? defaults : source;
  }
  const base = source && typeof source === 'object' ? source : {};
  const merged = { ...base };
  for (const [key, value] of Object.entries(defaults)) {
    if (merged[key] === undefined) {
      merged[key] = structuredClone(value);
      continue;
    }
    merged[key] = withDefaults(merged[key], value);
  }
  return merged;
}

export class JsonStore {
  constructor(filePath, seed) {
    this.filePath = filePath;
    this.seed = seed;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'));
      return withDefaults(data, this.seed);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.write(this.seed);
      return structuredClone(this.seed);
    }
  }

  async write(data) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmpPath, this.filePath);
  }

  async update(mutator) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const data = await this.read();
      const result = await mutator(data);
      await this.write(data);
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

