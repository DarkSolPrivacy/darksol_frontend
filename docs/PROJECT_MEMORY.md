# Project Memory: Privacy Transfers, Swaps, Pools, and Routes

Last updated: 2026-09-02

This document preserves what we learned while testing Cloak, PrivacyCash, and Curvy with real funds. It separates live observations from SDK behavior and product documentation so future work does not treat an assumption as a verified fact.

## Evidence labels

- **Live verified**: observed in a transaction, API response, pool balance, or private balance during these tests.
- **SDK verified**: confirmed in the installed SDK types or source, but not necessarily exercised for every option.
- **Documented only**: described by official product documentation but unavailable through the installed public SDK.
- **Inferred**: reconstructed from related on-chain events; useful for analytics, but not an authoritative protocol link.

Amounts, routes, TVL, quotes, and fee policies below are point-in-time observations. They can change with liquidity, prices, relayer policy, and SDK/backend versions.

## Quick swap comparison

| Protocol | Routing layer | DEX/AMM selection | What the caller can choose | Live status |
|---|---|---|---|---|
| Cloak | Jupiter | Dynamic Jupiter route, not a fixed DEX | Output mint, slippage, DEX allowlist/exclusion, and retry settings through the SDK | SOL -> USDC verified |
| PrivacyCash | Jupiter in the documented product flow | Product/backend controlled | No swap controls in the tested public SDK | Not broadcast through unsupported internals |
| Curvy | Curvy intent planner plus LI.FI | Planner/LI.FI controlled; no DEX selector in the tested intent API | Source/destination currency, amount, finality, and relay/direct submission | SOL -> USDC and USDC -> SOL verified |

Users can generally choose the assets and amount, but cannot necessarily choose the venue. Cloak additionally lets the integrator constrain Jupiter DEXes. Curvy does not expose an equivalent DEX selector in the tested public API.

## Test identities and contracts

Values shown as `<redacted>` are disposable test identities, Curvy Portal addresses, and
transaction signatures. They are kept out of version control so this repository does not
link itself to specific on-chain activity. Their real values stay in the Git-ignored
`test-wallets/TEST_IDENTITIES.local.md`. Program IDs, pool accounts, the Curvy Vault and
Aggregator, and Jupiter venues below are public protocol infrastructure, so they are not
redacted.

### Solana test wallets

- Sender: `<redacted>`
- Recipient: `<redacted>`

### Cloak

- Program: `zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW`
- SOL pool: `XJ63J8R5Bgb7eEg6UehcF96yLXUV5Sgs2fnhTHKuTH8`
- Config PDA: `BFVVFb4CJVcLAA7FTFo5pKyAdw7KCHj9MRGJZzTTffFf`
- Live configuration during testing: 0.005 SOL fixed fee plus 0.3% variable; swaps not paused.

### PrivacyCash

- Program: `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD`
- SOL pool: `4AV2Qzp3N4c9RfzyEbNZs2wqWfW4EwKnnxFAZCndvfGh`
- Live API configuration during testing: 0.006 SOL fixed withdrawal fee plus 0.35%; minimum withdrawal 0.01 SOL.

### Curvy

- Arbitrum Vault: `0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00`
- Arbitrum Aggregator: `0xe51924cef003a654ec9735c4d97f5d4862cbcbb1`
- Solana Portal program: `6cHtg7sPLL9NQQuuyepnkud6PskMWV5yxvU2vXfag4qX`
- Working identity handle: `<redacted>`
- Curvy EVM address: `<redacted>`

Private keys, refund secrets, and recovery material are intentionally excluded.

## Transfer findings

### Cloak SOL transfer

**Live verified:** depositing 0.04 SOL and withdrawing privately delivered exactly 0.03488 SOL.

| Measurement | Amount |
|---|---:|
| Gross private transfer | 0.040000000 SOL |
| Expected recipient amount | 0.034880000 SOL |
| Actual recipient amount | 0.034880000 SOL |
| Protocol fee | 0.005120000 SOL |
| Expected vs actual difference | 0 |

