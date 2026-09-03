# DarkSol

Analytics for CLOAKC and PrivacyCash on Solana plus the Curvy Vault on Arbitrum. It tracks pool state, deposits, withdrawals, supported swap flows, activity patterns, and each platform's published fee policy for USDC, SOL and USDT. The home screen is a privacy-planning tool for single- and multiple-receiver transfers. Its results are estimates based on stored historical activity, never guarantees of anonymity.

The durable live-test findings, swap routes, fee measurements, and integration caveats are recorded in [`docs/PROJECT_MEMORY.md`](docs/PROJECT_MEMORY.md).

## Run locally

Requires Node.js 24 or newer. The protocol SDK runner uses PrivacyCash and Curvy packages that require Node 24.

```bash
npm install
cp .env.example .env.local
# Add your Helius key, Arbitrum Alchemy RPC URL, and SUPABASE_DB_URL to .env.local
npm run migrate
```

Run the writer and dashboard as separate processes:

```bash
# Console 1: backend writer (Helius + Alchemy -> Supabase)
npm run indexer:watch

# Console 2: read-only dashboard API + Vite
npm run dev
```

`npm run indexer` performs one production-mode reconciliation/catch-up and exits. `npm run indexer:watch` runs the writer every five minutes. Each cycle runs an Alchemy/Arbitrum lane in parallel with a Helius/Solana lane, so a long Solana history backfill cannot delay Curvy refreshes. Cloak and PrivacyCash remain sequential inside the shared Helius lane to avoid competing for the same service. `npm run indexer:dev` enables verbose development mode and exits after one correct cycle; `npm run indexer:dev:watch` uses the same checkpoints with a 30-second development cadence. Development mode never truncates or resets history. For short local tests, `npm run indexer:dev -- --max-backfill-pages 1` processes one historical page and leaves the cursor ready to resume. `npm run dev` starts the read-only API on port 8787 and Vite on port 5173.

## Deploying

The dashboard is a Vite build; the API is the same Express app in both places.
[`server/app.js`](server/app.js) holds the routes and binds nothing, so
[`server/api.js`](server/api.js) can serve it with the built assets on one local
port while [`api/index.js`](api/index.js) exposes it to Vercel as a serverless
function. An Express app is already a `(request, response)` handler, so the
function is a re-export and [`vercel.json`](vercel.json) rewrites `/api/*` onto
it. Without that rewrite Vercel serves only the static build and every `/api`
call returns its HTML 404 page, which the dashboard then fails to parse as JSON.

Vercel needs the same `SUPABASE_DB_URL`, but pointed at Supabase's **transaction
pooler** (port 6543) rather than the direct connection, which is IPv6-only
without the IPv4 add-on and unreachable from a function. Each warm instance
keeps its own pool, so the pool is capped at one connection there
automatically.

The indexer is not part of the deployment. It is a long-running writer and still
runs wherever you choose to run it, writing to the same Supabase project.

## Supabase

Analytics live in Supabase Postgres. The server connects over the direct Postgres
connection string, not PostgREST, so no anon, publishable or service-role key is
involved and no RLS policy has to be opened up for the writer.

Set one variable locally and in the Vercel project, from Supabase > Connect >
Direct connection:

```bash
SUPABASE_DB_URL=postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
```

The schema lives in [`supabase/migrations`](supabase/migrations); the SQLite
lineage in [`migrations`](migrations) is kept only as the history the local
database was built from.

```bash
npm run supabase:migrate   # apply pending schema changes
npm run supabase:sync      # copy the local SQLite database into Supabase
npm run supabase:resync    # copy it again, ignoring the completion marker
```

`npm run indexer:watch` does both of these itself before its first cycle: it
applies pending migrations, copies anything the local SQLite database still
holds, and then streams new transactions straight into Supabase. Once a local
file has been copied the import is recorded and later runs skip it, so the watch
loop starts indexing immediately. Every table is upserted on its primary key, so
an interrupted import is resumed rather than duplicated by the next run.

Supabase stores only what the dashboard reads, over a rolling window, which
makes it far smaller than the local SQLite database it came from — roughly
96 MB against 2.7 GB, and flat over time rather than growing. Left behind:

