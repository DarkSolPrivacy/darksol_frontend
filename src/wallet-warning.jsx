import { useEffect, useRef, useState } from 'react'

// Flip to false once the major wallets have whitelisted the site.
const WALLETS_PENDING = true

let show = null
let acknowledged = false

// Resolves true when the person chooses to continue. Asked once per page load,
// before the first payment or private send; the answer is not stored.
export function confirmWalletWarning() {
  if (!WALLETS_PENDING || acknowledged || !show) return Promise.resolve(true)
  return new Promise((resolve) => show({ resolve }))
}

export function WalletWarning() {
  const dialog = useRef(null)
  const [ask, setAsk] = useState(null)
  useEffect(() => { show = setAsk; return () => { show = null } }, [])
  useEffect(() => { ask ? dialog.current?.showModal() : dialog.current?.close() }, [ask])
  const answer = (proceed) => { acknowledged ||= proceed; ask?.resolve(proceed); setAsk(null) }
  return <dialog className="paymentDialog" ref={dialog} aria-labelledby="walletWarningTitle" onClose={() => ask && answer(false)}>
    {ask && <>
      <h3 id="walletWarningTitle">Your wallet may warn you about DarkSol</h3>
      <p>We have asked the major wallets to whitelist this site and are still waiting for approval, which can take a few days. Until then, wallets such as Phantom may show a warning when you connect or sign.</p>
      <p>Nothing moves without your approval in your own wallet. If you continue, expect to see that warning.</p>
      <div className="paymentDialogActions">
        <button className="ghost" type="button" autoFocus onClick={() => dialog.current.close()}>Cancel</button>
        <button className="paymentPrimary" type="button" onClick={() => answer(true)}>Continue anyway</button>
      </div>
    </>}
  </dialog>
}
