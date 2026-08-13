/**
 * Normalize double-spaced recombinatorModel.js + run tests.
 * node scripts/normalize-and-test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recombPath = path.join(root, 'src/lib/recombinatorModel.js');
const raw = fs.readFileSync(recombPath, 'utf8');
const lines = raw.split(/\r?\n/);
const sample = lines.slice(0, 40);
const alternate =
  sample.filter((_, i) => i % 2 === 1).every((l) => l === '') &&
  sample.filter((_, i) => i % 2 === 0).some((l) => l.trim());
if (alternate) {
  fs.writeFileSync(recombPath, lines.filter((l) => l !== '').join('\n') + '\n');
  console.log('normalized recombinatorModel.js');
} else {
  console.log('recombinatorModel.js already OK');
}

const det = fs.readFileSync(path.join(root, 'src/lib/deterministicPlanner.js'), 'utf8');
console.log('deterministicPlanner.js lines:', det.split(/\r?\n/).length);

const outPath = path.join(root, 'det-test-result.txt');
const r = spawnSync(process.execPath, [path.join(root, 'scripts/run-all-tests.mjs')], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
const body = [
  `exit=${r.status}`,
  '--- stdout ---',
  r.stdout || '',
  '--- stderr ---',
  r.stderr || '',
].join('\n');
fs.writeFileSync(outPath, body);
console.log(body.slice(-2000));
process.exit(r.status ?? 1);
