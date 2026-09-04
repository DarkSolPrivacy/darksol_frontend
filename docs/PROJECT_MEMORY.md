# Project Memory: privacy transfers, swaps, pools and routes

Last updated: 2026-09-04

Durable findings from testing Cloak, PrivacyCash and Curvy with real funds on mainnet. Amounts, routes, TVL, quotes and fee policies are point-in-time observations and change with liquidity, prices, relayer policy and SDK versions; the lessons around them do not.

Evidence labels used below — **Live verified**: observed in a transaction, API response or balance during these tests. **SDK verified**: confirmed in the installed SDK source or types. **Documented only**: described by product documentation but absent from the installed public SDK. **Inferred**: reconstructed from related on-chain events, useful for analytics but not authoritative protocol linkage.

## Test identities and contracts

Values shown as `<redacted>` are disposable test identities, Curvy Portal addresses and transaction signatures. They are kept out of version control so this repository does not link itself to specific on-chain activity; their real values stay in the Git-ignored `test-wallets/TEST_IDENTITIES.local.md`. The protocol addresses below are public infrastructure and are not redacted.

| | |
| --- | --- |
| Solana sender / recipient | `<redacted>` |
| Curvy handle / EVM address | `<redacted>` |
| Cloak program | `zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW` |
| Cloak SOL pool | `XJ63J8R5Bgb7eEg6UehcF96yLXUV5Sgs2fnhTHKuTH8` |
| Cloak config PDA | `BFVVFb4CJVcLAA7FTFo5pKyAdw7KCHj9MRGJZzTTffFf` |
| PrivacyCash program | `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD` |
| PrivacyCash SOL pool | `4AV2Qzp3N4c9RfzyEbNZs2wqWfW4EwKnnxFAZCndvfGh` |
| Curvy Arbitrum Vault | `0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00` |
| Curvy Arbitrum Aggregator | `0xe51924cef003a654ec9735c4d97f5d4862cbcbb1` |
| Curvy Solana Portal program | `6cHtg7sPLL9NQQuuyepnkud6PskMWV5yxvU2vXfag4qX` |

Live configuration during testing: Cloak charged 0.005 SOL fixed plus 0.3% variable with swaps unpaused; PrivacyCash charged 0.006 SOL fixed plus 0.35% on withdrawal with a 0.01 SOL minimum.

Private keys, refund secrets and recovery material are intentionally excluded.

## Swap capability

| Protocol | Routing layer | DEX/AMM selection | Caller controls | Live status |
| --- | --- | --- | --- | --- |
| Cloak | Jupiter | dynamic Jupiter route, not a fixed DEX | output mint, slippage, DEX allowlist/exclusion, retries | SOL -> USDC verified |
| PrivacyCash | Jupiter, in the documented product flow | product/backend controlled | none in the tested public SDK | not broadcast |
| Curvy | Curvy intent planner plus LI.FI | planner/LI.FI controlled, no DEX selector | source/destination currency, amount, finality, relay or direct submission | both directions verified |

Callers generally choose assets and amount but not the venue. Cloak alone lets the integrator constrain Jupiter DEXes.

## Measured transfers

**Live verified.** Both protocols delivered exactly the expected amount, so neither carries a hidden fee beyond its published one.

| Protocol | Gross | Expected | Actual | Protocol fee | Difference |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cloak | 0.040000000 SOL | 0.034880000 | 0.034880000 | 0.005120000 | 0 |
| PrivacyCash | 0.040000000 SOL | 0.033860000 | 0.033860000 | 0.006140000 | 0 |

The sender's balance fell by more than the gross amount — 0.042696560 SOL for Cloak (its first use, so network plus account setup costs) and 0.042112040 SOL for PrivacyCash. Both relayed exits cost the sender no new transaction fee.

## Measured swaps

### Cloak SOL -> USDC

**Live verified.** The route changed between the preflight quote and execution, which is exactly why a route must be captured again immediately before broadcast. Executed: Quantum AMM `3RMKDUTQd3hxj69t6b9WN6GE9uJ6EpBrhxVN53FdhdLP` SOL -> USDT, then Manifest `8sjV1AqBFvFuADBCQHhotaRq5DFFYSjjg1jMyVWMqXvZ` USDT -> USDC.

| Measurement | Amount |
| --- | ---: |
| Gross private SOL consumed | 0.040000000 SOL |
| Cloak fee | 0.005120000 SOL |
| Jupiter quoted input | 0.034880000 SOL |
| Fresh expected output | 3.468761 USDC |
| Minimum at 1% slippage | 3.434074 USDC |
| Actual recipient output | 3.468610 USDC |
| Quote minus actual | 0.000151 USDC (~0.00435%) |

