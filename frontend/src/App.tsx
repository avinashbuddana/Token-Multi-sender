import React, { useMemo, useState } from 'react'
import CsvUpload from './components/CsvUpload'
import { connectWallet, switchToChain, CHAINS } from './lib/web3'
import { CsvRow } from './lib/csv'
import { ethers } from 'ethers'
import { erc20Abi, batchAbi } from './lib/contracts'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

type ParsedEntry = { address: string; amountStr: string; amountWei: bigint }
type TokenInfo = { symbol?: string; name?: string; decimals?: number }

export default function App() {
  const [connected, setConnected] = useState<{ address: string; chainId: number } | null>(null)
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null)
  const [signer, setSigner] = useState<ethers.Signer | null>(null)
  const defaultToken = (import.meta.env.VITE_TOKEN_ADDRESS || '0x76E9b54B49739837bE8aD10c3687Fc6b543de852')
  const defaultBatch = (import.meta.env.VITE_BATCH_SENDER_ADDRESS || '')
  const [tokenAddress, setTokenAddress] = useState(defaultToken)
  const [batchAddress, setBatchAddress] = useState(defaultBatch)
  const [rows, setRows] = useState<CsvRow[]>([])
  const [decimals, setDecimals] = useState<number | null>(null)
  const [tokenInfo, setTokenInfo] = useState<TokenInfo>({})
  const [status, setStatus] = useState<string>('')
  const [sending, setSending] = useState(false)
  const [chunkSize, setChunkSize] = useState<number | null>(null)

  const normalized = useMemo(() => {
    const addrs = new Set<string>()
    const dups = new Set<string>()
    const out: ParsedEntry[] = []
    for (const r of rows) {
      try {
        const addr = ethers.getAddress(r.address)
        if (addrs.has(addr)) { dups.add(addr); continue }
        addrs.add(addr)
        if (decimals === null) continue
        const wei = ethers.parseUnits(r.amount, decimals)
        if (wei <= 0n) continue
        out.push({ address: addr, amountStr: r.amount, amountWei: wei })
      } catch {}
    }
    return { entries: out, duplicates: Array.from(dups) }
  }, [rows, decimals])

  const totalWei = useMemo(() => normalized.entries.reduce((a, b) => a + b.amountWei, 0n), [normalized])

  async function onConnect() {
    try {
      const { provider, signer, address, chainId } = await connectWallet()
      setProvider(provider)
      setSigner(signer)
      setConnected({ address, chainId })
      setStatus(`Connected ${address} (chainId ${chainId})`)
    } catch (e: unknown) {
      setStatus(`Connect failed: ${errMsg(e)}`)
    }
  }

  async function switchToBscTestnet() {
    if (!provider) { setStatus('Connect a wallet first'); return }
    try {
      setStatus('Switching to BSC Testnet (97)…')
      const res = await switchToChain(CHAINS.bscTestnet.id)
      setProvider(res.provider)
      setSigner(res.signer)
      setConnected({ address: res.address, chainId: res.chainId })
      setStatus(`Switched to chain ${res.chainId}`)
    } catch (e: unknown) {
      setStatus(`Switch failed: ${errMsg(e)}`)
    }
  }

  async function switchToBscMainnet() {
    if (!provider) { setStatus('Connect a wallet first'); return }
    try {
      setStatus('Switching to BSC Mainnet (56)…')
      const res = await switchToChain(CHAINS.bscMainnet.id)
      setProvider(res.provider)
      setSigner(res.signer)
      setConnected({ address: res.address, chainId: res.chainId })
      setStatus(`Switched to chain ${res.chainId}`)
    } catch (e: unknown) {
      setStatus(`Switch failed: ${errMsg(e)}`)
    }
  }

  async function fetchTokenDetails() {
    if (!signer || !provider || !tokenAddress) return
    try {
      const erc20 = new ethers.Contract(tokenAddress, erc20Abi, signer)
      const [d, symbol, name] = await Promise.all([
        erc20.decimals().catch(() => null),
        erc20.symbol().catch(() => ''),
        erc20.name().catch(() => '')
      ])
      if (typeof d === 'number') setDecimals(d)
      setTokenInfo({ symbol: symbol || undefined, name: name || undefined, decimals: typeof d === 'number' ? d : undefined })
      setStatus(`Token: ${symbol || 'ERC20'}${name ? ` (${name})` : ''}${typeof d === 'number' ? ` • ${d} decimals` : ''}`)
    } catch (e: unknown) {
      setStatus(`Failed to fetch token details: ${errMsg(e)}`)
    }
  }

  async function estimateChunkSize(recips: string[], amts: bigint[], maxTry = Math.min(recips.length, 512)) {
    if (!signer || !provider || !batchAddress || !tokenAddress) return 1
    const batch = new ethers.Contract(batchAddress, batchAbi, signer)
    const latest = await provider.getBlock('latest')
    const blockGasLimit = latest?.gasLimit ?? 30_000_000n
    const gasBudget = BigInt(Math.floor(Number(blockGasLimit) * 0.8))

    async function estCount(count: number): Promise<bigint | null> {
      const r = recips.slice(0, count)
      const a = amts.slice(0, count)
      try {
        const est = await batch.batchTransferERC20.estimateGas(tokenAddress, r, a)
        return est
      } catch {
        return null
      }
    }

    let low = 1
    let high = maxTry
    let safe = 1
    for (let test = 1; test <= high; test *= 2) {
      const est = await estCount(test)
      if (!est || est >= gasBudget) { high = test; break } else { safe = test; low = test }
      if (test === high) break
    }
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2)
      const est = await estCount(mid)
      if (est && est < gasBudget) { safe = mid; low = mid } else { high = mid }
    }
    return Math.max(1, safe)
  }

  async function onSend() {
    if (!signer || !provider) { setStatus('Connect a wallet first'); return }
    if (!tokenAddress || !batchAddress) { setStatus('Enter token and BatchSender addresses'); return }
    if (decimals === null) { setStatus('Fetch token decimals first'); return }
    const recipients = normalized.entries.map(e => e.address)
    const amounts = normalized.entries.map(e => e.amountWei)
    if (recipients.length === 0) { setStatus('No valid entries'); return }
    setSending(true)
    try {
      const batch = new ethers.Contract(batchAddress, batchAbi, signer)
      const token = new ethers.Contract(tokenAddress, erc20Abi, signer)
      const allowance = await token.allowance(await signer.getAddress(), batchAddress)
      if (allowance < totalWei) {
        setStatus('Approving token allowance...')
        const tx = await token.approve(batchAddress, totalWei)
        setStatus(`Approve submitted: ${tx.hash}`)
        await tx.wait()
        setStatus(`Approve confirmed: ${tx.hash}`)
      }
      setStatus('Estimating chunk size...')
      const cSize = await estimateChunkSize(recipients, amounts)
      setChunkSize(cSize)
      setStatus(`Chunk size: ${cSize}`)
      const chunk = <T,>(arr: T[], size: number): T[][] => { const out: T[][] = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out }
      const rChunks = chunk(recipients, cSize)
      const aChunks = chunk(amounts, cSize)
      for (let i = 0; i < rChunks.length; i++) {
        const r = rChunks[i]
        const a = aChunks[i]
        const sum = a.reduce((x, y) => x + y, 0n)
        setStatus(`Sending chunk ${i + 1}/${rChunks.length} (total ${sum.toString()})`)
        const tx = await batch.batchTransferERC20(tokenAddress, r, a)
        setStatus(`Chunk ${i + 1} submitted: ${tx.hash}`)
        const rcpt = await tx.wait()
        const gasUsed = rcpt?.gasUsed ? rcpt.gasUsed.toString() : 'unknown'
        setStatus(`Chunk ${i + 1} confirmed: ${tx.hash} gasUsed=${gasUsed}`)
        await new Promise(res => setTimeout(res, 750))
      }
      setStatus(`Done. Sent ${recipients.length} recipients across ${rChunks.length} chunks.`)
    } catch (e: unknown) {
      setStatus(`Send failed: ${errMsg(e)}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="container">
      <div className="brand"><div className="logo" /> <div className="title">Klink Multi Sender</div></div>
      <p className="muted">Upload a CSV of recipients and amounts, connect your wallet, input the token and BatchSender addresses (pre-filled from env), and send in gas-safe chunks on BSC.</p>

      <div className="row">
        <div className="panel">
          <label>Token (ERC20) Address</label>
          <input value={tokenAddress} onChange={e => setTokenAddress(e.target.value)} placeholder="0x..." />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <button onClick={fetchTokenDetails} disabled={!tokenAddress}>Fetch Token Details</button>
            <span className="badge">{tokenInfo.symbol ? `${tokenInfo.symbol}` : 'ERC20'}</span>
            <span className="badge">{typeof decimals === 'number' ? `${decimals} decimals` : 'decimals: ?'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="secondary" onClick={() => setTokenAddress(defaultToken)}>Use default KLINK token</button>
          </div>
        </div>

        <div className="panel">
          <label>BatchSender Contract Address</label>
          <input value={batchAddress} onChange={e => setBatchAddress(e.target.value)} placeholder="0x..." />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {!connected ? (
              <button onClick={onConnect}>Connect Wallet</button>
            ) : (
              <>
                <button className="secondary" disabled>Connected</button>
                {connected.chainId !== CHAINS.bscMainnet.id && (
                  <button onClick={switchToBscMainnet}>Switch to BSC Mainnet</button>
                )}
              </>
            )}
            <span className="badge">{connected ? `${connected.address.slice(0,6)}… (chain ${connected.chainId})` : 'not connected'}</span>
          </div>
        </div>
      </div>

      <CsvUpload onParsed={setRows} />

      <div className="panel">
        <div className="row">
          <div>
            <div><strong>Entries</strong>: {normalized.entries.length}</div>
            <div className="muted">Duplicates: {normalized.duplicates.length}</div>
          </div>
          <div>
            <div><strong>Total (wei)</strong>: {totalWei.toString()}</div>
            <div className="muted">Chunk size: {chunkSize ?? '-'}</div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={onSend} disabled={sending || !connected || decimals === null || normalized.entries.length === 0}>Send</button>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="muted">Status</div>
          <div>{status}</div>
        </div>
        <table className="table">
          <thead>
            <tr><th>Address</th><th>Amount</th></tr>
          </thead>
          <tbody>
            {normalized.entries.slice(0, 50).map((e, i) => (
              <tr key={i}><td>{e.address}</td><td>{e.amountStr}</td></tr>
            ))}
          </tbody>
        </table>
        {normalized.entries.length > 50 && <div className="muted">Showing first 50 entries…</div>}
        {normalized.duplicates.length > 0 && (
          <div className="status-err">Duplicate addresses detected: {normalized.duplicates.join(', ')}</div>
        )}
      </div>
    </div>
  )
}