# ReactNMS frontend

Operator UI for the Express SNMP backend in `../reactnms-backend`.

## Stack

- React 19 + TypeScript + Vite
- React Router
- Tailwind CSS 4, with shadcn-style primitives (Radix, class-variance-authority, tailwind-merge)
- uPlot for per-interface rate graphs
- IBM Plex Mono and Schibsted Grotesk

The dark theme uses accent `#3ddec4`, raised surfaces, and the same density as the reactnms-2 prototype. Routes and API calls are the live app: discovery, devices, interface history, alert rules, NetBox settings, and the SNMP credential bank.

## Scripts

```bash
npm install
npm run dev
npm run build
```

Open http://localhost:5173. The dev server proxies `/api` to `http://localhost:3001`.

## API base URL

The client calls same-origin `/api` unless `VITE_API_URL` is set. Docker Compose serves the built app behind nginx, which already proxies `/api/` to the backend. Set `VITE_API_URL` only when the API is on another origin. That value is baked in at build time.

## Layout

```
src/
├── components/Layout.tsx    # Shell, sidebar, mobile nav
├── components/nms/bits.tsx  # Metric, panel, status, utilization
├── components/rate-chart.tsx
├── components/ui/           # Button, input, select, switch, checkbox
├── lib/api.ts               # Backend client
└── pages/                   # Overview, devices, topology, discovery, alerts, settings
```
