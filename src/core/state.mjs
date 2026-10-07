// ali-kiro — atomic state persistence (~/.ali-kiro/state.json).
import fs from 'node:fs';
import path from 'node:path';

export async function writeState(statePath, data) {
  const dir = path.dirname(statePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, statePath); // atomic on the same filesystem
  return statePath;
}

export async function readState(statePath) {
  try {
    return JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
  } catch {
    return null;
  }
}