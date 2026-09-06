import { Connection, PublicKey } from '@solana/web3.js'
import { loadKeypair, PROGRAMS, solanaRpcUrl, walletsDir } from '../../scripts/runtime.js'

const programId = new PublicKey(PROGRAMS.privacycash)

async function client() {
  // PrivacyCash 1.2.2 fixes its node-localstorage path to <cwd>/cache at import
  // time. Import from the isolated wallet directory, then restore the app cwd.
  const previousCwd = process.cwd()
  process.chdir(walletsDir())
  let PrivacyCash: typeof import('privacycash').PrivacyCash
  try { ({ PrivacyCash } = await import('privacycash')) } finally { process.chdir(previousCwd) }
  const owner = await loadKeypair()
  return new PrivacyCash({
    RPC_url: solanaRpcUrl(), owner,
    enableDebug: process.env.PROTOCOL_SDK_DEBUG === '1',
  })
}

export async function snapshot() {
  const connection = new Connection(solanaRpcUrl(), 'confirmed')
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from('tree_token')], programId)
  const [program, poolLamports] = await Promise.all([
    connection.getAccountInfo(programId, 'confirmed'), connection.getBalance(pool, 'confirmed'),
  ])
  return { protocol: 'privacycash', programId: programId.toBase58(), executable: Boolean(program?.executable), poolAddress: pool.toBase58(), poolLamports }
}

export async function balance() {
  const balance = await (await client()).getPrivateBalance()
  return { protocol: 'privacycash', privateLamports: balance.lamports }
}

export async function deposit(lamports: bigint) {
  const result = await (await client()).deposit({ lamports: Number(lamports) })
  return { protocol: 'privacycash', action: 'deposit', signature: result.tx, lamports }
}

export async function send(recipientAddress: string, lamports: bigint) {
  const recipient = new PublicKey(recipientAddress).toBase58()
  const result = await (await client()).withdraw({ lamports: Number(lamports), recipientAddress: recipient })
  return { protocol: 'privacycash', action: 'send', signature: result.tx, recipient, grossLamports: lamports, feeLamports: result.fee_in_lamports }
}