The first sender deposit reduced its balance by 0.042696560 SOL. The extra amount included network and first-use account/setup costs. The relayed withdrawal required no new sender transaction fee.

- Deposit: `<redacted>`
- Withdrawal: `<redacted>`

### PrivacyCash SOL transfer

**Live verified:** depositing 0.04 SOL and withdrawing privately delivered exactly 0.03386 SOL.

| Measurement | Amount |
|---|---:|
| Gross private transfer | 0.040000000 SOL |
| Expected recipient amount | 0.033860000 SOL |
| Actual recipient amount | 0.033860000 SOL |
| Protocol fee | 0.006140000 SOL |
| Expected vs actual difference | 0 |

The sender deposit reduced its balance by 0.042112040 SOL including network/account costs. The relayed exit required no new sender transaction fee.

- Deposit: `<redacted>`
- Withdrawal: `<redacted>`

## Swap findings

### 2026-09-02 implementation smoke tests

The dashboard now accepts distinct input/output assets and filters recommendations through an explicit protocol route matrix. Unsupported routes remain visible with a capability explanation.

**Live verified:** the generalized Cloak SOL -> stablecoin runner completed a 0.015 SOL -> USDT smoke test. After the 0.005045 SOL Cloak fee, Jupiter quoted 0.991723 USDT from 0.009955 SOL and the disposable recipient received 0.991126 USDT. The private test balance returned to zero.

- Deposit: `<redacted>`
- Swap completion: `<redacted>`

**Failed tiny-route test:** Curvy accepted and withdrew a 0.10 USDC -> SOL intent with a quoted effective output of 0.000785475 SOL. Its exit Portal completed, but the output entry Portal reached terminal `failed`, so this was not an end-to-end success. SDK recovery correctly found the owned Portal but could not broadcast because the derived recovery address had no Arbitrum gas. The approximately 0.000785 SOL output remains transparently recoverable after that recovery address is funded. Do not use this tiny amount as evidence of Curvy minimum sizing; a previous 2.5 USDC -> SOL test completed successfully.

- Exit Portal (completed): `<redacted>`
- Entry Portal (failed/recoverable): `<redacted>`
- Recovery signer needing gas: `<redacted>`

### Cloak: SOL -> USDC

#### Architecture and user choice

**SDK and live verified:** Cloak withdraws SOL from its private pool and settles the public swap through Jupiter. Jupiter selects a dynamic route; Cloak is not tied to one DEX.

The SDK exposes:

- `swapDexes`: allow only selected Jupiter DEXes.
- `swapExcludeDexes`: exclude selected Jupiter DEXes.
- `swapSlippageBps`: allowed slippage.
- `swapRouteRetryAttempts` and `swapMaxRetries`: retry behavior.

The current CLI does not yet expose the DEX allow/exclude settings. Its pre-quote uses 100 bps slippage and `restrictIntermediateTokens=true`, and the command currently targets USDC. These are harness choices, not intrinsic Jupiter limitations.

The tested Cloak API takes SOL as private swap input and supports a public token output such as USDC or USDT. It does not provide reverse USDC -> SOL, so a round trip cannot be completed entirely through Cloak's current swap API.

#### Live route

The route changed between an earlier preflight quote and execution, demonstrating why a route must be captured again immediately before broadcast.

Executed Jupiter route:

1. Quantum AMM `3RMKDUTQd3hxj69t6b9WN6GE9uJ6EpBrhxVN53FdhdLP`: SOL -> USDT
2. Manifest `8sjV1AqBFvFuADBCQHhotaRq5DFFYSjjg1jMyVWMqXvZ`: USDT -> USDC

#### Quote versus actual result

| Measurement | Amount |
|---|---:|
| Gross private SOL consumed | 0.040000000 SOL |
| Cloak fee | 0.005120000 SOL |
| Jupiter quoted input | 0.034880000 SOL |
| Fresh expected output | 3.468761 USDC |
| Minimum at 1% slippage | 3.434074 USDC |
| Actual recipient output | 3.468610 USDC |
| Quote minus actual | 0.000151 USDC |
| Relative difference | about 0.00435% |

The recipient's canonical USDC ATA was `<redacted>`. The 0.000151 USDC difference is execution variance, not an additional known protocol fee. Keep the explicit Cloak fee separate from venue fees, market movement, and rounding reflected in swap execution.

- Private deposit: `<redacted>`
- Cloak pool outflow: `<redacted>`
- Jupiter settlement returned by the SDK: `<redacted>`

#### Recovery requirement

The refund secret is stored in `test-wallets/state/cloak-swap-refunds.json`, which is ignored by version control. Preserve it until settlement is final because it is required for timeout/failure recovery. Never log or document its contents.

### PrivacyCash swaps

**Documented only:** PrivacyCash describes a flow that withdraws private input to an ephemeral wallet, swaps through Jupiter, and re-shields the output. Its documented cost is a 0.008 SOL-equivalent fixed component, 0.35%, and Jupiter execution costs.

The newest tested public package, `privacycash@1.2.2`, exposes deposit, withdrawal, and balance operations for SOL/SPL assets but no supported swap or recovery method. Therefore:

- No PrivacyCash swap was broadcast.
- DEX selection cannot be verified or offered through the public SDK.
- Jupiter is the documented aggregator, but no supported routing controls are exposed to this project.
- We should not recreate its ephemeral-wallet flow with private internals because that could break privacy, recovery, or fee guarantees.

The indexer can infer a swap by pairing a different-asset withdrawal and deposit involving the same ephemeral participant within 120 seconds. This is an analytics heuristic, not authoritative protocol linkage.

### Curvy swaps

#### Architecture and user choice

**SDK and live verified:** Curvy uses `create intent -> estimate intent -> execute intent`, followed by aggregator aggregation, aggregator withdrawal, wait-for-swap, and wait-for-shield steps.

A swap unshields input to an exit Portal, LI.FI performs the public route, and output reaches a fresh entry Portal before being re-shielded. The internal swap Portals observed here were EVM addresses on Arbitrum.

The SDK internally allows bridge identifiers `gasZipBridge`, `relaydepository`, and `across`. The Curvy planner and LI.FI choose the route/venue. The tested `curvy-swap` intent has no DEX selector.

The caller can choose input and output currencies, amount, supported input finality, and relay or direct aggregator-transaction submission. Relay/direct affects submission; it does not select the DEX or bridge route.

#### External SOL deposit before swaps

We sent 0.04 SOL to Solana entry Portal `<redacted>`.

| Measurement | Amount |
|---|---:|
| Sent to entry Portal | 0.040000000 SOL |
| Arrived in Arbitrum Vault | 0.037322615 SOL |
| Created private note | 0.036920271 SOL |
| Sent-to-private difference | 0.003079729 SOL (7.6993%) |

Bridge and settlement costs dominated this small test amount.

- Solana transaction: `<redacted>`
- Arbitrum Vault deposit: `<redacted>`
- Vault SOL moved from 0.029075799 to 0.066398414 during the observed deposit window.

An earlier full-route estimate predicted 0.037804933 SOL and itemized entry bridge, Curvy, and exit bridge components. It was not a pure deposit-only quote and should not be compared as though it were one.

#### Curvy SOL -> USDC

| Measurement | Amount |
|---|---:|
| Requested private input | 0.030000000 SOL |
| Quoted effective output | 2.951030 USDC |
| Quoted gas component | 0.000590298 SOL |
| Quoted Curvy fee | 0.000283639 SOL |
| Quoted bridge/swap component | 0.000074316 SOL |
| Actual Vault SOL withdrawal | 0.029726591 SOL |
| Actual Vault USDC deposit | 2.917885 USDC |
| Actual private USDC note | 2.878461 USDC |
| Quote minus private result | 0.072569 USDC (about 2.46%) |

The quote reported `degradedToFeesOnAmount=true`. The private SOL balance decreased by 0.030600528 SOL, 0.000600528 SOL more than requested, closely matching gas reimbursement behavior.

- Exit Portal: `<redacted>`
- Entry Portal: `<redacted>`
- Vault SOL withdrawal: `<redacted>`
- Vault USDC deposit: `<redacted>`

#### Curvy USDC -> SOL

| Measurement | Amount |
|---|---:|
| Requested private input | 2.500000 USDC |
| Quoted effective output | 0.024799420 SOL |
| Quoted gas component | 0.058683 USDC |
| Quoted Curvy fee | 0.027367 USDC |
| Quoted bridge/swap component | 0.008688 USDC |
| Actual Vault USDC withdrawal | 2.473656 USDC |
| Actual Vault SOL deposit | 0.024562336 SOL |
| Actual new private SOL note | 0.024172752 SOL |
| Quote minus private result | 0.000626668 SOL (about 2.53%) |

The private USDC balance decreased by 2.559706 USDC, 0.059706 USDC more than requested. The requested amount is not necessarily the total private balance debit when gas reimbursement is included.

- Exit Portal: `<redacted>`
- Entry Portal: `<redacted>`
- Vault USDC withdrawal: `<redacted>`
- Vault SOL deposit: `<redacted>`

#### Curvy fee interpretation

The SDK's bridge/bridge-and-swap field is a route cost field even when both private assets use the same Arbitrum Vault. Do not assume every value in that field represents a literal cross-chain bridge transaction.

Keep three measurements separate:

1. SDK estimate and named fee fields.
2. Public Vault withdrawal/deposit legs.
3. Final private note and total private balance debit.

Only the third is the user's final private result. Quote variance includes more than the named Curvy protocol fee and should not be reported as one undifferentiated “real fee.”

## Curvy integration bugs and fixes

The tested package is `@0xcurvy/curvy-sdk@0.0.8-rc.1`, the newest published prerelease during testing; the stable `latest` tag was 0.0.7.

### HTTP 403 authentication

The original harness generated arbitrary scalar strings. Registration partly succeeded and signatures self-verified locally, but `/auth` returned HTTP 403. The registered spending public key did not match the EVM signing public key expected by the SDK.

Fix: create both pairs through `sdkConfig.core.generateKeyPairs()`. A newly registered identity then authenticated successfully. Do not replace this with generic random scalar generation.

Ignored diagnostic backups of the broken identities remain at:

- `test-wallets/curvy-account.pre-v3-registration-backup.json`
- `test-wallets/curvy-account.invalid-signer-backup.json`

### Portal network selection

Curvy currency ID 38 exists in more than one network context. `generateEntryPortal({ currencyId: 38 })` without a selector returned EVM when the external deposit required Solana.

Fix for an external Solana deposit: pass `coinType: "501"`, the Solana route's SLIP-0044 value.

Do not apply the inverse assumption to internal Arbitrum swap Portals. Passing `coinType: "9001"` there was rejected with HTTP 400. For internal EVM/Arbitrum intent Portals, omit `coinType` and let the backend choose its documented default.

## TVL and volume interpretation

### Latest observed point-in-time balances

| Protocol | Asset | Indexed or Vault balance |
|---|---|---:|
| Cloak | SOL | 0.507259845 |
| Cloak | USDC | 117.610881 |
| Cloak | USDT | 5.180000 |
| PrivacyCash | SOL | 9654.992857776 |
| PrivacyCash | USDC | 975427.220197 |
| PrivacyCash | USDT | 5915.113527 |
| Curvy | SOL | 0.061020750 |
| Curvy | USDC | 4509.508228 |
| Curvy | USDT | 124.483034 |

The Curvy snapshot was approximately $11,524.05 in total TVL at the prices used then. It is not a current valuation guarantee.

Cloak's raw SOL account held 0.508906725 SOL while usable indexed liquidity was 0.507259845 SOL. The 0.001646880 SOL difference is rent reserve and must not count as usable pool liquidity.

### Attribution rules

- Total pool balances can change because other users transact concurrently.
- Attribute a test using decoded transaction flows first; use whole-pool TVL movement only as a consistency check.
- Curvy swaps create separate Vault withdrawal and deposit transactions. The dashboard recorded those legs but deliberately reported `swaps=0` because it could not prove their linkage solely on-chain.
- PrivacyCash swap classification is heuristic when it pairs ephemeral-wallet legs; label it inferred.
- Aggregate volume includes unrelated users. Curvy's observed 24-hour USDC withdrawals included an unrelated 3932.456121 USDC withdrawal, which must not be attributed to our round trip.

### 24-hour indexed snapshot

| Protocol | Asset/direction | Volume | Transactions |
|---|---|---:|---:|
| Cloak | SOL deposits | 0.210000000 | 5 |
| Cloak | SOL swap outflows | 0.060000000 | 2 |
| Cloak | SOL normal withdrawals | 0.050000000 | 2 |
| Cloak | USDC deposits | 2503.000000 | 4 |
| Cloak | USDC withdrawals | 2503.000000 | 4 |
| Curvy | SOL deposits | 0.061884951 | 2 |
| Curvy | SOL withdrawals | 0.029726591 | 1 |
| Curvy | USDC deposits | 2.917885 | 1 |
| Curvy | USDC withdrawals | 3934.929777 | 2 |
| Curvy | USDT deposits | 0.972555 | 1 |
| Curvy | USDT withdrawals | 0.911844 | 1 |
| PrivacyCash | SOL normal deposits | 2613.829173432 | 246 |
| PrivacyCash | SOL inferred swap inputs | 22.486383600 | 2 |
| PrivacyCash | SOL normal withdrawals | 3301.627988047 | 392 |
| PrivacyCash | SOL inferred swap outputs | 106.650000000 | 4 |
| PrivacyCash | USDC normal deposits | 219174.664273 | 64 |
| PrivacyCash | USDC inferred swap inputs | 10551.822001 | 4 |
| PrivacyCash | USDC normal withdrawals | 211048.206640 | 73 |
| PrivacyCash | USDC inferred swap outputs | 2255.630000 | 2 |
| PrivacyCash | USDT deposits | 13347.179181 | — |
| PrivacyCash | USDT withdrawals | 13181.179181 | — |

## Operational rules for future tests

1. Record a fresh quote immediately before execution; aggregator routes can change in seconds.
2. Save route legs, programs, mints, expected/minimum output, price impact, and quote timestamp.
3. Snapshot both raw pool/Vault balances and usable indexed balances before and after.
4. Decode exact test transactions instead of attributing all TVL movement in the window to the test.
5. Measure the recipient account directly and compare its base-unit delta with the quote.
6. Compare total private balance debit with the requested amount; gas reimbursement may be separate.
7. Keep protocol fee, network fee, bridge/route cost, price impact, rounding, and quote variance separate.
8. Preserve recovery/refund state until final settlement; never print it in logs or documentation.
9. Use a fresh Curvy entry Portal for each entry and apply the correct network-selection behavior.
10. Do not broadcast PrivacyCash swaps until a supported public SDK/API and recovery flow exist.

## Current implementation status

- Cloak production relay, on-chain configuration inspection, SOL -> USDC pre-quote/execution, and refund-secret persistence are implemented.
- Curvy SDK-native key generation, registration recovery, auth diagnostics, Portal status, external Solana Portal selection, and two-way swaps are implemented.
- The indexer handles pool flows and avoids claiming authoritative Curvy swaps without provable linkage.
- PrivacyCash remains deposit/withdraw only because its public SDK lacks swap support.
- Automated tests pass: 14/14.
- The Vite production build passes.

## Next useful work

- Expose Cloak output mint, slippage, DEX allowlist, and DEX exclusion as CLI flags.
- Save a normalized JSON receipt per swap with quote, route, snapshots, transactions, actual output, and fee decomposition.
- Add explorer links to dashboard transaction views.
- Look for a stable Curvy intent/correlation identifier that can safely link Vault legs in the indexer.
- Revisit PrivacyCash when its public SDK publishes supported swap and recovery methods.
- Repeat routes at larger sizes to quantify fixed-cost effects, with strict maximum-loss and slippage limits.
