# Local development in WSL

Use Node.js 24 or newer in each terminal. These examples assume sibling checkouts at
`~/darksol_frontend` and `~/darksol-backend`, with nvm installed. On a fresh checkout, run `npm ci`
once in each repository after selecting Node 24.

## Frontend preview with the production API

```bash
cd ~/darksol_frontend
source ~/.nvm/nvm.sh
nvm use 24
npx vite --host 0.0.0.0 --port 5173 --strictPort
```

Open **http://localhost:5173** in your Windows browser. Documentation is at
**http://localhost:5173/docs/index.html**. Stop a server with Ctrl+C. `--strictPort` reports a busy port instead
of silently switching to another address.

Vite defaults to `https://api.darksol.app`, as configured in `vite.config.js`. This previews local UI
changes with the deployed backend. It does **not** exercise local simulator or API edits, and does not
need a database connection.

## Frontend, API and simulator together

The backend needs a populated indexed database, including forensic pool history and token prices.
An empty Postgres instance cannot produce privacy measurements. Configure the backend's Git-ignored
`~/darksol-backend/.env` with real connection details, for example:

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
```

Replace the placeholders with your database connection. Use a hostname reachable from WSL: the
`postgres` hostname in the Compose example resolves inside that Docker network. `SUPABASE_DB_URL`,
if set, takes precedence over `DATABASE_URL`. Check any existing `.env.local` too: the backend API
loads it with overrides, while the standalone simulator loads `.env`. Keep credentials out of Git.

Run these in three separate WSL terminals. This reads stored history; it does not start an indexer
or collect fresh chain history.

**Terminal 1 — simulator, port 8788:**

```bash
cd ~/darksol-backend
source ~/.nvm/nvm.sh
nvm use 24
PRIVACY_SIM_ENABLED=1 PRIVACY_SIM_PORT=8788 node server/privacy-sim-service.js
```

**Terminal 2 — backend API, port 8787:**

```bash
cd ~/darksol-backend
source ~/.nvm/nvm.sh
nvm use 24
PORT=8787 PRIVACY_SIM_URL=http://127.0.0.1:8788 \
NEAR_CI_SIM_URL=http://127.0.0.1:8789 npm start
```

NEAR Confidential Intents is optional for Privacy Cash/Cloak testing. Without a service on 8789,
the API omits its simulation result. This local address avoids looking up the Compose-only `nearci` host.

**Terminal 3 — frontend using the local API:**

```bash
cd ~/darksol_frontend
source ~/.nvm/nvm.sh
nvm use 24
DARKSOL_API_URL=http://127.0.0.1:8787 \
npx vite --host 0.0.0.0 --port 5173 --strictPort
```

Open **http://localhost:5173**. Keep all three processes running. Do not also start `npm run dev`:
that starts this frontend repository's older API on 8787, conflicting with the backend API, and does
not automatically change Vite's proxy target.

## Verify the local connection

From another WSL terminal:

```bash
curl --fail-with-body http://127.0.0.1:8787/api/health
curl --fail-with-body http://127.0.0.1:8788/health
curl --fail-with-body http://localhost:5173/api/privacy-sim \
  -H 'Content-Type: application/json' \
  -d '{"asset":"USDC","amount":"28","maxWait":"6h","deposit":"30"}'
```

The last request goes through Vite, checking the complete path to the local API. A ready Privacy Cash
or Cloak response uses `model: "privacy-sim/2"`, with only `now` and `6h` in `waits`. Keep cells carry
`deposit: "30000000"` (30 USDC in base units). Scores depend on the database; this example does not
promise a particular privacy level.

The simulator loads small trees first and the large Privacy Cash SOL tree last. The latter can take
several minutes and substantial memory. An empty `pools` list from its health endpoint means no tree
is ready. A 503 can mean the requested token is still loading; inspect the simulator log for database
or missing-data errors if it persists. A visible meter alone does not confirm exact simulation is
ready: the UI can display the daily bucket quote while it waits.

## Checks and deployment

With Node 24 selected:

```bash
cd ~/darksol_frontend
npm test
npm run build
cd ~/darksol-backend
npm test
```

Some backend tests require a disposable test database and otherwise skip. These commands do not
deploy anything. The live site needs the frontend build and matching backend API/simulation services
deployed before the new measurements appear there. See [How privacy is measured](PRIVACY_MEASUREMENT.md).
