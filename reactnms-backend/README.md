# ReactNMS Discovery

Adds network discovery to ReactNMS.

## Features
- Manual subnet list (CIDR)
- On-demand SNMP scan (sysName / sysDescr)
- Scheduled discovery via cron expression
- NetBox import: pull prefixes or devices by tag and/or role, then optionally add prefixes to the scan list

## Backend

```bash
cd reactnms-backend
npm install
npm start
```

Endpoints:
- `GET/POST /api/discovery/config`
- `POST /api/discovery/scan`
- `GET /api/discovery/results`
- `POST /api/netbox/import` `{ url, token, tag?, role?, type: "prefixes"|"devices" }`

Config is persisted to `discovery.json`.

## Frontend

Add the Discovery page to your router and sidebar.

In `src/App.tsx` add the route, and in Layout add a nav item pointing to `/discovery`.

The page calls `http://localhost:3001` by default (override with `VITE_API_URL`).

## Notes
- Scans use SNMPv2c with short timeouts and limited concurrency. Only hosts that respond to SNMP are listed.
- Large subnets are capped (default ~254 hosts). Split bigger ranges.
- Schedule uses standard cron (node-cron). Example: `0 */6 * * *` = every 6 hours.
- NetBox token needs read access to the relevant prefixes/devices.
