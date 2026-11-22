# ReactNMS

A modern, React-based Network Management System prototype.

## Features

- **Dashboard** — KPI cards, traffic charts, device status overview, recent alerts
- **Device Inventory** — Searchable table of network devices with status, metrics, and details
- **Network Topology** — Interactive graph visualization powered by React Flow
- **Alerts** — Prioritized alert list with severity filtering and acknowledgment
- **Settings** — Basic configuration panels for polling and notifications
- Dark professional theme with responsive layout
- Mock data representing a typical enterprise network

## Tech Stack

- React 19 + TypeScript
- Vite
- React Router
- Recharts (charts)
- @xyflow/react (topology)
- Lucide React (icons)

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

Open http://localhost:5173

## Project Structure

```
src/
├── components/Layout.tsx    # Sidebar + header shell
├── data/mockData.ts         # Sample devices, alerts, topology
├── pages/
│   ├── Dashboard.tsx
│   ├── Devices.tsx
│   ├── Topology.tsx
│   ├── Alerts.tsx
│   └── Settings.tsx
├── App.tsx
└── App.css                  # Dark theme styles
```

## Customization

Edit `src/data/mockData.ts` to change devices, alerts, or topology layout.  
Status colors and theme variables are defined in `src/App.css`.

## License

MIT
