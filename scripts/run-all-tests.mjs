/**
 * Master test runner (§40). `npm test` → this file.
 * Writes summary to det-test-result.txt as well as stdout.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { installFetchMock, loadTestKb, ROOT } from '../tests/helpers/harness.mjs';

installFetchMock();

const SUITES = [
  { id: 'parser', file: '../tests/parser.mjs', fn: 'runParserTests', needsKb: false },
  { id: 'knowledge', file: '../tests/knowledge.mjs', fn: 'runKnowledgeTests', needsKb: true },
  { id: 'weights', file: '../tests/weights.mjs', fn: 'runWeightsTests', needsKb: true },
  { id: 'mechanics', file: '../tests/mechanics.mjs', fn: 'runMechanicsTests', needsKb: true },
  { id: 'harvest', file: '../tests/harvest.mjs', fn: 'runHarvestTests', needsKb: true },
  { id: 'essence', file: '../tests/essence.mjs', fn: 'runEssenceTests', needsKb: true },
  { id: 'fossils', file: '../tests/fossils.mjs', fn: 'runFossilsTests', needsKb: true },
  { id: 'unveil', file: '../tests/unveil.mjs', fn: 'runUnveilTests', needsKb: true },
  { id: 'eldritch', file: '../tests/eldritch.mjs', fn: 'runEldritchTests', needsKb: true },
  { id: 'recombinator', file: '../tests/recombinator.mjs', fn: 'runRecombinatorTests', needsKb: false },
  { id: 'optimizer', file: '../tests/optimizer.mjs', fn: 'runOptimizerTests', needsKb: true },
  { id: 'sanity', file: '../tests/sanity.mjs', fn: 'runSanityTests', needsKb: true },
  { id: 'monteCarlo', file: '../tests/monteCarlo.mjs', fn: 'runMonteCarloTests', needsKb: true },
  { id: 'regression', file: '../tests/regression.mjs', fn: 'runRegressionTests', needsKb: true },
  { id: 'benchmarks', file: '../benchmarks/run.mjs', fn: 'runBenchmarkTests', needsKb: false },
];

const only = process.env.TEST_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);

async function main() {
  const started = Date.now();
  const lines = [];
  const log = (s) => {
    console.log(s);
    lines.push(s);
  };

  log('=== howdoicraftthis test suite ===');
  let kb = null;
  try {
    kb = await loadTestKb();
    log('KB loaded');
  } catch (e) {
    log(`KB load FAILED: ${e.message}`);
    writeResults(lines, 1);
    process.exit(1);
  }

  let failed = 0;
  let skipped = 0;
  let passed = 0;
  const inventory = [];

  for (const suite of SUITES) {
    if (only?.length && !only.includes(suite.id)) continue;
    const t0 = Date.now();
    try {
      const mod = await import(suite.file);
      const fn = mod[suite.fn];
      if (typeof fn !== 'function') throw new Error(`export ${suite.fn} missing`);
      await fn(suite.needsKb ? kb : undefined);
      const ms = Date.now() - t0;
      log(`PASS  ${suite.id} (${ms}ms)`);
      inventory.push({ id: suite.id, status: 'PASS', ms });
      passed++;
    } catch (e) {
      const ms = Date.now() - t0;
      if (e?.code === 'SKIP') {
        log(`SKIP  ${suite.id}: ${e.message} (${ms}ms)`);
        inventory.push({ id: suite.id, status: 'SKIP', ms, reason: e.message });
        skipped++;
      } else {
        log(`FAIL  ${suite.id}: ${e.message} (${ms}ms)`);
        if (e.stack) log(e.stack.split('\n').slice(0, 6).join('\n'));
        inventory.push({ id: suite.id, status: 'FAIL', ms, reason: e.message });
        failed++;
      }
    }
  }

  // Optional legacy deterministic smoke (opt-in — can be slow)
  if (process.env.TEST_DETERMINISTIC === '1') {
    try {
      await import('./test-deterministic.mjs');
      log('PASS  deterministic (legacy script)');
      passed++;
    } catch (e) {
      log(`FAIL  deterministic: ${e.message}`);
      failed++;
    }
  }

  log('---');
  log(`passed=${passed} skipped=${skipped} failed=${failed} elapsed=${Date.now() - started}ms`);
  for (const row of inventory) {
    log(`  [${row.status}] ${row.id}${row.reason ? ` — ${row.reason}` : ''}`);
  }

  const code = failed > 0 ? 1 : 0;
  writeResults(lines, code, inventory);
  process.exit(code);
}

function writeResults(lines, code, inventory = []) {
  const out = [
    ...lines,
    '',
    `exit_code=${code}`,
    `inventory=${JSON.stringify(inventory)}`,
    '',
  ].join('\n');
  try {
    writeFileSync(join(ROOT, 'det-test-result.txt'), out, 'utf8');
  } catch (e) {
    console.error('could not write det-test-result.txt', e.message);
  }
}

main().catch((e) => {
  console.error(e);
  try {
    writeFileSync(join(ROOT, 'det-test-result.txt'), `FATAL\n${e.stack || e.message}\n`, 'utf8');
  } catch {
    /* ignore */
  }
  process.exit(1);
});
