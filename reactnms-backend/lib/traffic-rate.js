// ifInOctets / ifOutOctets are Counter32. A backwards step within that range is a wrap.

export function counterDelta(previous, next) {
  const before = Number(previous);
  const after = Number(next);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  if (after >= before) return after - before;
  const span = 2 ** 32;
  if (before < span && after < span) return span - before + after;
  return null;
}

export function bitsPerSecond(previous, next) {
  if (!previous || !next) return { inBps: null, outBps: null };
  const dt = (Number(next.t) - Number(previous.t)) / 1000;
  if (!Number.isFinite(dt) || dt <= 0 || dt > 600) return { inBps: null, outBps: null };
  const inDelta = counterDelta(previous.in_octets ?? previous.inOctets, next.in_octets ?? next.inOctets);
  const outDelta = counterDelta(previous.out_octets ?? previous.outOctets, next.out_octets ?? next.outOctets);
  return {
    inBps: inDelta == null ? null : (inDelta * 8) / dt,
    outBps: outDelta == null ? null : (outDelta * 8) / dt,
  };
}
