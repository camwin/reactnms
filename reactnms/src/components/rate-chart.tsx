import { useEffect, useRef, useState } from 'react';
import 'uplot/dist/uPlot.min.css';
import type { TrafficPoint } from '@/lib/api';
import { formatRate } from '@/lib/format';
import { toRateSeries } from '@/lib/rates';

function localeForCharts() {
  try {
    new Intl.NumberFormat(navigator.language);
  } catch {
    Object.defineProperty(Navigator.prototype, 'language', {
      configurable: true,
      get: () => 'en-US',
    });
  }
}

const MUTED = '#93a0b3';
const GRID = '#2c3848';
const TICK = '#7d8b9e';

function rateLabel(_plot: unknown, value: number | null) {
  return value == null ? '' : formatRate(value);
}

export function RateChart({ points }: { points: TrafficPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const rates = toRateSeries(points);
  const lastIn = rates.ins.length ? rates.ins[rates.ins.length - 1] : 0;
  const lastOut = rates.outs.length ? rates.outs[rates.outs.length - 1] : 0;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const series = toRateSeries(points);
    if (series.xs.length < 2) return;

    let plot: { destroy: () => void; setSize: (size: { width: number; height: number }) => void } | null = null;
    let observer: ResizeObserver | null = null;
    let cancel = false;

    (async () => {
      try {
        localeForCharts();
        const { default: UPlot } = await import('uplot');
        if (cancel) return;
        const host = ref.current;
        if (!host) return;
        plot = new UPlot(
          {
            width: host.clientWidth || 640,
            height: 180,
            series: [
              {},
              { label: 'in', stroke: '#3ddec4', width: 2, value: rateLabel },
              { label: 'out', stroke: '#e6b15a', width: 2, value: rateLabel },
            ],
            scales: { x: { time: true }, y: { range: [0, null] } },
            axes: [
              { stroke: MUTED, grid: { stroke: GRID }, ticks: { stroke: TICK } },
              {
                stroke: MUTED,
                grid: { stroke: GRID },
                ticks: { stroke: TICK },
                label: 'rate',
                values: (_axis, vals) => vals.map((value) => formatRate(value ?? 0)),
              },
            ],
          },
          [series.xs, series.ins, series.outs],
          host,
        );
        if (cancel) {
          plot.destroy();
          plot = null;
          return;
        }
        observer = new ResizeObserver(() => {
          const width = host.clientWidth;
          if (width > 0) plot?.setSize({ width, height: 180 });
        });
        observer.observe(host);
      } catch {
        if (!cancel) setFailed(true);
      }
    })();

    return () => {
      cancel = true;
      observer?.disconnect();
      plot?.destroy();
    };
  }, [points]);

  return (
    <div>
      <div className="mb-1 font-mono text-xs text-muted">
        Current: in {formatRate(lastIn)} · out {formatRate(lastOut)}
      </div>
      {failed ? <p className="text-sm text-muted">Rate chart could not start in this browser.</p> : <div ref={ref} className="w-full" />}
    </div>
  );
}
