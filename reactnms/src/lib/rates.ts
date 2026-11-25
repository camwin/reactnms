import type { TrafficPoint } from './api';

export function toRateSeries(points: TrafficPoint[]) {
  const xs: number[] = [];
  const ins: number[] = [];
  const outs: number[] = [];
  if (points.length < 2) return { xs, ins, outs };
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const dt = (cur.t - prev.t) / 1000;
    if (dt <= 0) continue;
    xs.push(cur.t / 1000);
    ins.push(Math.max(0, ((cur.in - prev.in) * 8) / dt));
    outs.push(Math.max(0, ((cur.out - prev.out) * 8) / dt));
  }
  return { xs, ins, outs };
}

export function utilPercent(bps: number, speedBps: number) {
  if (!speedBps) return null;
  return Math.max(0, Math.min(100, (bps / speedBps) * 100));
}
