import { Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { Wallet, Contract, JsonRpcProvider, SigningKey, formatUnits, hashMessage, recoverAddress } from 'ethers'
import { resolve } from 'node:path'
import { loadKeypair, parseLamports, PROGRAMS, readJson, solanaRpcUrl, walletsDir, writePrivateJson } from '../../scripts/runtime.js'

type CurvySecrets = { version: 3, s: string, v: string, userAddress: `0x${string}`, handle: string | null }

function secretsPath() { return resolve(walletsDir(), 'curvy-account.json') }

export async function walletSetup() {
  let secrets = await readJson<CurvySecrets | (Omit<CurvySecrets, 'version'> & { version: 1 | 2 }) | null>(secretsPath(), null)
  if (secrets?.version === 1 || secrets?.version === 2) {
    if (secrets.handle) throw new Error('Refusing to migrate private keys for an already-registered Curvy account')
    // Legacy identities were generated from arbitrary bytes. They cannot satisfy
    // the SDK's signing/public-key invariant, so replace only an explicitly
    // unregistered (and therefore unfunded) identity through the SDK generator.
    secrets = null
  }
  if (!secrets) {
    const sdkConfig = await config()
    try {
      const keys = await sdkConfig.core.generateKeyPairs()
      secrets = {
        version: 3,
        s: keys.s,
        v: keys.v,
        userAddress: Wallet.createRandom().address as `0x${string}`,
        handle: null,
      }
      await writePrivateJson(secretsPath(), secrets)
    } finally { await sdkConfig.destroy() }
  }
  return secrets as CurvySecrets
}

async function config() {
  const { createServerCurvyConfig } = await import('@0xcurvy/curvy-sdk/config')
  return createServerCurvyConfig({
    environment: 'mainnet', apiBaseUrl: process.env.CURVY_API_URL || 'https://api.curvy.box',
    setAsActive: false, enableKeystore: false,
  })
}

async function session() {
  const secrets = await walletSetup()
  if (!secrets.handle) throw new Error('Curvy account is not registered. Run: npm run curvy:register -- <handle.curvy.name> --execute')
  const sdkConfig = await config()
  const { loginWithPrivateKeys } = await import('@0xcurvy/curvy-sdk/actions')
  await loginWithPrivateKeys({ config: sdkConfig, s: secrets.s, v: secrets.v, requestingAddress: secrets.userAddress })
  return { config: sdkConfig, secrets }
}

function findSol(networks: any[]) {
  const solanaNetwork = networks.find((network) => network.flavour === 'solana' && !network.testnet)
  const shieldingNetwork = networks.find((network) => network.flavour === 'evm' && !network.testnet
    && String(network.chainId) === '42161' && network.aggregatorContractAddress
    && network.currencies.some((currency: any) => currency.symbol === 'SOL' && currency.vaultTokenId))
  const sourceCurrency = shieldingNetwork?.currencies.find((currency: any) => currency.symbol === 'SOL' && currency.vaultTokenId)
  const destinationCurrency = solanaNetwork?.currencies.find((currency: any) => currency.symbol === 'SOL')
  if (!solanaNetwork || !shieldingNetwork || !sourceCurrency || !destinationCurrency) {
    throw new Error('Curvy metadata does not currently expose the required Arbitrum SOL -> Solana SOL route')
  }
  return { solanaNetwork, shieldingNetwork, sourceCurrency, destinationCurrency }
}

export async function registerCurvy(handle: string) {
  if (!/^[a-z0-9-]{3,20}\.curvy\.name$/i.test(handle)) {
    throw new Error('Curvy handle must have a 3-20 character letter/number/dash name followed by .curvy.name')
  }
  const secrets = await walletSetup()
  if (secrets.handle) throw new Error(`Curvy test account is already registered as ${secrets.handle}`)
  const sdkConfig = await config()
  try {
    const { registerWithPrivateKeys } = await import('@0xcurvy/curvy-sdk/actions')
    try {
      await registerWithPrivateKeys({ config: sdkConfig, s: secrets.s, v: secrets.v, userAddress: secrets.userAddress, handle: handle as `${string}.curvy.name` })
      await writePrivateJson(secretsPath(), { ...secrets, handle })
      return { protocol: 'curvy', action: 'register', handle, userAddress: secrets.userAddress }
    } catch (error) {
      // Registration and authentication are separate API calls. If authentication
      // fails after registration, preserve the confirmed handle so a later login
      // can retry without attempting to register the same identity again.
      const registeredHandle = await sdkConfig.api.user.GetCurvyIdByOwnerAddress(secrets.userAddress)
      if (registeredHandle?.toLowerCase() !== handle.toLowerCase()) throw error
      await writePrivateJson(secretsPath(), { ...secrets, handle: registeredHandle })
      return {
        protocol: 'curvy', action: 'register', handle: registeredHandle,
        userAddress: secrets.userAddress, registrationConfirmed: true,
        authenticationPending: true,
        authenticationError: error instanceof Error ? error.message : String(error),
      }
    }
  } finally { await sdkConfig.destroy() }
}

export async function snapshot() {
  if (!process.env.ARBITRUM_RPC_URL) throw new Error('ARBITRUM_RPC_URL is required for the Curvy snapshot')
  const sdkConfig = await config()
  try {
    const { getNetworks } = await import('@0xcurvy/curvy-sdk/actions')
    const route = findSol(getNetworks({ config: sdkConfig }))
    const provider = new JsonRpcProvider(process.env.ARBITRUM_RPC_URL, 42161, { staticNetwork: true })
    const vault = route.shieldingNetwork.vaultContractAddress
    if (!vault) throw new Error('Curvy metadata did not provide an Arbitrum Vault address')
    const balances: Record<string, string> = {}
    const tvlUsdByAsset: Record<string, number | null> = {}
    for (const currency of route.shieldingNetwork.currencies.filter((item: any) => item.vaultTokenId)) {
      const amount = currency.nativeCurrency
        ? await provider.getBalance(vault)
        : await new Contract(currency.contractAddress, ['function balanceOf(address) view returns(uint256)'], provider).balanceOf(vault)
      const key = `${currency.symbol}#${currency.vaultTokenId}`
      const formatted = formatUnits(amount, currency.decimals)
      const priceUsd = Number(currency.price)
      balances[key] = formatted
      tvlUsdByAsset[key] = Number.isFinite(priceUsd) && priceUsd > 0 ? Number(formatted) * priceUsd : null
    }
    const knownTvlValues = Object.values(tvlUsdByAsset).filter((value): value is number => value !== null)
    return {
      protocol: 'curvy', chainId: 42161, vault,
      aggregator: route.shieldingNetwork.aggregatorContractAddress,
      balances, tvlUsdByAsset,
      totalTvlUsd: knownTvlValues.length === Object.keys(tvlUsdByAsset).length
        ? knownTvlValues.reduce((sum, value) => sum + value, 0)
        : null,
    }
  } finally { await sdkConfig.destroy() }
}

export async function check() {
  const sdkConfig = await config()
  try {
    const { getNetworks } = await import('@0xcurvy/curvy-sdk/actions')
    const secrets = await walletSetup()
    const localKeys = await sdkConfig.core.getCurvyKeys(secrets.s, secrets.v)
    const registered = secrets.handle ? (await sdkConfig.api.user.ResolveCurvyId(secrets.handle)).data : null
    const networks = getNetworks({ config: sdkConfig })
    const route = findSol(networks)
    const connection = new Connection(solanaRpcUrl(), 'confirmed')
    const portalProgram = route.solanaNetwork.portalProgramAddress
    const portalInfo = portalProgram ? await connection.getAccountInfo(new PublicKey(portalProgram), 'confirmed') : null
    return {
      protocol: 'curvy', vault: route.shieldingNetwork.vaultContractAddress,
      aggregator: route.shieldingNetwork.aggregatorContractAddress,
      metadataMatchesIndexer: route.shieldingNetwork.vaultContractAddress?.toLowerCase() === PROGRAMS.curvyVault.toLowerCase()
        && route.shieldingNetwork.aggregatorContractAddress?.toLowerCase() === PROGRAMS.curvyAggregator.toLowerCase(),
      localIdentityValid: true,
      handle: secrets.handle,
      registeredIdentityMatchesLocalKeys: registered ? registered.publicKeys?.spendingKey === localKeys.S
        && registered.publicKeys?.viewingKey === localKeys.V : null,
      solanaPortalProgram: portalProgram, solanaPortalExecutable: Boolean(portalInfo?.executable),
      sourceNetwork: {
        id: route.shieldingNetwork.id, name: route.shieldingNetwork.name,
        chainId: route.shieldingNetwork.chainId,
      },
      sourceCurrency: route.sourceCurrency,
      destinationNetwork: {
        id: route.solanaNetwork.id, name: route.solanaNetwork.name,
        chainId: route.solanaNetwork.chainId,
      },
      destinationCurrency: route.destinationCurrency,
    }
  } finally { await sdkConfig.destroy() }
}

export async function estimate(lamports: bigint) {
  const sdkConfig = await config()
  try {
    const { estimateExternalTransfer, getNetworks } = await import('@0xcurvy/curvy-sdk/actions')
    const route = findSol(getNetworks({ config: sdkConfig }))
    const estimation = await estimateExternalTransfer({
      config: sdkConfig,
      fromNetwork: route.solanaNetwork,
      fromCurrency: route.destinationCurrency,
      fromAmount: lamports,
      toNetwork: route.solanaNetwork,
      toCurrency: route.destinationCurrency,
      shieldingNetworkSlug: route.shieldingNetwork.slug,
    })
    return {
      protocol: 'curvy', action: 'estimate-external', inputLamports: lamports,
      sourceNetwork: route.solanaNetwork.slug, shieldingNetwork: estimation.shieldingNetwork.slug,
      destinationNetwork: route.solanaNetwork.slug,
      bridgedCurrency: estimation.bridgedCurrency.symbol,
      effectiveLamports: estimation.effectiveAmount, fees: estimation.fees,
    }
  } finally { await sdkConfig.destroy() }
}

export async function curvyPortalStatus(address: string) {
  const sdkConfig = await config()
  try {
    const { getPortalStatus } = await import('@0xcurvy/curvy-sdk/actions')
    return { protocol: 'curvy', action: 'portal-status', address, status: await getPortalStatus({ config: sdkConfig, address }) }
  } finally { await sdkConfig.destroy() }
}

export async function curvyRecoverPortal(address: string, tokenSymbol: string) {
  const current = await session()
  try {
    const { findPortal, getNetworks, recoverPortal } = await import('@0xcurvy/curvy-sdk/actions')
    const route = findSol(getNetworks({ config: current.config }))
    const network = route.shieldingNetwork
    const currency = network.currencies.find((item: any) => item.symbol.toUpperCase() === tokenSymbol.toUpperCase() && item.vaultTokenId)
    if (!currency?.contractAddress) throw new Error(`Curvy metadata has no recoverable ${tokenSymbol.toUpperCase()} token on ${network.name}`)
    const portalRecord = await findPortal({ config: current.config, address, network })
    if (!portalRecord) throw new Error(`The active Curvy identity does not own Portal ${address}`)
    const transactionHash = await recoverPortal({
      config: current.config,
      networkId: network.id,
      tokenAddress: currency.contractAddress,
      portalRecord,
      destinationAddress: current.secrets.userAddress,
    })
    return {
      protocol: 'curvy', action: 'recover-portal', portal: address,
      token: currency.symbol, destination: current.secrets.userAddress, transactionHash,
    }
  } finally { await current.config.destroy() }
}

export async function curvyAuthDiagnostic() {
  const sdkConfig = await config()
  try {
    const secrets = await walletSetup()
    if (!secrets.handle) throw new Error('Curvy account is not registered')
    const localKeys = await sdkConfig.core.getCurvyKeys(secrets.s, secrets.v)
    const generatedKeys = await sdkConfig.core.generateKeyPairs()
    const registered = (await sdkConfig.api.user.ResolveCurvyId(secrets.handle)).data
    if (!registered) throw new Error(`Curvy handle does not resolve: ${secrets.handle}`)
    const nonce = await sdkConfig.api.auth.GetBearerTotp()
    const signer = new Wallet(`0x${localKeys.s.replace(/^0x/, '').padStart(64, '0')}`)
    const uncompressedKey = SigningKey.computePublicKey(signer.privateKey, false)
    const signerPoint = `${BigInt(`0x${uncompressedKey.slice(4, 68)}`)}.${BigInt(`0x${uncompressedKey.slice(68)}`)}`
    const generatedSigner = new Wallet(`0x${generatedKeys.s.replace(/^0x/, '').padStart(64, '0')}`)
    const generatedUncompressedKey = SigningKey.computePublicKey(generatedSigner.privateKey, false)
    const generatedSignerPoint = `${BigInt(`0x${generatedUncompressedKey.slice(4, 68)}`)}.${BigInt(`0x${generatedUncompressedKey.slice(68)}`)}`
    const signature = signer.signingKey.sign(hashMessage(nonce)).serialized
    const recovered = recoverAddress(hashMessage(nonce), signature)
    let authenticationStatus = 200
    let authenticationError: string | null = null
    try {
      await sdkConfig.api.auth.CreateBearerToken({ nonce, signature })
    } catch (error: any) {
      authenticationStatus = Number(error?.statusCode) || 0
      authenticationError = error instanceof Error ? error.message : String(error)
    }
    return {
      protocol: 'curvy', action: 'auth-diagnostic', handle: secrets.handle,
      localSpendKeyFormat: {
        length: localKeys.s.length,
        hexadecimal: /^[0-9a-f]+$/i.test(localKeys.s),
        decimalOnly: /^\d+$/.test(localKeys.s),
        prefixed: localKeys.s.startsWith('0x'),
      },
      corePreservesSpendScalar: localKeys.s === secrets.s,
      registeredKeysMatch: registered.publicKeys?.spendingKey === localKeys.S
        && registered.publicKeys?.viewingKey === localKeys.V,
      registeredSpendingKeyMatchesSigner: registered.publicKeys?.spendingKey === signerPoint,
      sdkGeneratedSpendingKeyMatchesSigner: generatedKeys.S === generatedSignerPoint,
      signatureSelfVerifies: recovered.toLowerCase() === signer.address.toLowerCase(),
      signingAddress: signer.address, nonceLength: nonce.length,
      authenticationStatus, authenticationError,
    }
  } finally { await sdkConfig.destroy() }
}

export async function balance() {
  const current = await session()
  try {
    const { getBalances, getNetworks, refreshBalances } = await import('@0xcurvy/curvy-sdk/actions')
    await refreshBalances({ config: current.config })
    const route = findSol(getNetworks({ config: current.config }))
    const balances = await getBalances({ config: current.config })
    return {
      protocol: 'curvy', currency: 'SOL', vaultTokenId: route.sourceCurrency.vaultTokenId,
      balances: balances.map((balance: any) => ({
        symbol: balance.symbol, decimals: balance.decimals,
        networkSlug: balance.networkSlug, currencyAddress: balance.currencyAddress,
        vaultTokenId: balance.vaultTokenId, balance: balance.balance,
        finality: balance.finality, commitBlockNumber: balance.commitBlockNumber,
      })),
    }
  } finally { await current.config.destroy() }
}

// Curvy swaps between private Vault currencies: <from-symbol> <to-symbol> <base-units>.
export async function swap(args: string[]) {
  return swapCurrencies(args[0], args[1], parseLamports(args[2]))
}

async function swapCurrencies(fromSymbol: string, toSymbol: string, amount: bigint) {
  const from = fromSymbol.toUpperCase()
  const to = toSymbol.toUpperCase()
  if (from === to) throw new Error('Curvy swap input and output currencies must differ')
  const current = await session()
  try {
    const {
      estimateIntent, executeIntent, generateEntryPortal, generateExitPortal,
      getNetworks, getPlanSteps, refreshBalances,
    } = await import('@0xcurvy/curvy-sdk/actions')
    await refreshBalances({ config: current.config })
    const route = findSol(getNetworks({ config: current.config }))
    const network = route.shieldingNetwork
    const sourceCurrency = network.currencies.find((currency: any) => currency.symbol.toUpperCase() === from && currency.vaultTokenId)
    const destinationCurrency = network.currencies.find((currency: any) => currency.symbol.toUpperCase() === to && currency.vaultTokenId)
    if (!sourceCurrency || !destinationCurrency) throw new Error(`Curvy does not expose the requested ${from} -> ${to} Vault route`)

    let entry: Awaited<ReturnType<typeof generateEntryPortal>>
    try {
      entry = await generateEntryPortal({
        config: current.config,
        curvyId: current.secrets.handle as `${string}.curvy.name`,
        currencyId: destinationCurrency.id,
      })
    } catch (error) {
      throw new Error(`Curvy swap entry Portal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    let exit: Awaited<ReturnType<typeof generateExitPortal>>
    try {
      exit = await generateExitPortal({
        config: current.config,
        curvyId: current.secrets.handle as `${string}.curvy.name`,
        currencyId: sourceCurrency.id,
        exitNetworkId: network.id,
        exitCurrencyId: destinationCurrency.id,
        exitAddress: entry.address,
      })
    } catch (error) {
      throw new Error(`Curvy swap exit Portal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (entry.flavour !== 'evm' || exit.flavour !== 'evm') {
      throw new Error(`Expected EVM Curvy swap Portals, received entry=${entry.flavour}, exit=${exit.flavour}`)
    }
    const intent = {
      type: 'curvy-swap' as const,
      amount, currency: sourceCurrency, network,
      exitCurrency: destinationCurrency,
      recipient: exit.address, entryAddress: entry.address,
    }
    const estimation = await estimateIntent({ config: current.config, intent })
    const estimate = {
      requestedInput: amount,
      effectiveAmount: estimation.effectiveAmount,
      gas: estimation.gas,
      curvyFee: estimation.curvyFee,
      bridgeFee: estimation.bridgeFee,
      degradedToFeesOnAmount: estimation.degradedToFeesOnAmount,
      steps: getPlanSteps(estimation.plan),
      sourceCurrency: { id: sourceCurrency.id, symbol: sourceCurrency.symbol, decimals: sourceCurrency.decimals, vaultTokenId: sourceCurrency.vaultTokenId },
      destinationCurrency: { id: destinationCurrency.id, symbol: destinationCurrency.symbol, decimals: destinationCurrency.decimals, vaultTokenId: destinationCurrency.vaultTokenId },
      exitPortal: exit.address, entryPortal: entry.address,
    }
    console.error(`[curvy] swap estimate ${JSON.stringify(estimate, (_key, value) => typeof value === 'bigint' ? value.toString() : value)}`)
    const execution = await executeIntent({ config: current.config, prepared: estimation.prepared })
    return {
      protocol: 'curvy', action: 'swap', from, to, ...estimate,
      executionSucceeded: execution.success,
    }
  } finally { await current.config.destroy() }
}

export async function deposit(lamports: bigint) {
  const current = await session()
  try {
    const { generateEntryPortal, getNetworks } = await import('@0xcurvy/curvy-sdk/actions')
    const route = findSol(getNetworks({ config: current.config }))
    const entry = await generateEntryPortal({
      config: current.config,
      curvyId: current.secrets.handle as `${string}.curvy.name`,
      currencyId: route.destinationCurrency.id,
      coinType: String(route.solanaNetwork.slip0044),
    })
    if (entry.flavour !== 'solana') throw new Error(`Expected a Solana Curvy entry Portal, received ${entry.flavour}`)
    const signer = await loadKeypair()
    const connection = new Connection(solanaRpcUrl(), 'confirmed')
    const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(entry.address), lamports }))
    const signature = await sendAndConfirmTransaction(connection, transaction, [signer], { commitment: 'confirmed' })
    return { protocol: 'curvy', action: 'deposit', signature, entryPortal: entry.address, lamports, note: 'Portal bridging and shielding continue asynchronously.' }
  } finally { await current.config.destroy() }
}

