import { useEffect, useRef, useState } from 'react';
import 'uplot/dist/uPlot.min.css';

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

export type OpticPoint = { t: number; rx: number | null; tx: number | null };

function dbm(value: number | null) {
  return value == null || !Number.isFinite(value) ? '' : `${value.toFixed(2)} dBm`;
}

export function OpticChart({ points }: { points: OpticPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = ref.current;
    if (!host || points.length < 2) return;
    let plot: { destroy: () => void; setSize: (size: { width: number; height: number }) => void } | null = null;
    let observer: ResizeObserver | null = null;
    let cancel = false;
    const xs = points.map((point) => point.t / 1000);
    const rx = points.map((point) => point.rx);
    const tx = points.map((point) => point.tx);

    (async () => {
      try {
        localeForCharts();
        const { default: UPlot } = await import('uplot');
        if (cancel || !ref.current) return;
        const el = ref.current;
        plot = new UPlot(
          {
            width: el.clientWidth || 640,
            height: 180,
            series: [
              {},
              { label: 'Rx', stroke: '#3ddec4', width: 2, value: (_plot, value) => dbm(value) },
              { label: 'Tx', stroke: '#e6b15a', width: 2, value: (_plot, value) => dbm(value) },
            ],
            scales: { x: { time: true } },
            axes: [
              { stroke: MUTED, grid: { stroke: GRID }, ticks: { stroke: TICK } },
              {
                stroke: MUTED,
                grid: { stroke: GRID },
                ticks: { stroke: TICK },
                label: 'dBm',
                values: (_axis, vals) => vals.map((value) => (value == null ? '' : Number(value).toFixed(1))),
              },
            ],
          },
          [xs, rx, tx],
          el,
        );
        if (cancel) {
          plot.destroy();
          plot = null;
          return;
        }
        observer = new ResizeObserver(() => {
          const width = el.clientWidth;
          if (width > 0 && plot) plot.setSize({ width, height: 180 });
        });
        observer.observe(el);
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

  if (failed) return <p className="text-sm text-muted">The chart could not be drawn.</p>;
  return <div ref={ref} className="min-h-[180px] w-full" />;
}