That 0.000151 USDC gap is execution variance, not an additional protocol fee. Keep the explicit Cloak fee separate from venue fees, market movement and rounding.

A later smoke test ran 0.015 SOL -> USDT through the generalized runner: after a 0.005045 SOL Cloak fee, Jupiter quoted 0.991723 USDT from 0.009955 SOL and the disposable recipient received 0.991126 USDT, returning the private balance to zero.

### Curvy SOL -> USDC and USDC -> SOL

| Measurement | SOL -> USDC | USDC -> SOL |
| --- | ---: | ---: |
| Requested private input | 0.030000000 SOL | 2.500000 USDC |
| Quoted effective output | 2.951030 USDC | 0.024799420 SOL |
| Quoted gas component | 0.000590298 SOL | 0.058683 USDC |
| Quoted Curvy fee | 0.000283639 SOL | 0.027367 USDC |
| Quoted bridge/swap component | 0.000074316 SOL | 0.008688 USDC |
| Actual Vault withdrawal | 0.029726591 SOL | 2.473656 USDC |
| Actual Vault deposit | 2.917885 USDC | 0.024562336 SOL |
| Actual private note | 2.878461 USDC | 0.024172752 SOL |
| Quote minus private result | 0.072569 USDC (~2.46%) | 0.000626668 SOL (~2.53%) |

Both directions lose about 2.5% between quote and final private result, and both debit the private balance by more than requested — 0.000600528 SOL and 0.059706 USDC extra respectively, closely matching gas reimbursement. The SOL -> USDC quote reported `degradedToFeesOnAmount=true`. The requested amount is therefore not the total private debit.

### Curvy external SOL deposit

| Measurement | Amount |
| --- | ---: |
| Sent to Solana entry Portal | 0.040000000 SOL |
| Arrived in Arbitrum Vault | 0.037322615 SOL |
| Created private note | 0.036920271 SOL |
| Difference | 0.003079729 SOL (7.6993%) |

Bridge and settlement costs dominate at this size. An earlier full-route estimate of 0.037804933 SOL itemized entry bridge, Curvy and exit bridge components — it was never a deposit-only quote and must not be compared as one.

### Failed tiny route

Curvy accepted and withdrew a 0.10 USDC -> SOL intent quoted at 0.000785475 SOL. Its exit Portal completed but the output entry Portal reached terminal `failed`, so this was not an end-to-end success. SDK recovery correctly found the owned Portal but could not broadcast, because the derived recovery address had no Arbitrum gas; the output stays transparently recoverable once that address is funded. This is not evidence about Curvy minimum sizing — an earlier 2.5 USDC -> SOL completed successfully.

## Protocol behaviour

### Cloak

**SDK and live verified.** Cloak withdraws SOL from its private pool and settles the public swap through Jupiter, which picks a dynamic route; Cloak is not tied to one DEX. The SDK exposes `swapDexes` and `swapExcludeDexes` (allow/exclude Jupiter DEXes), `swapSlippageBps`, and `swapRouteRetryAttempts`/`swapMaxRetries`. The CLI does not expose the allow/exclude settings yet, and its pre-quote uses 100 bps slippage with `restrictIntermediateTokens=true` targeting USDC — harness choices, not Jupiter limitations. Input is private SOL and output a public token such as USDC or USDT; there is no reverse USDC -> SOL, so a round trip cannot be completed inside Cloak's current swap API.

The refund secret is stored in `test-wallets/state/cloak-swap-refunds.json`, ignored by Git. Preserve it until settlement is final — it is required for timeout and failure recovery. Never log or document its contents.

### PrivacyCash

**Documented only.** The product describes withdrawing private input to an ephemeral wallet, swapping through Jupiter, and re-shielding the output, at a documented 0.008 SOL-equivalent fixed component plus 0.35% plus Jupiter execution costs. The newest tested public package, `privacycash@1.2.2`, exposes deposit, withdrawal and balance operations for SOL/SPL but no supported swap or recovery method. So no PrivacyCash swap was broadcast, DEX selection can be neither verified nor offered, and its ephemeral-wallet flow must not be recreated with private internals — that could break its privacy, recovery or fee guarantees.

The indexer can **infer** a swap by pairing a different-asset withdrawal and deposit involving the same ephemeral participant within 120 seconds. That is an analytics heuristic, not authoritative protocol linkage.

### Curvy

