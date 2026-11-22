# ReactNMS

Lightweight React + Node Network Management System.

## Quick start

```bash
cp .env.example .env
# edit .env with your SNMP community / host if desired
docker compose up -d --build
```

Open http://localhost:8080

## Data

Discovery results, interface selections, traffic history, and alert rules are stored under the Docker volume `discovery-data` (or `DATA_DIR`). These are gitignored.

## Development

- Frontend: `reactnms/`
- Backend: `reactnms-backend/`

Do not commit `.env`, `*.db`, or anything under `data/`.
