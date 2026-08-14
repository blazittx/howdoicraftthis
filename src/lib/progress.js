/**
 * Planner progress — structured events for the live thought log.
 * Yields so the UI can paint between steps (engine stays authoritative).
 */

/** @param {((e: object) => void) | null | undefined} onProgress */
export async function reportProgress(onProgress, event) {
  if (!onProgress || !event) return;
  onProgress(event);
  await new Promise((r) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(r, 0));
    } else {
      setTimeout(r, 0);
    }
  });
}

/** Format a progress event into one log line. Prefer engine `message`; never invent numbers. */
export function formatThoughtLine(p) {
  if (!p) return '';
  if (p.message) return String(p.message);
  switch (p.phase) {
    case 'loading-knowledge':
    case 'loading-data':
      return 'Loading craft knowledge…';
    case 'matching-mods':
    case 'matching-knowledge':
      return p.total != null ? `Matching mods (${p.current ?? 0}/${p.total})…` : 'Matching mods…';
    case 'building-plan':
    case 'building-routes':
      return 'Building candidate routes…';
    case 'optimizing':
    case 'planning':
      return 'Planning craft…';
    case 'comparing-ev':
      return 'Comparing Q / EV…';
    case 'recomb':
      return 'Evaluating recombinator…';
    case 'donor':
      return 'Donor mini-plan…';
    case 'rejected':
      return 'Recording rejected strategies…';
    case 'advisor':
      return 'Advisor…';
    case 'done':
      return 'Done.';
    default:
      return p.phase ? String(p.phase) : '';
  }
}