export async function send(recipientAddress: string, lamports: bigint) {
  const recipient = new PublicKey(recipientAddress).toBase58()
  const current = await session()
  try {
    const { estimateIntent, executeIntent, generateExitPortal, getNetworks, refreshBalances } = await import('@0xcurvy/curvy-sdk/actions')
    await refreshBalances({ config: current.config })
    const route = findSol(getNetworks({ config: current.config }))
    const exit = await generateExitPortal({
      config: current.config, curvyId: current.secrets.handle as `${string}.curvy.name`, currencyId: route.sourceCurrency.id,
      exitNetworkId: route.solanaNetwork.id, exitCurrencyId: route.destinationCurrency.id, exitAddress: recipient,
    })
    const intent = {
      type: 'external-transfer' as const, amount: lamports, currency: route.sourceCurrency, network: route.shieldingNetwork,
      recipient: exit.address, exitNetwork: route.solanaNetwork, exitAddress: recipient, exitCurrency: route.destinationCurrency,
    }
    const estimation = await estimateIntent({ config: current.config, intent })
    const result = await executeIntent({ config: current.config, prepared: estimation.prepared })
    return { protocol: 'curvy', action: 'send', recipient, grossLamports: lamports, exitPortal: exit.address, effectiveAmount: estimation.effectiveAmount, result }
  } finally { await current.config.destroy() }
}
