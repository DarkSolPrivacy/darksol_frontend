# DarkSol

DarkSol finds the best privacy pool for a transfer. It indexes the pools it tracks and scores each one on current TVL, pool size, quantum resistance, fees, volume, similar transactions, open-source status and further analytics, then ranks them for the asset and amount actually being sent. The home screen is a privacy planner for single- and multi-receiver transfers; its results are estimates from stored history, never guarantees of anonymity.

Live-test findings, routes, fee measurements and integration caveats live in [`docs/PROJECT_MEMORY.md`](docs/PROJECT_MEMORY.md).

## Repository map

| Path | Role |
| --- | --- |
| [`src/`](src/) | Vite + React dashboard: `main.jsx` UI, `data.js` token palette, `swap-routes.js` and `bridge-routes.js` route tables, `*-client.js` browser-wallet calls, `transfer-validation.js` and `wallet-balance.js` input checks |
| [`server/app.js`](server/app.js) | The API as a bare Express app — no listener, no static handler, so both entry points reuse it |
| [`server/api.js`](server/api.js) | Local entry point: built dashboard and API on one port |
| [`api/index.js`](api/index.js) | Vercel serverless re-export of that same app |
| [`server/indexer.js`](server/indexer.js) | Writer-process entry point; `index.js` holds the Solana decode/index core, `curvy-indexer.js` the Arbitrum lane |
| [`server/db.js`](server/db.js) | All Postgres access; `migrate.js`, `sync.js` and `import-sqlite.js` are the schema and SQLite copy entry points |
| [`server/privacy-engine.js`](server/privacy-engine.js) | Pure planning heuristics — never reads the database |
| [`server/planning-metrics.js`](server/planning-metrics.js) | Turns stored flows into the metrics the engine scores |
| [`scripts/private-sol.ts`](scripts/private-sol.ts) | CLI for the test-only SDK runner; `protocols/` is one module per protocol, `runtime.ts` shared config and wallet loading |
| [`supabase/migrations/`](supabase/migrations/) | Live schema. [`migrations/`](migrations/) is the older SQLite lineage, kept only as history |
| [`test/`](test/) | `node --test` suites |
| [`public/`](public/) | Logos plus the PrivacyCash circuit wasm/zkey copied in by `postinstall` |
| `data/` | Local SQLite analytics database (Git-ignored) |
| `test-wallets/` | Disposable test identities, keys and Cloak UTXO state (Git-ignored) |

## Run locally

Node.js 24 or newer — the PrivacyCash and Curvy SDKs require it.

```bash
npm install
cp .env.example .env.local   # your RPC service credentials and the SQL database connection string
npm run migrate
```

Writer and dashboard run as separate processes:

```bash
npm run indexer:watch   # backend writer (RPC services -> SQL database)
npm run dev             # read-only API on :8787 + Vite on :5173
```

| Command | Behaviour |
| --- | --- |
| `npm run indexer` | one production reconciliation/catch-up, then exits |
| `npm run indexer:watch` | writer every five minutes |
| `npm run indexer:dev` | verbose, exits after one correct cycle |
| `npm run indexer:dev:watch` | same checkpoints, 30-second cadence |

The EVM and Solana lanes run in parallel when separate RPC services are configured.

## Deploying

The dashboard is a Vite build; the API is the same Express app in both places. [`vercel.json`](vercel.json) rewrites `/api/*` onto the serverless function — without it Vercel serves only the static build and every `/api` call returns an HTML 404 the dashboard cannot parse as JSON.

Vercel needs the same `SUPABASE_DB_URL`, but pointed at the SQL database's **transaction pooler** (port 6543): the direct connection is IPv6-only without an IPv4 add-on and unreachable from a function. Each warm instance keeps its own pool, capped there at one connection.

The indexer is not deployed. It is a long-running writer, run wherever you like, writing to the same SQL database.

## Data pipeline

```text
Solana RPC --\
               backend indexer -> SQL database <- read-only API <- dashboard
EVM RPC -----/
```

Only the indexer calls the chain data providers: Helius `getTransactionsForAddress` for both Solana programs, DAS `getAsset` for stored price snapshots.

- Cloakc: `zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW`
- PrivacyCash: `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD`

### Decoding

Finalized, successful transactions only. Cloak's published format:

- instruction tag `0` is `Transact`, tag `1` is `TransactSwap`
- 256-byte proof beginning at byte 1; 264-byte public-input payload at byte 257
- signed little-endian `publicAmount` at public-input offset 32 — positive is a deposit, negative a pool exit

The asset is resolved from the account layout and token-balance metadata against the canonical SOL, USDC and USDT mints. Failed transactions and zero-amount shielded transfers are excluded. Swap-outs decode from tag `1`, with the public output asset read from the mint in its payload; settlement follows in a later Jupiter transaction.

PrivacyCash decodes through its published SOL and SPL `transact` discriminators and signed `extAmount`, keeping only canonical SOL, USDC and USDT flows. Its private swaps are multi-transaction operations, so the indexer conservatively infers one by linking a withdrawal to a different-asset deposit from the same ephemeral wallet within 120 seconds — one-to-one, closest-time-first, and labelled as inferred in the dashboard. Fees decode from the instruction's unsigned `fee` field, so withdrawal volume represents the full pool outflow.

