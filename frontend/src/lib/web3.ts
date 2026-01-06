import { ethers } from 'ethers'

export const CHAINS = {
  bscMainnet: {
    id: 56,
    hex: '0x38',
    addParams: {
      chainId: '0x38',
      chainName: 'BNB Smart Chain',
      nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
      rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
      blockExplorerUrls: ['https://bscscan.com']
    }
  },
  bscTestnet: {
    id: 97,
    hex: '0x61',
    addParams: {
      chainId: '0x61',
      chainName: 'BNB Smart Chain Testnet',
      nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
      rpcUrls: ['https://bsc-testnet.bnbchain.org'],
      blockExplorerUrls: ['https://testnet.bscscan.com']
    }
  }
} as const

export async function getProvider(): Promise<ethers.BrowserProvider> {
  const anyWin = window as any
  if (!anyWin.ethereum) throw new Error('No injected wallet found. Please install MetaMask.')
  return new ethers.BrowserProvider(anyWin.ethereum)
}

export async function connectWallet(): Promise<{ provider: ethers.BrowserProvider; signer: ethers.Signer; address: string; chainId: number }>{
  const provider = await getProvider()
  await provider.send('eth_requestAccounts', [])
  const signer = await provider.getSigner()
  const address = await signer.getAddress()
  const net = await provider.getNetwork()
  return { provider, signer, address, chainId: Number(net.chainId) }
}

export async function switchToChain(targetChainId: number): Promise<{ provider: ethers.BrowserProvider; signer: ethers.Signer; address: string; chainId: number }>{
  const anyWin = window as any
  if (!anyWin.ethereum) throw new Error('No injected wallet found. Install MetaMask.')

  const targetHex = targetChainId === CHAINS.bscTestnet.id
    ? CHAINS.bscTestnet.hex
    : targetChainId === CHAINS.bscMainnet.id
      ? CHAINS.bscMainnet.hex
      : `0x${targetChainId.toString(16)}`

  try {
    await anyWin.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: targetHex }] })
  } catch (err: any) {
    if (err && (err.code === 4902 || err.code === -32603)) {
      const params = targetChainId === CHAINS.bscTestnet.id ? CHAINS.bscTestnet.addParams : CHAINS.bscMainnet.addParams
      await anyWin.ethereum.request({ method: 'wallet_addEthereumChain', params: [params] })
      await anyWin.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: targetHex }] })
    } else {
      throw err
    }
  }

  // Recreate provider/signer AFTER the network change to avoid ethers NETWORK_ERROR
  const provider = new ethers.BrowserProvider(anyWin.ethereum)
  const signer = await provider.getSigner()
  const address = await signer.getAddress()
  const net = await provider.getNetwork()
  return { provider, signer, address, chainId: Number(net.chainId) }
}