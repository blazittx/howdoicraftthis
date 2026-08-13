import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
const r = spawnSync(process.execPath, ['scripts/test-deterministic.mjs'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
const out = `${r.stdout || ''}${r.stderr || ''}\nEXIT:${r.status}\n`;
writeFileSync('scripts/_tmp-det-now.txt', out);
console.log('wrote', out.length, 'bytes exit', r.status);
const lines = out.split(/\r?\n/).filter((l) => /ASSERT|OK:|==== onslaught|==== honour|EXIT:|Error:|Torment|Lightning Res/.test(l));
console.log(lines.slice(-40).join('\n'));
