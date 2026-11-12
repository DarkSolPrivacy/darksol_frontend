# Private send performance

How long a private send takes in the browser, where the time goes, what was
changed on 2026-11-11 and 2026-11-12 and what each change bought. For anyone
working on the send path of Privacy Cash, Cloak or Umbra v2 in this repository.

The first measurements (2026-11-11) used a throwaway wallet and stop at the
signed deposit. The second set (2026-11-12, "Funded sends") paid real SOL from a
test wallet to another test wallet and covers every stage to the recipient.

This document was written new on 2026-11-11. The task that produced it referred
to an earlier version and to `docs/private-send-audit/2026-11-11.json`; neither
was in the repository or on either remote. The figures marked "28-core machine"
below are quoted from that task's brief, not measured here.

## What a send does

A send from the wallet deposits into a privacy pool, waits for the deposit to
settle, then withdraws to the recipient. Each leg scans or syncs the wallet's
notes, builds a zero-knowledge proof and hands a transaction to a relayer or
the network. Paying from a shielded balance skips the deposit leg.

## How to measure

Every send prints one table to the console when it ends, sent or failed
(`protocols/shared/stage-timings.js`), and the last ten stay in
`darksolSendTimings`. Stage names and milliseconds only: no address, signature,
note or amount, and nothing is sent anywhere. The rows add up to the total.

| Stage | What it covers |
| --- | --- |
| queued | waiting for an earlier read or send in the pool's queue |
| sdk load | importing the pool's SDK and its WebAssembly |
| sign-in | the pool's sign-in or unlock message; instant when the browser kept it |
| registration | Umbra v2 only: a wallet's one-time registration |
| note scan | reading the pool for the wallet's notes (Cloak: reading the pool's tree) |
| circuit download | fetching the proving files, wherever in the send it falls |
| proof | building the proof, downloads taken out (Privacy Cash: plus two RPC reads after it) |
| wallet approval | waiting for the wallet to sign |
| relay request | handing the transaction to the relayer or the network |
| settlement wait | waiting until it is confirmed and spendable |
| other | balance checks, fee and pool-state reads |

`scripts/private-send-bench.mjs` drives a build in headless Chromium with a
throwaway wallet and collects these tables; its header says how to run it. It
fakes only that wallet's SOL balance and aborts every submission, so **a run
reaches the signed deposit and nothing after it**. Request interception
disables the HTTP cache, so every run downloads as a first visit does. The
funded sends used a variant that signs with a test wallet's key file and
forwards everything; it stays out of the repository because it reads a key.

## Results to the signed deposit

Measured on 2026-11-11 on a 6-core VPS (headless Chromium 141, datacenter
link), a wallet new to the browser, 0.05 SOL, seconds from the click to the
signed deposit, median and [range]. Raw figures:
`docs/private-send-audit/2026-11-11-stage-timings.json`.

### Privacy Cash

| Stage | Before (3 runs) | First scan windowed (3 runs) | Final build, preloaded (3 runs) |
| --- | --- | --- | --- |
| sdk load | 0.7 [0.7–0.8] | 0.8 [0.7–0.9] | 0 |
| note scan | 181.8 [180.5–181.8] | 22.9 [22.4–23.4] | 21.9 [20.5–22.1] |
| circuit download | 1.3 [1.2–1.3] | 1.2 [1.2–1.2] | 0 |
| proof | 7.6 [7.6–7.7] | 7.5 [7.4–9.4] | 8.5 [7.1–8.7] |
| **total** | **191.5 [190.3–191.7]** | **33.1 [32.4–33.8]** | **30.7 [27.7–30.7]** |
| notes downloaded | 80.2 MB, 45 requests | 9.0 MB, 6 requests | 9.0 MB |
| code and circuit after the click | 25.5 MB | 25.5 MB | 0 |

The build's files are served from disk in these runs, so SDK load and circuit
download are far shorter than on a real connection. With those files held to a
simulated 20 Mbit/s link (3 runs each):

| Stage | First scan windowed | Preload finished before the click | Clicked within 1.5 s of choosing the route |
| --- | --- | --- | --- |
| sdk load | 2.5 [2.5–2.6] | 0 | 2.5 [2.5–2.5] |
| circuit download | 9.2 [9.2–9.2] | 0 | 9.1 [9.1–9.2] |
| **total** | **41.7 [41.2–43.1]** | **30.0 [29.8–30.1]** | **41.5 [41.2–42.0]** |