**SDK and live verified.** The flow is `create intent -> estimate intent -> execute intent`, followed by aggregation, aggregator withdrawal, wait-for-swap and wait-for-shield. A swap unshields input to an exit Portal, LI.FI performs the public route, and output reaches a fresh entry Portal before being re-shielded; the internal swap Portals observed here were Arbitrum EVM addresses. The SDK internally allows bridge identifiers `gasZipBridge`, `relaydepository` and `across`, but the Curvy planner and LI.FI choose route and venue — the tested `curvy-swap` intent has no DEX selector. The caller chooses input and output currency, amount, supported input finality, and relay versus direct aggregator-transaction submission; that last choice affects submission only, not the DEX or bridge route.

## Curvy integration bugs and fixes

Tested against `@0xcurvy/curvy-sdk@0.0.8-rc.1`, the newest published prerelease during testing; stable `latest` was 0.0.7.

**HTTP 403 on auth.** The original harness generated arbitrary scalar strings. Registration partly succeeded and signatures self-verified locally, but `/auth` returned 403 because the registered spending public key did not match the EVM signing public key the SDK expects. Fix: create both pairs through `sdkConfig.core.generateKeyPairs()`; a newly registered identity then authenticated. Do not replace this with generic random scalar generation. Ignored diagnostic backups of the broken identities remain at `test-wallets/curvy-account.pre-v3-registration-backup.json` and `test-wallets/curvy-account.invalid-signer-backup.json`.

**Portal network selection.** Currency ID 38 exists in more than one network context, so `generateEntryPortal({ currencyId: 38 })` without a selector returned EVM when the external deposit required Solana. Fix for an external Solana deposit: pass `coinType: "501"`, the Solana route's SLIP-0044 value. Do not invert this for internal Arbitrum swap Portals — `coinType: "9001"` there was rejected with HTTP 400. Omit `coinType` and let the backend use its documented default.

## Fee and attribution interpretation

Curvy's bridge/bridge-and-swap SDK field is a route cost field even when both private assets sit in the same Arbitrum Vault, so not every value in it represents a literal cross-chain bridge transaction. Keep three measurements separate: the SDK estimate and its named fee fields; the public Vault withdrawal and deposit legs; and the final private note plus total private balance debit. Only the third is the user's real result, and quote variance covers more than the named protocol fee — never report it as one undifferentiated "real fee".

For pool-level attribution:

- Pool balances move because other users transact concurrently. Attribute a test from decoded transaction flows first, and use whole-pool TVL movement only as a consistency check.
- Aggregate volume includes unrelated users: one observed 24-hour Curvy window contained an unrelated 3932.456121 USDC withdrawal that must not be attributed to a test round trip.
- Curvy swaps create separate Vault withdrawal and deposit transactions. The dashboard records both legs but deliberately reports `swaps=0`, because it cannot prove their linkage on-chain alone.
- PrivacyCash swap classification is heuristic when it pairs ephemeral-wallet legs — label it inferred.
- Rent reserve is not usable liquidity: Cloak's raw SOL account held 0.508906725 SOL against 0.507259845 SOL of usable indexed liquidity, a 0.001646880 SOL difference.

## Operational rules for future tests

1. Record a fresh quote immediately before execution; aggregator routes can change in seconds.
2. Save route legs, programs, mints, expected and minimum output, price impact, and quote timestamp.
3. Snapshot both raw pool/Vault balances and usable indexed balances before and after.
4. Decode the exact test transactions rather than attributing all TVL movement in the window to the test.
5. Measure the recipient account directly and compare its base-unit delta with the quote.
6. Compare total private balance debit with the requested amount; gas reimbursement may be separate.
7. Keep protocol fee, network fee, bridge/route cost, price impact, rounding and quote variance separate.
8. Preserve recovery and refund state until final settlement; never print it in logs or documentation.
9. Use a fresh Curvy entry Portal for each entry, with the correct network selection.
10. Do not broadcast PrivacyCash swaps until a supported public SDK and recovery flow exist.

## Next useful work

- Expose Cloak output mint, slippage, and DEX allow/exclude lists as CLI flags.
- Save a normalized JSON receipt per swap: quote, route, snapshots, transactions, actual output, fee decomposition.
- Add explorer links to dashboard transaction views.
- Find a stable Curvy intent or correlation identifier that can safely link Vault legs in the indexer.
- Revisit PrivacyCash when its public SDK publishes supported swap and recovery methods.
- Repeat routes at larger sizes to quantify fixed-cost effects, under strict maximum-loss and slippage limits.
