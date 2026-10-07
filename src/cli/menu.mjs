// ali-kiro — interactive numbered multi-select (readline).
// Non-TTY / --yes / --quiet → everything is selected automatically.
import readline from 'node:readline';
import { isTTY } from '../core/platform.mjs';

/**
 * @param {Array<{id:string,name:string,verifyCmd:string}>} items
 * @param {object} [opts]  { yes, quiet }
 * @returns {Promise<string[]>} selected ids in catalog order
 */
export async function selectFromCatalog(items, opts = {}) {
  const allIds = items.map((it) => it.id);
  if (!isTTY() || opts.yes || opts.quiet || items.length === 0) return allIds;

  const numbered = items.map((it, i) => ({ n: i + 1, it }));
  const prompt = [
    'Select AI coding assistants to install:',
    ...numbered.map(({ n, it }) => `  ${String(n).padStart(2)}. ${it.name}  (${it.verifyCmd})`),
    'Enter numbers (comma/space/range, e.g. 1,3 or 2-4), "a" for all, "q" to quit, empty = all:',
  ].join('\n');

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const done = (ids) => {
      rl.close();
      resolve(ids);
    };
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      done(allIds);
    });
    rl.question(`${prompt}\n`, (line) => {
      const raw = String(line || '').trim().toLowerCase();
      if (!raw || raw === 'a' || raw === 'all') return done(allIds);
      if (raw === 'q' || raw === 'quit') return done([]);
      const chosen = new Set();
      for (const tok of raw.split(/[\s,]+/).filter(Boolean)) {
        if (tok === 'a') {
          numbered.forEach((x) => chosen.add(x.it.id));
        } else if (/^\d+$/.test(tok)) {
          const hit = numbered.find((x) => x.n === Number(tok));
          if (hit) chosen.add(hit.it.id);
        } else if (/^\d+-\d+$/.test(tok)) {
          const [a, b] = tok.split('-').map(Number);
          for (let n = Math.min(a, b); n <= Math.max(a, b); n++) {
            const hit = numbered.find((x) => x.n === n);
            if (hit) chosen.add(hit.it.id);
          }
        }
      }
      done(allIds.filter((id) => chosen.has(id)));
    });
  });
}