A browser that has scanned before skips the windowed scan: four sends in one
profile reached the signed deposit in 28.9, 14.7, 8.4 and 7.7 s. The second
waited 2.3 s in the queue behind the page's own balance read.

For comparison, the 28-core machine: darksol.app 72 s for a wallet new to the
browser, of which 57 s the full scan, 2.1 s loading SDK code after the click and
8 to 20 s downloading the circuit; the proof about 2 s; privacycash.org about
5 s from click to signed deposit.

**The target of under 10 s to reach the proof is not met on this machine**:
22 s of scan remain, all of it trying 100,000 notes against the wallet's key at
about 0.2 ms each. The same full scan that takes 182 s here took 57 s on the
28-core machine, so the window should take about 7 s there; that is an
estimate, not a measurement.

### Cloak

| Stage | Before (8 runs) | Preloaded (8 runs) | Final build, preloaded (3 runs) |
| --- | --- | --- | --- |
| sdk load | 0.6 [0.5–0.6] | 0 | 0 |
| other (viewing-key message, fees) | 2.2 [1.9–2.9] | 2.4 [1.9–3.6] | 2.3 [2.2–2.4] |
| note scan (the pool's tree) | 1.6 [1.3–1.7] | 1.8 [1.4–2.0] | 1.5 [1.4–1.7] |
| circuit download | 1.7 [1.5–11.2] | 0 | 0 |
| proof | 8.1 [7.7–9.3] | 8.2 [7.4–10.8] | 8.0 [7.7–8.2] |
| **total** | **14.3 [13.5–24.7]** | **12.4 [10.9–15.5]** | **11.7 [11.5–12.4]** |
| code and circuit after the click | 27.0 MB | 0 | 0 |

Cloak's 22.9 MB of proving files come from its own storage host at datacenter
speed here; on a 20 Mbit/s link they would take about 9 s, which the preload
moves ahead of the click. One baseline run spent 11.2 s on that download.

### Umbra v2

A throwaway wallet cannot go further than the one-time registration, which it
cannot pay for. Up to that refusal (3 runs each):

| Stage | SDK 0.1.1 | SDK 0.5.0 | SDK 0.5.0, preloaded |
| --- | --- | --- | --- |
| sdk load | 0.6 [0.5–0.6] | 0.7 [0.6–0.7] | 0 |
| sign-in (unlock message) | 0.6 [0.5–0.7] | 0.5 [0.5–0.6] | 0.6 [0.5–0.6] |
| registration | 4.2 [3.6–7.1] | 3.8 [3.8–19.0] | 4.1 [3.5–38.0] |
| circuit download | 0.4 [0.4–0.5] | 0.4 [0.3–4.0] | 0 |
| **total** | **5.8 [5.5–8.5]** | **5.5 [5.4–24.1]** | **4.7 [4.1–38.6]** |
| proving files after the click | 12.9 MB | 12.9 MB | 0 |

The preload fetched all 147 MB of proving files before the click. Two runs had
a registration of 19 s and 38 s; the cause was not found.

## Funded sends, click to recipient paid

Measured on 2026-11-12 on the same machine with real sends: 0.012 SOL through
Privacy Cash, 0.01 SOL through Cloak, 0.005 SOL through Umbra v2, from one test
wallet to another, signed in Node by the same harness with the wallet's key
instead of a throwaway one, nothing faked and nothing aborted. Every send
landed. One browser profile throughout, so these are a returning user's
numbers unless marked cold. Seconds, median and [range]. Raw figures:
`docs/private-send-audit/2026-11-12-funded.json`.

The test wallet signs at once, so "wallet approval" is the SDK's own work
around the signature; a person adds their reading time.

### Privacy Cash, before and after item 6

| Stage | Before (3) | Confirm at once (3) |
| --- | --- | --- |
| deposit: note scan | 1.1 [1.0–1.2] | 1.0 [1.0–1.1] |
| deposit: proof | 8.2 [7.1–9.7] | 7.1 [6.8–7.1] |
| deposit: relay request | 7.4 [7.4–7.7] | 7.8 [7.4–8.0] |
| deposit: settlement wait | 2.1 [2.1–2.1] | 0.1 [0.1–0.1] |
| withdrawal: note scan | 1.5 [1.3–1.6] | 1.3 [1.3–1.8] |
| withdrawal: proof | 6.9 [5.9–8.2] | 5.9 [5.9–6.5] |
| withdrawal: relay request | 2.5 [2.3–2.6] | 2.3 [2.3–2.4] |
| withdrawal: settlement wait | 2.1 [2.1–2.1] | 0.1 [0.1–0.2] |
| **total** | **45.9 [29.8–54.8]** | **26.1 [25.5–26.6]** |

The "before" runs are not all alike: the first was the profile's first scan
(22.8 s, recent notes only) and the second waited 11.1 s in the queue behind
the page's own balance read, which starts when the page loads. The third, like
every "after" run, did neither: 29.8 s. The relayer holds a deposit's request
for 7.4 to 8.0 s, until it has landed.

### Cloak, before and after the confirmation fix

| Stage | Before (3) | Polling confirmation (3) |
| --- | --- | --- |
| deposit: other (fees, viewing key) | 2.1 [1.9–3.6] | 2.0 [1.9–2.4] |
| deposit: note scan (the pool's tree) | 1.5 [1.3–2.0] | 1.4 [1.3–1.4] |
| deposit: proof | 9.3 [7.6–9.8] | 8.9 [7.9–9.2] |
| deposit: settlement wait | 35.3 [34.9–35.7] | 4.1 [3.9–4.3] |
| withdrawal: proof | 7.4 [6.9–8.9] | 7.5 [7.4–8.6] |
| withdrawal: relay request | 1.9 [1.6–2.1] | 1.8 [1.8–1.9] |
| withdrawal: settlement wait | 0.6 [0.5–0.7] | 0.7 [0.6–0.7] |
| **total** | **58.4 [58.1–60.9]** | **27.4 [25.2–28.5]** |

See "Cloak" below for what the 35 s was.

### Umbra v2

| Stage | Synced twice (2) | Synced once, final build (3) |
| --- | --- | --- |
| sign-in (unlock message) | 0.5 [0.3–0.7] | 0.4 [0.3–0.7] |
| deposit: note scan | 3.5 [3.0–4.0] | 1.1 [1.1–2.2] |
| deposit: proof | 12.5 [12.3–12.6] | 13.3 [12.2–13.4] |
| deposit: relay request | 1.5 [1.4–1.5] | 1.5 [1.5–1.6] |
| deposit: settlement wait | 9.8 [8.0–11.6] | 8.0 [2.8–13.0] |
| withdrawal: note scan | 1.3 [1.0–1.6] | 0 |
| withdrawal: proof | 9.1 [8.8–9.4] | 9.7 [9.4–10.8] |
| withdrawal: relay request | 1.8 [0.9–2.6] | 1.0 [0.9–1.2] |
| withdrawal: settlement wait | 4.5 [4.5–4.5] | 3.9 [2.4–64.2] |
| **total** | **46.7 [42.6–50.7]** | **47.5 [38.5–97.5]** |

Both columns run SDK 0.5.0. Item 5 removed 2.4 s of sync before the deposit
and 1.3 s before the payout; the totals do not show it because the settlement
waits vary more than that. One payout waited 64 s to land, the other four 2.4
to 4.5 s.

The first send in a new profile took 216.4 s: 143.6 s to sync the wallet's
notes from its registration on, and 20.3 s of proving files the preload had
not finished in the 15 s before the click.

### With the real Solflare extension

One 0.003 SOL Umbra v2 send on the final build through Solflare 2.42, in the
Solflare harness, every prompt approved as a user would: 110.2 s, of which
59.6 s was catching up a note store last synced three days earlier, and 6.6 s
the wallet's approval. Solflare added its Lighthouse guard instruction to the
deposit's funding transaction, the SDK 0.5.0 patch accepted it, and it landed.

## What changed, item by item

1. **Stage timings** (`protocols/shared/stage-timings.js`). No effect on
   speed; everything below was measured with it.
2. **Privacy Cash: a first scan reads the last 100,000 notes**
   (`protocols/privacycash/recent-scan.js`). 191.5 s → 33.1 s. See the next section.
3. **Preload before the click** (`src/preload.js`, each adapter's `preload`),
   for the pool the planner selected only, once a wallet is connected and the
   form is valid and the selection has held for 1.5 s. Not on a data-saver
   connection, not while a payment runs, no wallet prompt, no proof ahead;
   silent when it fails. Privacy Cash on the simulated link: 41.7 s → 30.0 s.
   Cloak: 14.3 s → 12.4 s. Umbra v2: 147 MB moved ahead of the click.
4. **Umbra v2 SDK 0.1.1 → 0.5.0.** Registration 4.2 s → 3.8 s; works with
   Solflare's guards. Its main gain, a prover kept between a send's two proofs,
   is not measured against 0.1.1: no funded send ran on 0.1.1.
5. **Umbra v2: one note sync per flow.** 3.7 s less syncing per send.
6. **Privacy Cash: confirm at once** (`protocols/privacycash/sdk-patch.js`).
   Settlement wait 2.1 s → 0.1 s per leg, about 4 s per send.
7. **Cloak: confirm by polling** (`protocols/shared/http-confirm.js`), added on
   2026-11-12. Deposit settlement 35.3 s → 4.1 s; send 58.4 s → 27.4 s.

## Privacy Cash

### The first scan

The SDK finds a wallet's notes by downloading the pool's encrypted notes 20,000
at a time and trying each with the wallet's key. It saves its position in
`localStorage` under `fetch_offset` plus a key built from the wallet (SOL) or
its token account (USDC, USDT), so later scans read only what is new.

privacycash.org does **not** scan the pool's history on a first visit. It reads
`nextIndex` from `GET https://api3.privacycash.org/merkle/root?token=<name>`
and, when that is above 100,000, starts at `nextIndex - 100000`. It offers a
toggle for a full scan. The 100,000 notes are a deliberate window, not a first
instalment: nothing reads the rest unless the user asks.

DarkSol scanned from note 0, the largest delay measured. It now does what the
official app does, with the SDK's own `offset` parameter (`getUtxos`,
`getUtxosSPL` in privacycash 1.2.2):

- Before anything scans a wallet's notes of an asset for the first time in this
  browser, the adapter runs the SDK's scan with `offset = nextIndex - 100000`,
  inside the adapter's `exclusive()` queue. `deposit`, `withdraw` and their SPL
  versions scan with no offset, from the saved position, so they start at the tip.
- **A saved position is never moved.** A browser that has scanned before keeps
  its position; a tree no larger than the window is scanned whole; when the
  tree's size cannot be read the SDK scans from note 0 as before.
- The balance says when it covers recent notes only, with a **Scan all notes**
  action (wallet panel; the send form when paying from shielded Privacy Cash
  funds). The full rescan reads the tree from note 0 under a position of its
  own, adds what it finds to the SDK's note cache and gives way to a payment.
  Measured: 204 s for the SOL and USDC trees.

What this costs: a deposit older than the pool's last 100,000 notes is not in
the balance until the user runs the full rescan. On 2026-11-11 the SOL tree held
about 896,000 notes and the USDC tree 104,000; the USDT tree (9,950) is below
the window.

The SDK saves its position after every page but what it found only when the
scan ends. A scan cut short (a closed tab, a dropped connection) therefore
resumes past notes it had already found and never counts them. The windowed
first scan and the full rescan both start over instead of resuming. The SDK's
own incremental scans still have this gap; it is small for them, since they
read one page.

### The proving files

snarkjs fetches `/circuit2/transaction2.wasm` (3,208,099 bytes) and
`/circuit2/transaction2.zkey` (16,461,496 bytes) by URL inside every proof: the
deposit's and again each withdrawal's. They are now fetched once per page,
checked, and answered from memory by the fetch wrapper the adapter already
installs (`protocols/privacycash/circuit-files.js`).

| File | SHA-256 |
| --- | --- |
| transaction2.wasm | `a277631b7616c2c0bfd78a1648b069972ac6020e5509ae8f9bfc8772bdc70ec1` |
| transaction2.zkey | `4aa7aa5c1c28ed1f00fee84f49c1686f53210fd999ef7c8db6cfcd298af4e693` |

These are the digests of `public/circuit2/` and of `circuit2/` in the
privacycash 1.2.2 package, which are the same files; a test checks both. A
file that fails the check is not kept and is fetched from the network as
before, with a console warning: before this change nothing checked them.

### The confirmation sleep

The SDK sleeps 2 s before every `/utxos/check` after a deposit and after each
withdrawal, up to 11 times. In six funded legs the first check always found
the note: each leg's settlement wait was 2.12 to 2.14 s, the sleep and one
check. A build-time patch (`protocols/privacycash/sdk-patch.js`, in the style
of the Umbra one) now checks at once, then every 500 ms, and gives up at the
same 22 s with the same error. In six more legs the first check found the note
every time: 0.12 to 0.17 s. A note that takes long to index is now asked about
up to 45 times instead of 11.

### Upgrading the SDK

privacycash 1.3.3 (2026-11-05) would not make a send faster: the scan, the
prover and the 2 s sleep are unchanged. It changes what happens when the
relayer's answer is lost (it reads the transaction's status from the chain
instead of failing), lowers the deposit's compute limit to 400,000 units and
doubles its priority price, and a deposit can now return with
`indexingPending: true`, which the adapter's withdrawal-after-deposit would
have to wait out. Worth taking for the lost-answer handling, as its own change.

## Cloak

A Cloak deposit does not scan for notes: it reads the pool's Merkle tree from
the relay (1.6 s, "note scan" in the tables). Its first message signature
registers a viewing key; its proof takes about 8 s on 6 cores; the wallet signs
the deposit, which the page sends to the network itself.

The SDK downloads its proving files (22.9 MB, from
`storage.googleapis.com/cloak-circuits`) inside the first proof, checks them
against digests it pins, and keeps them in memory for the page. The preload
calls the SDK's own `loadVerifiedCircuitArtifacts` ahead of the click, so that
check is the SDK's, unchanged.

### The 35-second deposit confirmation

The SDK sends the deposit itself and confirms it with web3.js
`confirmTransaction`, which waits on a websocket subscription. DarkSol's
`/api/solana-rpc` has no websocket (on darksol.app the upgrade request answers
404), so the subscription never opens, and web3.js's one status check after it
never runs. Confirmation then only ends when the transaction's blockhash
expires; web3.js throws, the SDK looks again and finds the deposit landed long
before. That took 34.9 to 35.7 s in three funded sends.

The Cloak adapter's Connection now confirms by asking for the signature's
status over HTTP every 500 ms. It waits for the same commitment and fails the
same way: a failed transaction resolves with its error, an expired one throws
web3.js's own error after a last look in the history. The NEAR adapter already
polls for the same reason. Nothing in Cloak's SDK changed, and Cloak's team
needs to change nothing; an SDK option to confirm by polling would help every
app behind an HTTP-only RPC.

Other places that might wait on `confirmTransaction` through the same proxy
were not checked; the payment-link deposit path is the first to look at.

Cloak's own waits are left alone, and its adapter has no queue to keep: a
Cloak send does not share a scan position.

@cloak.dev/sdk 0.2.11 would not make a send faster either. Its changelog
(entries from 0.2.6 to 0.2.11; earlier versions are not listed) is about the relay's clock, a note index for restoring notes, request
keys and V1 deposits for wallets that add instructions; nothing touches the
proof, the circuit files or the waits. The V1 deposit is relevant for Solflare,
not for speed.

Not measured for Cloak: a send from saved notes, a swap, an SPL send.

## Umbra v2

- **SDK 0.5.0.** 0.1.1 started a prover worker per proof and terminated it
  after. 0.5.0 keeps the workers it starts itself, and one loaded proving key
  in shared-memory mode, for 120 s after a proof, so a withdrawal that follows
  its deposit does not load the prover again. This holds only with the SDK's
  own worker starter and shared-memory proving, both of which the adapter
  leaves at their defaults. `protocols/umbrav2/progress-plan.js` still budgets
  25 s per proof from an earlier measurement on 6 cores; not re-measured.
- **Proving files.** Transaction 97.6 MB and 7.9 MB, absence 26.8 MB and 2 MB,
  registration 11.8 MB and 1.1 MB. The SDK downloads each inside the first
  proof that needs it and keeps it in IndexedDB. Umbra's own app downloads them
  right after the wallet connects. 0.5.0 has no call to load them ahead; the
  preload fetches them, checks each against the size and SHA-256 in the SDK's
  manifest, and hands them to the SDK through the `fetch` it downloads with
  (`protocols/umbrav2/proving-keys.js`). The SDK checks them again.
- **One sync per flow.** The adapter synced and then called `deposit()` or
  `withdraw()`, which sync again. Each is now given `sync: false` only right
  after the adapter's own sync caught up, and the adapter reports the `synced`
  stage the SDK then leaves out. The sync after the deposit is unchanged.
- **Coordinator route** (`route: 'coordinator'`, `endpoints.coordinator` at
  `/api/umbra-gateway/process-coordinator`, which the backend gateway already
  forwards): not switched on and not benchmarked. The funded wallet's budget
  went to the measurements above; the deposit's relay request it would replace
  takes 1.5 s, so it can save little of a send.
- **Settle poll**, `POLL_MS = 4000` in the adapter: unchanged. The first check
  runs at once, so the interval only matters when it misses. The deposit's
  settlement wait varied from 2.8 to 13.0 s, which a shorter interval could
  trim by up to 4 s per miss; not changed, as the timings do not say how often
  the first check misses.
- **Proofs.** 12.2 to 13.4 s for the deposit and 8.8 to 10.8 s for the payout
  on 6 cores; the progress plan's 25 s per proof is long for this machine.

## Wallet-funded and from shielded

A send from a shielded balance was not measured. It runs the withdrawal leg
alone, so the funded tables give an estimate for a returning browser: Privacy
Cash about 10 s (note scan, proof, relay, check), Cloak about 10 s plus reading
its saved notes, Umbra v2 about 15 s (sync, proof, relay, landing), against 26,
27 and 47 s from the wallet. Paying from a shielded balance skips, per pool:

- Privacy Cash: one of two proofs (about 7 s on 6 cores), the wallet's
  transaction approval and the deposit's relay request (7.4 to 8.0 s).
- Cloak: the deposit's proof (about 9 s) and the deposit transaction's
  approval, sending and confirmation (4 s with the polling fix).
- Umbra v2: the deposit's proof, its approval and landing, and the wait until
  the new note is spendable.

### Making the shielded path easier to choose

Suggestions only, nothing built:

- **Offer it where the user already looks.** Today it sits in the Shielding
  menu ("Use shielded funds") and, when nothing scores well, in a hint under
  the options. A from-shielded row in the options list itself, with its own
  time ("no deposit"), would put it beside "Now" whenever a balance covers the
  payment.
- **Know the balance before the form needs it.** A balance is read without a
  prompt only when the browser kept the pool's signature. The pools' own apps
  ask for it right after connect; asking once on connect (one message per pool,
  nothing on-chain) would let the form show a spendable balance before the
  amount is typed.
- **Say what it saves.** The options show privacy and fee, not time. The stage
  timings give a per-pool figure for the legs a shielded payment skips; a line
  such as "sends in about a third of the time" would make the trade-off visible.
- **Make the next send shielded after a keep.** A send that kept part shielded
  could default the next one, for the same asset, to paying from that balance
  when it covers the amount.
- **Privacy Cash's recent-only balance.** A deposit older than the window does
  not show until the full rescan. Running the rescan in the background after a
  first read, when the page is idle and nothing is being paid, would remove
  that surprise at the cost of about 200 s of CPU on a 6-core machine.

## Not measured anywhere

A send from a shielded balance; SPL sends (USDC, USDT); Umbra v2's coordinator
route; Umbra v2 on SDK 0.1.1 with a funded wallet, so item 4's kept prover is
not isolated; a person's approval time; a phone; a machine with more cores.

## Running these measurements on this VPS

The VPS has 8 GB of memory, no swap, and runs the backend beside the browser.
Twice a funded run was killed by the out-of-memory killer in the middle of a
proof (Umbra v2's deposit, Privacy Cash's deposit), both times before the
deposit was signed, so nothing was sent. Run one browser at a time, with
nothing else heavy beside it.

## What must stay true

- A payment is never reported as sent because a relayer accepted it, and no
  settlement or spendability wait is skipped.
- No proof, digest or signature check is weakened or skipped.
- Two spends of the same notes never run at once: Privacy Cash and Umbra v2
  keep their queues.
- No proof is generated ahead of time: a preload downloads and nothing more.
- A confirmation that comes sooner waits for the same thing as before: the
  Privacy Cash note indexed, the Cloak deposit at "confirmed".
