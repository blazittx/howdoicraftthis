/**
 * Recombinator suite wrapper — reuses scripts/test-recombinator.mjs.
 */
import { runRecombinatorTests as run } from '../scripts/test-recombinator.mjs';

export async function runRecombinatorTests() {
  run();
}