| dropped | why |
| --- | --- |
| `source_transactions` | its raw payload column had no reader and was ~95% of the dataset's bytes; the rest of the table served three aggregates `pool_flows` answers itself |
| `deposits` | a cloakc-only mirror of deposit rows already in `pool_flows`, written every batch and never read |
| `decimals` | every consumer derives decimals from the asset |
| `instruction_index` | recoverable from `id`, which is `signature:index` |
| `indexed_at` | never read on any row |
| `sync_state.last_block_time`, `last_signature` | written by the old schema, read by nothing |
| five `pool_flows` indexes | unreachable: nothing filters `block_time`, `asset` or `direction` without also filtering `protocol` |

`pool_flows` keeps every column: `participant` drives PrivacyCash swap matching,
`amount_raw` the distinct-amount metrics, `linked_flow_id` swap pairing and
latency.

`pool_flows` is also kept to a rolling window — `FLOW_RETENTION_DAYS`, 100 by
default: the 90-day chart plus enough margin to keep its oldest bucket whole.
Everything older is deleted after each indexing cycle.

Deleting a flow would normally move Cloak's TVL, which is reconstructed by
summing every flow since the pool opened. So nothing is deleted before its
contribution is folded into `flow_baselines`, and the balance becomes that
baseline plus the flows still present. The fold and the delete share one
transaction, so a reconstructed balance is never missing a row nor counting one
twice. PrivacyCash and Curvy read their balances from the chain and never
depended on this, but the baseline is maintained for all three so the
reconstructed figure stays available as a cross-check.

The same window applies on the way in: `supabase:sync` summarises everything
older than the cutoff into `flow_baselines` and copies only the recent rows, so
the initial import never sends the full history over the wire.

Two consequences worth knowing. A transaction that decoded no flow is no longer
represented, so `storage.transactions` and the coverage bounds describe indexed
analytics rather than every transaction that touched the program — about 0.6% of
this history. And a raw payload was the only re-decodable record of a
transaction, so a decoder change now needs a re-index from Helius rather than a
local rebuild.

## Data pipeline

```text
Solana / Helius  --\
                    backend indexer -> Supabase Postgres <- read-only API <- dashboard
Arbitrum / Alchemy-/
```

Only the backend indexer calls the chain data providers. It uses Helius `getTransactionsForAddress` for both Solana mainnet programs and DAS `getAsset` for stored token-price snapshots:

- Cloakc: `zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW`
- PrivacyCash: `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD`

It requests finalized, successful transactions and decodes the published Cloak transaction format:

- Instruction tag `0`: `Transact`
- Instruction tag `1`: `TransactSwap`
- 256-byte proof beginning at byte 1
- 264-byte public-input payload beginning at byte 257
- Signed little-endian `publicAmount` at public-input offset 32
- A positive `publicAmount` is a deposit; a negative amount is a pool exit

The asset is resolved from the transaction account layout and token-balance metadata using the canonical SOL, USDC and USDT mint addresses. Failed transactions and zero-amount shielded transfers are excluded. CLOAKC swap-outs are decoded from tag `1`; the public output asset is read from the mint encoded in its payload. Its later settlement transaction invokes Jupiter.

PrivacyCash instructions are decoded using its published SOL and SPL `transact` discriminators and signed `extAmount`. Only canonical SOL, USDC and USDT flows are retained. PrivacyCash private swaps are multi-transaction operations, so the indexer conservatively infers them by linking one withdrawal and one different-asset deposit from the same ephemeral wallet within 120 seconds. Matching is one-to-one and closest-time-first; the dashboard labels this method explicitly.

PrivacyCash fees are decoded directly from the instruction's unsigned `fee` field so its withdrawal volume represents the full pool outflow. The dashboard does not present fee revenue; it shows the published charge policy and an estimated charge for a proposed transfer. CLOAKC transfers use `0.3%` and SOL exits add `0.005 SOL`. PrivacyCash transfers use `0.35% + 0.006 SOL equivalent`; private swaps use `0.008 SOL equivalent + 0.35% + Jupiter fees`.

Curvy is indexed independently from the active production Arbitrum Vault advertised by its SDK metadata, currently `0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00`. The integration keeps the dashboard's USDC, SOL and USDT token scope and maps it to token IDs 2, 4, and 3 in that Vault. A stored source identity forces a historical backfill whenever the configured Vault changes, preventing an old deployment cursor from skipping the replacement contract. Because the configured Alchemy tier limits `eth_getLogs` ranges, the writer uses paginated `alchemy_getAssetTransfers` to find sparse Vault movements and then verifies every candidate receipt against Curvy's `Deposit`, `Withdraw`, or legacy Vault `Transfer` event. Each observed ERC-20 transfer can produce only one stored flow, even when a contract version emits both legacy and current events.

