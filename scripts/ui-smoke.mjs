const target = process.argv[2] || 'http://127.0.0.1:8787'
const debugPort = process.env.CHROME_DEBUG_PORT || '9223'
const page = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' }).then((response) => response.json())
const socket = new WebSocket(page.webSocketDebuggerUrl)
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Browser smoke test timed out')), 10_000)
  socket.addEventListener('open', () => setTimeout(() => socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const setInput = (input, value) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        setInput(document.querySelector('[aria-label="Amount"]'), '1')
        await new Promise((done) => setTimeout(done, 100))
        document.querySelector('[aria-label="Add receiver"]').click()
        await new Promise((done) => setTimeout(done, 300))
        const addressFields = document.querySelectorAll('[aria-label^="Receiver "][aria-label$=" address"]').length
        const amountFields = document.querySelectorAll('[aria-label^="Receiver "][aria-label$=" amount"]').length
        document.querySelector('[aria-label="Remove receiver 2"]').click()
        await new Promise((done) => setTimeout(done, 100))
        setInput(document.querySelector('[aria-label="Receiver 1 address"]'), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
        await new Promise((done) => setTimeout(done, 900))
        document.querySelector('.statsDisclosure').open = true
        await new Promise((done) => setTimeout(done, 100))
        const removedCardCopy = ['Private swap via', 'Multi-recipient', 'Single recipient', 'Cover ratio', 'Weighted similar cover', 'PROTOCOL EXECUTION', 'HIGH confidence']
          .every((copy) => !document.querySelector('.planRankings')?.innerText.includes(copy))
        const alternativeButton = document.querySelector('.alternativePools .selectPool')
        const alternativeName = alternativeButton?.closest('.planCard')?.querySelector('h2')?.textContent
        alternativeButton?.click()
        await new Promise((done) => setTimeout(done, 100))
        const selectedAlternative = Boolean(alternativeName) && document.querySelector('.primaryPool h2')?.textContent === alternativeName
        document.querySelector('[aria-label="Destination asset"]').click()
        await new Promise((done) => setTimeout(done, 100))
        const destinationOptions = [...document.querySelectorAll('.destinationAssetMenu button')].map((button) => button.textContent.trim())
        ;[...document.querySelectorAll('.destinationAssetMenu button')].find((button) => button.textContent.trim() === 'SOL')?.click()
        await new Promise((done) => setTimeout(done, 900))
        const swapHeading = document.querySelector('h1')?.textContent
        const swapWinner = document.querySelector('.primaryPool h2')?.textContent
        const unavailableCopy = [...document.querySelectorAll('.planCard.unavailable')].map((card) => card.innerText).join(' ')
        const routeFiltering = swapWinner === 'Curvy' && unavailableCopy.includes('CLOAKC swaps only from SOL') && unavailableCopy.includes('SOON')
        const swapRecipient = Boolean(document.querySelector('.recipientSwapAsset')) && !document.querySelector('[aria-label="Add receiver"]')
        const sendCardBounds = document.querySelector('.sendCard').getBoundingClientRect()
        const statsBounds = document.querySelector('.statsDisclosure').getBoundingClientRect()
        const cards = [...document.querySelectorAll('.planRankings .planCard')].map((card) => card.getBoundingClientRect())
        const cardsDoNotOverlap = cards.every((card, index) => cards.slice(index + 1).every((other) => card.right <= other.left || other.right <= card.left || card.bottom <= other.top || other.bottom <= card.top))
        window.solana = {
          connect: async () => ({ publicKey: '11111111111111111111111111111111' }),
          disconnect: async () => {},
          on: () => {},
          off: () => {},
        }
        document.querySelector('.actionArea > button').click()
        await new Promise((done) => setTimeout(done, 100))
        const maxBalanceVisible = Boolean(document.querySelector('.walletMax')?.textContent.includes('MAX'))
        const disconnect = document.querySelector('[aria-label="Disconnect wallet"]')
        const disconnectVisible = Boolean(disconnect)
        disconnect?.click()
        await new Promise((done) => setTimeout(done, 100))
        return {
          heading: document.querySelector('h1')?.textContent,
          addressFields,
          amountFields,
          removedCardCopy,
          selectedAlternative,
          swapHeading,
          routeFiltering,
          swapRecipient,
          destinationOptions,
          centerDelta: Math.abs((sendCardBounds.left + sendCardBounds.right) / 2 - document.documentElement.clientWidth / 2),
          statsWider: document.documentElement.clientWidth <= 760 || statsBounds.width > sendCardBounds.width,
          cardsDoNotOverlap,
          maxBalanceVisible,
          disconnectVisible,
          disconnected: document.querySelector('.actionArea > button')?.textContent.includes('Connect wallet'),
          fatal: document.body.innerText.includes('Something went wrong'),
        }
      })()`,
    },
  })), 1_000))
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timeout)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
})
socket.close()
if (result.heading !== 'Swap privately' || result.swapHeading !== 'Swap privately' || result.addressFields !== 2 || result.amountFields !== 2 || !result.removedCardCopy || !result.selectedAlternative || !result.routeFiltering || !result.swapRecipient || !result.statsWider || !result.cardsDoNotOverlap || result.centerDelta > 1 || !result.maxBalanceVisible || !result.disconnectVisible || !result.disconnected || result.fatal) {
  throw new Error(`Unexpected UI state: ${JSON.stringify(result)}`)
}
console.log(JSON.stringify(result))