The dashboard never presents fee revenue, only the published charge policy and an estimated charge for a proposed transfer: CLOAKC `0.3%` with `0.005 SOL` added on SOL exits; PrivacyCash `0.35% + 0.006 SOL equivalent`, private swaps `0.008 SOL equivalent + 0.35% + Jupiter fees`; Curvy `0.1%` aggregation plus `0.2%` unshielding for an already shielded transfer, with a separate `0.1%` shielding charge.

### Storage and cursors

Deposit and withdrawal volume are scoped to the selected timeframe. Cloakc pool size is cumulative indexed deposits minus withdrawals; PrivacyCash is read from its on-chain SOL pool PDA and USDC/USDT token accounts; Curvy from its Arbitrum Vault. Each chart reconstructs the window from the closing balance where a snapshot exists. Flows are stored in `pool_flows`, balances in `pool_snapshots`, USD prices in `token_prices`, all defined by versioned SQL in `supabase/migrations/`.

The dashboard API never calls Helius and never writes.

- **First run:** if `sync_state` shows history unverified, stream it in 100-transaction full-data pages, persisting the immutable query bound and Helius cursor after each page. An interrupted backfill resumes there.
- **Later cycles:** query only `synced_through - 5 minutes` to a frozen endpoint, following every pagination cursor before advancing the watermark, so a busy interval cannot be skipped.
- Curvy keeps an Arbitrum block cursor and rereads a small overlap; overlaps deduplicate through primary-key upserts.
- PrivacyCash swap matching touches only affected rows and waits for the 120-second window to close.
- `coverage.complete` is true only once `history_complete` is written. The first run after migration 010 does a one-time legacy reconciliation; migration 012 adds Curvy's chain cursor.

## Intervals

| Selection | Bucket size | Window |
| --- | ---: | ---: |
| 1H | 5 minutes | 1 hour |
| 6H | 15 minutes | 6 hours |
| 1D | 1 hour | 1 day |
| 30D | 1 day | 30 days |
| 90D | 1 day | 90 days |

90 days is the longest range, and it sets the flow retention window. The browser rereads the database through the API every 30 seconds. RPC service credentials are needed only by the indexer, stay server-side, and `.env.local` is ignored by Git.

## Privacy planner

`POST /api/plan` accepts a token, total amount, strategy, receiver amounts, and a `balanced`, `high` or `maximum` target. Amounts validate in raw token units (9 decimals for SOL, 6 for USDC/USDT), and multiple receiver amounts must sum exactly to the total.

The estimate combines configurable pool-depth, relevant-cover, similar-size-flow, temporal-diversity, recent-activity and amount-uniqueness sub-scores. Comparable outbound flows weigh more than inbound ones, and logarithmic size distance stops unrelated small transfers from becoming useful cover through total volume alone. Wait projections use robust trailing 1h, 6h and 24h rates, cap at seven days, carry confidence, and stay separate from protocol execution latency.

PrivacyCash is configured for multiple receivers and charges its fixed component per recipient. Cloak mainnet and Curvy are treated as single-recipient — visible but disabled for a multi-receiver plan. Curvy is labelled Arbitrum One in comparisons, the other two Solana. Equal, tightly coordinated receiver legs take an explicit coordination penalty.

The planner reads only stored metrics. Missing prices, snapshots or flow watermarks produce an unavailable result, and stale or incomplete history lowers confidence; it never substitutes a `$1` stablecoin price or hardcodes production activity. Run the deterministic scoring scenarios with `npm test`.

### Swaps

Selecting a different receive asset switches the home screen into private-swap mode. Route eligibility follows the supported production interfaces: Cloak only for SOL -> USDC/USDT, Curvy for configured Vault-asset pairs, and PrivacyCash swaps visible but disabled because `privacycash@1.2.2` does not expose the documented swap/recovery flow. Cloak SOL -> stablecoin swaps run from a compatible browser wallet; the app takes a fresh Jupiter quote and stores the private note and refund data locally for recovery.

### Private bridging

The receive-asset menu's fourth `Bridge` entry replaces the single-token choice with a destination-chain row and a token grid. Bridging is not a separate protocol primitive: PrivacyCash issues a one-time Solana deposit address from its relayer and the transfer is then an ordinary private withdrawal to that address, so [`src/bridge-client.js`](src/bridge-client.js) reuses the same `withdraw`/`withdrawSPL` calls as a private transfer and shares the session setup exported by [`src/privacycash-client.js`](src/privacycash-client.js). Destination settlement is performed by a NEAR Intents market maker, independent of the Jupiter path used for swaps.