Curvy's current Vault balances come directly from ERC-20 `balanceOf` calls at the confirmed indexing block. The planner models the published `0.1%` aggregation plus `0.2%` unshielding charge for an already shielded transfer and notes the separate `0.1%` shielding charge. Curvy documents portal-based swaps and cross-chain exits through LiFi, but the present indexer does not label a Vault movement as a swap unless a defensible on-chain portal link is available.

Deposit and withdrawal volume are scoped to the selected timeframe. Cloakc pool size is cumulative indexed deposits minus withdrawals. PrivacyCash current pool size is read directly from its on-chain SOL pool PDA and USDC/USDT token accounts; Curvy current pool size is read from its Arbitrum Vault. Each chart reconstructs the selected window from the closing balance where a direct snapshot exists.

Fetched transactions and decoded flows are persisted by protocol in Supabase Postgres. Normalized external flows and their swap links are stored in `pool_flows`; current balances are stored in `pool_snapshots`; USD price snapshots are stored in `token_prices`. All tables and indexes are defined by versioned SQL files in `supabase/migrations/` and can be prepared explicitly with `npm run migrate`.

The dashboard API never calls Helius and never writes analytics data. On its first run, the independent indexer inspects `sync_state`. If history has not been verified, it streams the missing history in 100-transaction full-data pages, decodes only those pages, and persists the immutable query bound plus Helius pagination cursor after every successful page. An interrupted backfill resumes at that cursor.

After Solana history is complete, each cycle queries only from `synced_through - 5 minutes` to a frozen cycle endpoint. It follows every pagination cursor before advancing the watermark, so a busy interval cannot be skipped. Curvy stores an Arbitrum block cursor and rereads only a small overlap before the latest confirmed block. The overlaps are safely deduplicated through primary-key upserts. PrivacyCash swap matching is also limited to affected rows and waits for the 120-second matching window to close; the full table is no longer reset every cycle.

`coverage.complete` is true only after `history_complete` has been written. The first run after migration 010 performs a one-time legacy reconciliation. Migration 012 adds the chain cursor used by Curvy. Later five-minute cycles do not reread or re-decode stored transaction history.

## Intervals

| Selection | Bucket size | Window |
| --- | ---: | ---: |
| 1H | 5 minutes | 1 hour |
| 6H | 15 minutes | 6 hours |
| 1D | 1 hour | 1 day |
| 30D | 1 day | 30 days |
| 90D | 1 day | 90 days |

90 days is the longest range, and it is what sets the flow retention window
below.

The browser rereads Supabase through the API every 30 seconds. The Helius key and Alchemy RPC URL are required only by the backend indexer, remain server-side, and `.env.local` is ignored by Git.

## Privacy planner

`POST /api/plan` accepts a token, total amount, strategy, receiver amounts, and a `balanced`, `high`, or `maximum` target. Decimal amounts are validated in raw token units (9 decimals for SOL and 6 for USDC/USDT), and multiple receiver amounts must sum exactly to the total.

The estimate combines configurable pool-depth, relevant-cover, similar-size-flow, temporal-diversity, recent-activity, and amount-uniqueness sub-scores. Comparable outbound flows receive more weight than inbound flows, and logarithmic size distance prevents unrelated small transfers from becoming useful cover merely through total volume. Privacy-wait projections use robust trailing 1h, 6h, and 24h rates, are capped at seven days, include confidence, and remain separate from protocol execution latency.

PrivacyCash is configured for multiple receivers and charges its fixed component per recipient. Current Cloak mainnet and Curvy support are treated as single-recipient; they remain visible but disabled for a multiple-receiver plan. Curvy is labeled as Arbitrum One in comparisons while the other two protocols remain labeled Solana. Equal, tightly coordinated receiver legs receive an explicit coordination penalty.

The planner reads only stored Supabase metrics. Missing prices, snapshots, or flow watermarks produce an unavailable result; stale or incomplete history lowers confidence. It does not substitute a `$1` stablecoin price or hardcode production activity. The deterministic scoring scenarios can be run with:

```bash
npm test
```

