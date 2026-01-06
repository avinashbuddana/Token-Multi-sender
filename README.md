# BatchSender

Send ERC20 tokens or native ETH to multiple addresses in a single transaction.

Contract file: `contracts/BatchSender.sol`

## What it does

- `batchTransferERC20(token, recipients, amounts)`: Pulls ERC20 tokens from your wallet and sends to each recipient.
- `batchTransferNative(recipients, amounts)`: Splits `msg.value` across recipients as native ETH.

## How to use (ERC20)

1. Calculate the total amount you want to send: `total = sum(amounts)`.
2. Call the token's `approve(batchSenderAddress, total)` from your wallet.
3. Call `batchTransferERC20(token, recipients, amounts)` from the same wallet.

If any transfer fails, the whole transaction reverts (no partial sends).

### Example (ethers.js)

```js
const token = new ethers.Contract(tokenAddress, [
  "function approve(address spender, uint256 amount) external returns (bool)"
], signer);

const batch = new ethers.Contract(batchSenderAddress, [
  "function batchTransferERC20(address token, address[] recipients, uint256[] amounts) external"
], signer);

const recipients = ["0xA...", "0xB...", "0xC..."];
const amounts = [ethers.parseUnits("10", 18), ethers.parseUnits("5", 18), ethers.parseUnits("2", 18)];
const total = amounts.reduce((a, b) => a + b, 0n);

await token.approve(batchSenderAddress, total);
await batch.batchTransferERC20(tokenAddress, recipients, amounts);
```

## How to use (native ETH)

1. Calculate `total = sum(amounts)`.
2. Call `batchTransferNative(recipients, amounts)` with `value = total`.

### Example (ethers.js)

```js
const batch = new ethers.Contract(batchSenderAddress, [
  "function batchTransferNative(address[] recipients, uint256[] amounts) external payable"
], signer);

const recipients = ["0xA...", "0xB..."];
const amounts = [ethers.parseEther("0.1"), ethers.parseEther("0.2")];
const total = amounts.reduce((a, b) => a + b, 0n);

await batch.batchTransferNative(recipients, amounts, { value: total });
```

## Notes

- Arrays must be same length and non-empty; zero amounts are skipped.
- For ERC20, the contract uses low-level calls to support non-standard tokens.
- Beware block gas limits: very large recipient lists can run out of gas.
- No state is stored; reentrancy is not a concern here.

## How to use (Frontend Web App)

No private key is required. You will connect your browser wallet (e.g., MetaMask).

1. Navigate to the `frontend` directory:
   ```bash
   cd frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```
4. Open the link (usually `http://localhost:5173`) in your browser.
5. Connect your wallet, select your file, and click "Send".

## BSC Testnet Multisend Script

Use the provided ESM Node.js script to send tokens in batches from a CSV or JSON file. The script auto-estimates a safe recipients-per-transaction chunk size based on current block gas limits.

**IMPORTANT:** This script requires your wallet's `PRIVATE_KEY` to be set in the `.env` file to sign transactions automatically. If you do not want to expose your private key, use the [Frontend Web App](#how-to-use-frontend-web-app) instead.

### Prerequisites

- Node.js 18+
- Install ethers v6: `npm install ethers`
- Install dotenv: `npm install dotenv`
- Deployed `BatchSender` contract and your token on BSC Testnet

### Sample input

- JSON: `samples/multisend.json`
```json
[
  { "address": "0x0000000000000000000000000000000000000001", "amount": "100" },
  { "address": "0x0000000000000000000000000000000000000002", "amount": "50.5" },
  { "address": "0x0000000000000000000000000000000000000003", "amount": "25" }
]
```

- CSV (header optional):
```
address,amount
0x0000000000000000000000000000000000000001,100
0x0000000000000000000000000000000000000002,50.5
0x0000000000000000000000000000000000000003,25
```

### Run (ERC20 token)

Create a `.env` file (copy from `.env.example`) and execute:

```
# .env values are loaded automatically
# You can pass token/batch via CLI flags or .env
node scripts/multisend.mjs \
  --input ./samples/csvjson.json \
  --token 0xYourKLINKTokenAddress \
  --batch 0xYourBatchSenderAddress
```

The script will:
- Read recipients and amounts
- Fetch token `decimals` and normalize amounts
- Check/approve the total amount to `BatchSender`
- Estimate a safe chunk size, then send in multiple transactions until all recipients are paid

- Or set in `.env` instead of CLI flags:
```
TOKEN_ADDRESS=0xYourKLINKTokenAddress
BATCH_SENDER_ADDRESS=0xYourBatchSenderAddress
INPUT_FILE=./samples/csvjson.json
```

### Run (native BNB)

```
# Set BATCH_SENDER_ADDRESS in .env or pass via CLI
node scripts/multisend.mjs \
  --input ./samples/csvjson.json \
  --batch 0xYourBatchSenderAddress \
  --native
```

Amounts are interpreted as ether values (e.g., `"0.1"` => `0.1 BNB`). Ensure your wallet has enough BNB to cover all chunks.

If you omit `--input` and `INPUT_FILE`, the script defaults to `./samples/csvjson.json`.

### Notes
- Approval is only required if current allowance < total to send
- Invalid addresses or zero/negative amounts are skipped or cause errors
- If estimation fails due to node limits, the script falls back to conservative chunk sizes
- For native ETH, you can adapt the script to use `batchTransferNative` similarly (compute `msg.value` per chunk)

### RPC Rate Limiting (Infura, etc.)

Some RPC providers throttle requests (e.g., 429 Too Many Requests). The script includes built-in pacing and retries:

- Adds a small delay between RPC calls based on `RATE_LIMIT_RPS` or `RATE_LIMIT_INTERVAL_MS`.
- Retries transient/rate-limit errors with exponential backoff up to `RETRY_MAX_ATTEMPTS`.
- Sleeps between chunk transactions via `SLEEP_BETWEEN_TX_MS` to avoid broadcast spikes.

Configure in `.env`:

```
# Pace calls (~requests per second)
RATE_LIMIT_RPS=5
# Or fixed interval between calls (ms)
# RATE_LIMIT_INTERVAL_MS=200

# Retry settings
RETRY_MAX_ATTEMPTS=5
RETRY_BASE_MS=500
RETRY_MAX_MS=5000

# Sleep between transactions (ms)
SLEEP_BETWEEN_TX_MS=750
```

You can also enable detailed logs with `--verbose` or `VERBOSE=true` to see pacing/retry behavior while running.

### Resume on Re-run (Checkpoints)

If a transaction fails mid-way or you re-run the script, it will skip entries that were already sent in a previous run.

- The script maintains a local checkpoint file keyed by session (sender, batch, asset, input path).
- After each confirmed chunk, it records the `address|amount` keys as sent.
- On the next run, those entries are filtered out automatically.

Configure in `.env`:

```
# Where to store checkpoints
CHECKPOINT_FILE=.multisend-checkpoints.json
# Disable checkpoints if you want to always send all entries
# DISABLE_CHECKPOINTS=false
```

Notes:
- Checkpoints are local-only and do not read on-chain state.
- If you change amounts for an address, it is treated as a new entry (keys are `address|amount`).
- For safety, review the remaining entries before sending; use `--verbose` to see exactly what will be sent.
