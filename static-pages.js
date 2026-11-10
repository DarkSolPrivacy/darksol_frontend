// The app renders in the browser, so without this every URL answers with an
// empty <div id="root">: search crawlers and AI assistants, which do not run
// JavaScript, see a title and nothing else. This plugin writes a plain-text
// summary into that div at build time (React replaces it on mount) and emits one
// HTML file per public page with its own title, description and canonical.
// vercel.json maps each route to its file. Keep the text in step with
// public/docs/index.html and public/llms.txt.

const LINKS = `
<h2>More about DarkSol</h2>
<ul>
  <li><a href="https://darksol.app/">Private transfer</a>: send SOL, USDC or USDT through a privacy pool.</li>
  <li><a href="https://darksol.app/payment-links">Payment links</a>: private invoices.</li>
  <li><a href="https://darksol.app/trace">Trace</a>: check whether a withdrawal can be traced.</li>
  <li><a href="https://darksol.app/analytics">Pool privacy</a>: how traceable each pool's withdrawals are.</li>
  <li><a href="https://docs.darksol.app/">Documentation</a>: private transfers, the privacy meter, payment links, the red team and architecture.</li>
  <li><a href="https://darksol.app/llms.txt">llms.txt</a>: a plain-text summary of DarkSol for AI assistants.</li>
  <li><a href="https://x.com/DarkSolapp">X</a>, <a href="https://t.me/darksolapp">Telegram</a>, <a href="https://github.com/DarkSolPrivacy/darksol_frontend">GitHub</a>.</li>
</ul>`