Selecting a different receive asset switches the home screen into private-swap mode. Route eligibility follows the supported production interfaces: Cloak is enabled only for SOL -> USDC/USDT, Curvy supports configured Vault-asset pairs, and PrivacyCash swaps remain visible but disabled because `privacycash@1.2.2` does not expose the documented swap/recovery flow. Cloak SOL -> stablecoin swaps can be executed from a compatible browser wallet; the app obtains a fresh Jupiter quote and stores the private note and refund data locally for recovery.

## Test-only protocol SDK runner

The repository includes a server-side, disposable-wallet harness for sending native SOL through Cloak, PrivacyCash, and Curvy. It deliberately has no browser-wallet code. Amounts are always integer lamports, and no mutating command broadcasts unless `--execute` is present.

Install the current Solana CLI with the official Anza installer, then create the two keypairs:

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
mkdir -p test-wallets
solana-keygen new --no-bip39-passphrase --silent --outfile test-wallets/sender.json
solana-keygen new --no-bip39-passphrase --silent --outfile test-wallets/recipient.json
chmod 600 test-wallets/sender.json test-wallets/recipient.json
npm run wallets:create
```

The last command validates both keypairs, creates a separate test-only Curvy identity, and writes the public addresses to `test-wallets/addresses.json`. Keypairs, Curvy secrets, SDK caches, and Cloak UTXO state are ignored by Git. Do not delete `test-wallets/state/cloak.json` after a Cloak deposit: it contains the secret UTXO material needed to withdraw.

Set `SOLANA_RPC_URL` (recommended for reliable transaction submission) and `ARBITRUM_RPC_URL` in `.env.local`. Without `SOLANA_RPC_URL`, the runner uses Solana's rate-limited public mainnet endpoint; `HELIUS_API_KEY` remains reserved for the indexer. Then inspect the live program addresses and take pre-test TVL snapshots:

```bash
npm run protocol:check
npm run protocol:snapshot -- cloakc
npm run protocol:snapshot -- privacycash
npm run protocol:snapshot -- curvy
```

The Curvy SDK snapshot reads every asset held by the active Arbitrum Vault and uses Curvy's live currency metadata to report both per-asset and total USD TVL. The dashboard indexer continues to store its selected USDC, SOL, and USDT subset.

The test flow for Cloak or PrivacyCash is:

```bash
npm run protocol:deposit -- cloakc <LAMPORTS> --execute
npm run protocol:balance -- cloakc
npm run protocol:send -- cloakc <SOLANA_RECIPIENT> <LAMPORTS> --execute

# Cloak supports shielded SOL -> public USDC. The runner obtains a fresh
# Jupiter quote and binds its 1% minimum output into the proof.
npm run protocol:swap -- cloakc <SOLANA_RECIPIENT> <LAMPORTS> [USDC|USDT] --execute

npm run protocol:deposit -- privacycash <LAMPORTS> --execute
npm run protocol:balance -- privacycash
npm run protocol:send -- privacycash <SOLANA_RECIPIENT> <LAMPORTS> --execute
```

Curvy first needs a unique test handle. A Solana deposit is sent to an SDK-generated Solana entry Portal, bridged to the active Arbitrum Vault, and shielded asynchronously. A send creates an exit Portal and executes Curvy's external-transfer route back to the requested Solana address.

```bash
npm run curvy:register -- <unique-name>.curvy.name --execute
npm run protocol:deposit -- curvy <LAMPORTS> --execute
npm run protocol:balance -- curvy
npm run protocol:send -- curvy <SOLANA_RECIPIENT> <LAMPORTS> --execute

# Curvy internal swaps use Arbitrum exit and entry Portals and wait for the
# output asset to be shielded again. Amounts are source-token base units.
npm run protocol:swap -- curvy SOL USDC <LAMPORTS> --execute
npm run protocol:swap -- curvy USDC SOL <USDC_BASE_UNITS> --execute
npm run curvy:portal-status -- <PORTAL_ADDRESS>
```

The public `privacycash` package currently exposes private SOL/SPL deposit,
withdrawal, and balance methods but no supported private-swap method. The
PrivacyCash application documents a withdraw-to-ephemeral-wallet, Jupiter swap,
and re-shield flow; the runner does not imitate that flow with unsupported SDK
internals because doing so would weaken its recovery and fee guarantees.

Leave enough SOL in the sender for protocol and network fees. Use disposable, small amounts on mainnet. After each deposit/send, rerun the relevant snapshot and `npm run indexer -- --protocol curvy` when testing Curvy dashboard updates; Curvy portal settlement is asynchronous, so wait for its SDK balance/status to settle before comparing deltas.

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
