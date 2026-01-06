export const erc20Abi = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)'
]

export const batchAbi = [
  'function batchTransferERC20(address token, address[] recipients, uint256[] amounts) external',
  'function batchTransferNative(address[] recipients, uint256[] amounts) external payable'
]