const PAGES = [
  {
    path: '/',
    file: 'index.html',
    body: `
<h1>DarkSol: send privately on Solana</h1>
<p>DarkSol is a private-transfer app for Solana mainnet. It compares the available privacy pools (Privacy Cash, Cloak, Umbra v2 and the older Umbra v1) using live pool activity, sends your SOL, USDC or USDT through the pool and timing most likely to keep you private, and lets you test that privacy yourself with a public-data trace tool.</p>
<p>DarkSol does not run its own pool. It is a routing and analysis layer on top of existing Solana privacy protocols. Your wallet approves every transaction that moves funds; the chosen pool protocol holds the shielded funds, not DarkSol.</p>
<h2>How a private transfer works</h2>
<ol>
  <li>Enter: choose a token (SOL, USDC or USDT), an amount and one or more recipients.</li>
  <li>Compare: DarkSol compares measured privacy, fees and your settings across the pools and suggests an option.</li>
  <li>Deposit: your wallet approves one deposit into the selected pool.</li>
  <li>Deliver: the funds leave the pool separately to your recipient, so the payment is not directly linked to your wallet.</li>
</ol>
<h2>Supported pools</h2>
<ul>
  <li>Privacy Cash: SOL, USDC, USDT. Several recipients, waits, swaps, bridging to Ethereum, BNB Chain, Base, Polygon or Bitcoin.</li>
  <li>Cloak: SOL, USDC, USDT. One recipient, swaps from SOL.</li>
  <li>Umbra v2: SOL, USDC, USDT. One recipient, swap from SOL through Jupiter.</li>
  <li>Umbra v1 (legacy): SOL, USDC, USDT. One recipient.</li>
</ul>
<p>Every pool can also keep part of a deposit shielded, shield without sending, and pay from funds already shielded. Each pool charges its own withdrawal fee, shown before you send.</p>
<h2>How privacy is measured</h2>
<p>The send-page privacy meter reports how often hypothetical sends escape DarkSol's own forensic tracing tools when replayed against recorded pool history: 300 simulated trials per scenario over up to 90 days of history, shown as one to five bars. It also tests waiting 6, 12 or 24 hours before the withdrawal and keeping a remainder shielded, and suggests those when they measurably help. The score is an estimate of resistance to known attacks on public data, not a guarantee of anonymity.</p>
<h2>What DarkSol can see</h2>
<p>To compare routes and run simulations, the browser sends the token, the amount and how it is split between recipients. Wallet and recipient addresses are not part of route planning, and the simulation service does not log or keep amounts. Deposits and withdrawals are public Solana transactions, as with any privacy pool.</p>
${LINKS}`,
  },
  {
    path: '/trace',
    file: 'trace.html',
    title: 'Trace a withdrawal – DarkSol',
    description: 'See which wallets could have funded a Privacy Cash or Cloak withdrawal: the strongest, probable and possible candidates.',
    body: `
<h1>Trace a privacy-pool withdrawal</h1>
<p>The DarkSol Trace page is a free red-team tool. Paste the transaction hash or Solscan link of a withdrawal from the Privacy Cash or Cloak pools on Solana, and it does what a chain analyst would, using only public on-chain data: it works out which depositor wallet most likely paid for the withdrawal, and how many others could have. Paste a deposit instead to see the withdrawals its wallet is the candidate for.</p>
<h2>What a report shows</h2>
<ul>
  <li>Verdict: one strongest candidate, several probable candidates, or hidden among N wallets.</li>
  <li>Public clues: a same-amount deposit right before the withdrawal, how busy the pool was, how common the amount is.</li>
  <li>Candidates: the wallets that could have paid, as strongest, probable and possible.</li>
</ul>
<h2>Linking rules that single out one wallet</h2>
<ul>
  <li>Own signature: the withdrawal was signed by the depositor's own wallet.</li>
  <li>Paid back to itself: the money went back to the wallet that deposited it.</li>
  <li>Only wallet with enough: only one wallet had enough left in the pool to pay for it.</li>
  <li>Emptied the wallet: it took exactly what one wallet had left in the pool.</li>
  <li>Same amount: it took exactly what one wallet deposited, and no other deposit has that amount.</li>
  <li>Pair emptied the wallet: together with an earlier withdrawal, it emptied one wallet exactly.</li>
  <li>Proof right after deposit: its proof was made right after one wallet deposited exactly this amount.</li>
</ul>
<h2>Limits</h2>
<p>DarkSol indexes every deposit, withdrawal and note in the Privacy Cash and Cloak pools for SOL, USDC and USDT, and rebuilds each pool from its first note, checked against on-chain proofs. Amounts inside notes are hidden, spent notes cannot be identified, and only the last hop is analysed. A suspected link is an inference, not proof of ownership, and finding no link does not prove anonymity.</p>
${LINKS}`,
  },
  {
    path: '/analytics',
    file: 'analytics.html',
    title: 'Pool privacy – DarkSol',
    description: 'How often withdrawals from Solana privacy pools point to one wallet, and the live flows of each pool.',
    body: `
<h1>Pool privacy: how traceable are Solana privacy pools?</h1>
<p>This DarkSol page shows live, measured privacy statistics for Solana privacy pools (Privacy Cash, Cloak, Umbra v2 and Umbra v1) for SOL, USDC and USDT. The figures load in the browser from DarkSol's indexers, so they are not part of this static text.</p>
<ul>
  <li>How often each pool's withdrawals point to one depositor wallet (a strongest candidate), and by which linking rule.</li>
  <li>Pool balances, deposits, withdrawals and recent flows over time.</li>
  <li>Recent pool activity.</li>
</ul>
<p>The analysis uses only public on-chain data and the same rules as the <a href="https://darksol.app/trace">Trace</a> tool. A suspected link is an inference, not proof of ownership.</p>
${LINKS}`,
  },
  {
    path: '/payment-links',
    file: 'payment-links.html',
    title: 'Payment links – DarkSol',
    description: 'Create private payment links and track your invoices with DarkSol.',
    body: `
<h1>Private payment links on Solana</h1>
<p>A DarkSol payment link is an invoice whose funds land in a privacy pool instead of your wallet. The payer connects any Solana wallet and deposits straight into the pool; only your wallet can collect what arrives, to any address you choose. The link does not contain or reveal your wallet address.</p>
<ol>
  <li>Create: choose a pool, token and amount, plus an optional reference. Your wallet signs two messages that never move funds.</li>
  <li>Share: each invoice gets its own link, darksol.app/pay/&lt;id&gt;.</li>
  <li>Pay: the payer approves one deposit into the pool.</li>
  <li>Collect: enter any destination address; the pool's relayer submits the withdrawal.</li>
</ol>
<p>Payment links work with Privacy Cash and Cloak for SOL, USDC and USDT on Solana mainnet. Cloak requires at least 0.01 SOL or 1 USDC/USDT per payment.</p>
<h2>What DarkSol stores</h2>
<p>The payment-link service stores an anonymous merchant ID, the invoice terms, note commitments, encrypted notes and payment status. It never receives your wallet address, wallet signatures, note spending keys, or where you collect to. The payer's deposit is a public Solana transaction. Links are tied to your wallet, not to one browser, so the same wallet finds them on any device.</p>
${LINKS}`,
  },
]

// Out of sight for people while the app loads, still in the HTML for anything
// that reads it without running scripts. Not display:none, which some text
// extractors skip.
const HIDDEN = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap'
// The empty div in the source, or one this plugin already filled.
const ROOT = /<div id="root">(?:[\s\S]*?<!--\/static-->)?<\/div>/
const escape = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function render(html, page) {
  if (!ROOT.test(html)) throw new Error('static-pages: <div id="root"> not found in index.html')
  const out = html.replace(ROOT, () => `<div id="root"><div style="${HIDDEN}">${page.body}\n</div><!--/static--></div>`)
  if (page.path === '/') return out
  const url = `https://darksol.app${page.path}`
  return out
    .replace(/<title>[^<]*<\/title>/, () => `<title>${page.title}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, (_, head) => head + escape(page.description))
    .replace(/(<link rel="canonical" href=")[^"]*/, (_, head) => head + url)
    .replace(/(<meta property="og:url" content=")[^"]*/, (_, head) => head + url)
}

export function staticPages() {
  return {
    name: 'darksol-static-pages',
    transformIndexHtml: { order: 'pre', handler: (html) => render(html, PAGES[0]) },
    // Runs after Vite has written the built index.html into the bundle, so the
    // copies carry the same hashed script and style tags.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const index = bundle['index.html']
        if (!index) return
        for (const page of PAGES.slice(1)) this.emitFile({ type: 'asset', fileName: page.file, source: render(String(index.source), page) })
      },
    },
  }
}
