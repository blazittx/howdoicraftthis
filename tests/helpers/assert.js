/** Minimal assert helpers for the tests/ tree. */

export function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

export function assertApprox(a, b, eps, msg) {
  const ok = Math.abs(Number(a) - Number(b)) <= eps;
  if (!ok) throw new Error(`ASSERT: ${msg} (got ${a}, want ~${b} ±${eps})`);
}

export function skip(reason) {
  const err = new Error(reason);
  err.code = 'SKIP';
  throw err;
}

export function requireExport(mod, name, hint) {
  if (typeof mod?.[name] !== 'function' && mod?.[name] == null) {
    skip(`${hint ?? name} missing — sibling API not ready`);
  }
  return mod[name];
}