[`src/bridge-routes.js`](src/bridge-routes.js) holds the whole route table: Ethereum (ETH/USDC/USDT/DAI), BNB Chain (BNB/USDC/USDT), Base (ETH/USDC), Polygon (POL/USDC/USDT, sent to the relayer as `pol`) and Bitcoin (BTC), from SOL, USDC or USDT input. The live PrivacyCash app also shows Robinhood, Arbitrum, Tron, Zcash and Hyperliquid chips; those are absent from the documented route map and are deliberately not offered rather than presented as pairs the relayer would refuse. Recipient addresses validate locally against the destination chain's format before the user is asked to sign, the relayer is quoted the net amount after PrivacyCash withdrawal fees while the SDK withdrawal still uses the gross amount, and the minimum is the larger of the per-token withdrawal floor and roughly 0.05 SOL of value from the relayer's live prices. Cloak has no bridge surface — its SDK and Shield Pool program are Solana-only — and Curvy bridges through LI.FI entry/exit Portals but has no browser-wallet path in this app.

## Test-only protocol SDK runner

A server-side, disposable-wallet harness for sending native SOL through Cloak, PrivacyCash and Curvy. It deliberately has no browser-wallet code. Amounts are always integer lamports, and no mutating command broadcasts without `--execute`.

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"   # Solana CLI
mkdir -p test-wallets
solana-keygen new --no-bip39-passphrase --silent --outfile test-wallets/sender.json
solana-keygen new --no-bip39-passphrase --silent --outfile test-wallets/recipient.json
chmod 600 test-wallets/sender.json test-wallets/recipient.json
npm run wallets:create
```

`wallets:create` validates both keypairs, creates a separate test-only Curvy identity, and writes the public addresses to `test-wallets/addresses.json`. Keypairs, Curvy secrets, SDK caches and Cloak UTXO state are ignored by Git. **Do not delete `test-wallets/state/cloak.json` after a Cloak deposit** — it holds the secret UTXO material needed to withdraw.

Set `SOLANA_RPC_URL` (recommended for reliable submission) and `ARBITRUM_RPC_URL` in `.env.local`; without the former the runner falls back to Solana's rate-limited public mainnet endpoint. `HELIUS_API_KEY` stays reserved for the indexer.

```bash
npm run protocol:check
npm run protocol:snapshot -- cloakc      # also: privacycash, curvy
```

The Curvy snapshot reads every asset held by the active Arbitrum Vault and reports per-asset and total USD TVL from live currency metadata; the indexer still stores only its USDC, SOL and USDT subset.

```bash
npm run protocol:deposit -- cloakc <LAMPORTS> --execute
npm run protocol:balance -- cloakc
npm run protocol:send -- cloakc <SOLANA_RECIPIENT> <LAMPORTS> --execute

# Shielded SOL -> public USDC/USDT: fresh Jupiter quote, 1% minimum output bound into the proof
npm run protocol:swap -- cloakc <SOLANA_RECIPIENT> <LAMPORTS> [USDC|USDT] --execute

npm run protocol:deposit -- privacycash <LAMPORTS> --execute
npm run protocol:balance -- privacycash
npm run protocol:send -- privacycash <SOLANA_RECIPIENT> <LAMPORTS> --execute
```

Curvy needs a unique test handle first. A deposit goes to an SDK-generated Solana entry Portal, bridges to the active Arbitrum Vault and shields asynchronously; a send creates an exit Portal and runs Curvy's external-transfer route back to the requested Solana address.

```bash
npm run curvy:register -- <unique-name>.curvy.name --execute
npm run protocol:deposit -- curvy <LAMPORTS> --execute
npm run protocol:balance -- curvy
npm run protocol:send -- curvy <SOLANA_RECIPIENT> <LAMPORTS> --execute

# Internal swaps use Arbitrum exit and entry Portals and wait for re-shielding. Source-token base units.
npm run protocol:swap -- curvy SOL USDC <LAMPORTS> --execute
npm run protocol:swap -- curvy USDC SOL <USDC_BASE_UNITS> --execute
npm run curvy:portal-status -- <PORTAL_ADDRESS>
```

The public `privacycash` package exposes private SOL/SPL deposit, withdrawal and balance methods but no supported private-swap method. Its application documents a withdraw-to-ephemeral-wallet, Jupiter swap and re-shield flow; the runner does not imitate that with unsupported SDK internals, because doing so would weaken its recovery and fee guarantees.

Leave enough SOL in the sender for protocol and network fees, and use small disposable amounts on mainnet. After each deposit or send, rerun the relevant snapshot — plus `npm run indexer -- --protocol curvy` when testing Curvy dashboard updates, since portal settlement is asynchronous and its SDK balance/status must settle before deltas are comparable.

## References

- https://docs.cloak.ag/sdk/introduction
- https://docs.cloak.ag/sdk/quickstart
- https://docs.cloak.ag/platform/transaction-flows
- https://docs.cloak.ag/protocol/shield-pool
- https://privacycash.mintlify.app/
- https://github.com/Privacy-Cash/privacy-cash-sdk
- https://docs.curvy.box/for-the-curious/building-blocks/privacy-aggregator
- https://docs.curvy.box/for-programmers/interacting-with-assets
- https://docs.curvy.box/for-programmers/installing-the-sdk
- https://docs.curvy.box/faq
- https://github.com/0xCurvy/contracts
- https://www.helius.dev/docs/rpc/gettransactionsforaddress
- https://www.helius.dev/docs/api-reference/das/getasset
- https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers
