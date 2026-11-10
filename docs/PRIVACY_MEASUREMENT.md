# How privacy is measured

The send-page meter measures how often hypothetical sends escape our forensic attacks against real
indexed pool history. It is separate from the older planner's heuristic score based on pool activity.

## What we simulate and trace

1. Read the pool's recorded public deposits, withdrawals, amounts, timing and proof-related evidence.
2. Run the production forensic linker over that history and record its state: wallet budgets,
   unspent deposits and earlier withdrawals.
3. Construct a synthetic sender and deposit/withdrawal records for the proposed payment at a historical time.
4. Apply the linker's rules to the hypothetical withdrawal. A second analyst knows the sending strategy
   and guesses the sender from amounts and timing. A trial is traced if **either** identifies the
   synthetic sender; success by both attackers is counted only once.
5. Repeat at **300 evenly spaced historical times per scenario**, over up to 90 days before the latest
   recorded transaction. A scenario specifies the pool, token, withdrawal budget, strategy, deposit
   candidate where applicable, and wait.

These are synthetic public records. No funds move, no transaction is signed or broadcast, no private
proof is executed, and the service does not call Solana's `simulateTransaction`. This measures tracing
resistance, not whether a transaction would execute successfully.

For request speed, the service probes recorded linker states instead of replaying the entire pool for
every trial. Tests compare this approximation with full single-send replays. The hypothetical deposit
does not change how intervening real withdrawals were linked in the recorded history; later real
withdrawals that would link back to the hypothetical send are also omitted.

## Two measurement sources

| Source | Coverage and use |
| --- | --- |
| `GET /api/privacy-quote` | Daily measurements for broad USD amount buckets over 20 days. Appears first and remains the fallback when exact simulation is unavailable. Full replays contain batches of synthetic sends. |
| `POST /api/privacy-sim` | Privacy Cash and Cloak: 300 trials per scenario for the entered withdrawal budget over up to 90 days. Replaces their bucket measurements after typing pauses. |
| Umbra v2 | Its shared tree is not supported by the exact-amount simulator yet; the page retains its bucket quote. |

The simulation request contains the token, withdrawal budget, maximum wait and optional manual deposit,
without sender or recipient addresses. The service does not log or retain these amounts; responses
are marked `no-store`.

## Score and bars

```text
score = round(100 × (1 − traced / completed trials))

60 traced out of 300 completed trials → score 80 → 4 of 5 bars
```

`planned` counts intended trials; `sends` counts completed/applicable trials and is the denominator.
Cells with fewer than ten completed trials are not offered. Missing measurements are not high scores.

**Zero bars identify insufficient mathematical cover, not merely a poor simulation result.** For example,
if a new deposit is immediately withdrawn 1:1 and the amount exceeds the pool's existing token balance,
the existing funds cannot account for the full withdrawal: the new deposit necessarily funded at least
part of it. The implemented check flags immediate withdrawals larger than the pool's known token balance.
This uses what the pool currently holds, not the cumulative sum of all deposits ever made.

**One bar means weak privacy under the tracing model.** Even tracing every simulated trial is an attack
result, distinct from establishing that a new deposit was mathematically necessary to fund the withdrawal.
For that reason, simulated scores are divided by 20, rounded, and clamped to one through five bars;
zero is reserved for the funding constraint above. This is a semantic distinction, not a cosmetic floor.
Bars are categories, not exact probabilities: one bar does not establish a 20% chance of escaping tracing.
Four or five bars meet the UI's private threshold. Fees and preferences separately affect the recommendation.

More trials reduce sampling uncertainty, but trials share pool history and attack rules. The score is
not a calibrated probability for a future payment. Missing attacks and different future activity are
not accounted for by increasing the sample count.

## Keeping a remainder shielded

Keeping a remainder changes the public amount pattern. The actual combination must be measured;
a larger outright payment's score cannot be copied to a smaller withdrawal.

| Entered withdrawal budget | Deposit tested | Kept shielded | Recipient receives |
| --- | --- | --- | --- |
| 28 USDC | 30 USDC | 2 USDC | 28 minus withdrawal fees |
| 90 USDC | 100 USDC | 10 USDC | 90 minus withdrawal fees |

Each trial uses the same deposit and withdrawal budget, including fees. The simulator tests up to three
common deposits above the budget and at most 1.5 times it, seen at least twice in the latest seven days
of recorded history. It includes the smallest eligible deposit, then the most frequent candidates.
A manually chosen deposit replaces this search.

The frontend selects a candidate separately for each permitted wait, preferring the smaller remainder
at the same privacy level. It offers a top-up when it improves the displayed level over the ordinary
suggestion and is allowed by settings. The offer is optional, including when fee or time priority
selects another route. Neither 30 nor 100 is a hardcoded private amount.

## Maximum wait

| Maximum wait | On-demand scenarios run and offered |
| --- | --- |
| None | Now |
| 6 h | Now, 6 h |
| 12 h | Now, 6 h, 12 h |
| 24 h | Now, 6 h, 12 h, 24 h |

Auto uses a 24 h maximum; switch to Custom to change it. The backend filters trial loops before they
run. The frontend also removes longer options, including top-up suggestions. The daily quote's
30-minute measurement is not run or offered by this on-demand flow.

“Now” models a withdrawal about one minute after depositing. Allowed waits use the same historical
sample times, so changing the maximum does not change their comparison window. The request identity
includes the limit and manual deposit, preventing responses for old settings from replacing new ones.
The shared background quote job still measures its configured waits independently of user settings.

## Assumptions and limits

- **From shielded:** the model assumes about ten times the payment was deposited three days earlier.
  The app checks whether the user's balance can fund the payment, but this score does not measure the
  age or provenance of their actual notes. Freshly shielding funds does not automatically earn that score.
- **Several recipients:** the split strategy models two or three recipients and a burst of withdrawals.
  It does not replay the user's exact recipient allocation or address relationships.
- **Recipient history:** synthetic recipient addresses do not carry the user's real wallet history.
  Existing sender/recipient relationships can reveal information outside this model.
- **Approximation and fallback:** fast probes omit some interactions; bucket measurements combine
  different amounts, and synthetic sends in a batch can provide cover for one another.
- **Observer scope:** these attacks use public chain evidence. Relayers, attesters and exchanges may
  know more. Escaping these attacks is not proof of anonymity.

## Code and verification

The backend implementation is in `server/forensics/privacy-sim.js`; `privacy-quote.js` constructs sends
for both models. The frontend merges results and chooses options in
[`src/send-options.js`](../src/send-options.js).

With Node 24, run the targeted regressions from the sibling checkouts:

```bash
cd ~/darksol_frontend
node --test test/send-options.test.js
cd ~/darksol-backend
node --test test/privacy-sim.test.js test/privacy-quote.test.js test/near-ci-sim.test.js
```

They cover the 28/30 and 90/100 pairs, fees and remainders, allowed waits passed into simulation,
per-wait candidate selection, request identity and full-replay comparisons. Store tests require a
disposable test database and otherwise skip. See [Local development](LOCAL_DEVELOPMENT.md) to run the
changed services together, and the backend's
[simulation documentation](https://github.com/DarkSolPrivacy/darksol-backend/blob/main/docs/PRIVACY_SIM.md)
for recorded parity results and API details.
