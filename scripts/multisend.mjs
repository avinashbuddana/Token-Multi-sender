// ESM script for batch ERC20 transfers using BatchSender on BSC testnet
// Usage:
//   ERC20: node scripts/multisend.mjs --input ./samples/multisend.json --token 0xToken --batch 0xBatchSender 
//   Native: node scripts/multisend.mjs --input ./samples/multisend.json --batch 0xBatchSender --native
// Env vars: PRIVATE_KEY, RPC_URL, MAX_GAS_FRACTION, TOKEN_ADDRESS, BATCH_SENDER_ADDRESS, DECIMALS, NATIVE

// Load environment variables from .env (requires `npm install dotenv`)
import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Minimal ABIs
const erc20Abi = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

const batchAbi = [
  'function batchTransferERC20(address token, address[] recipients, uint256[] amounts) external',
  'function batchTransferNative(address[] recipients, uint256[] amounts) external payable'
];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function isJsonFile(filePath) {
  return filePath.toLowerCase().endsWith('.json');
}

function isCsvFile(filePath) {
  return filePath.toLowerCase().endsWith('.csv');
}

function parseJsonRecipients(jsonStr) {
  const data = JSON.parse(jsonStr);
  if (!Array.isArray(data)) throw new Error('JSON must be an array');
  return data.map((item, idx) => {
    const address = String(item.address ?? item.addr ?? item.to ?? '').trim();
    const rawAmount = String(item.amount ?? item.value ?? '').trim();
    const amountStr = normalizeAmountString(rawAmount);
    if (!address || !amountStr) throw new Error(`Invalid entry at index ${idx}`);
    return { address, amountStr };
  });
}

function parseCsvRecipients(csvStr) {
  const lines = csvStr.split(/\r?\n/).filter(l => l.trim().length > 0);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0 && /address/i.test(line) && /amount/i.test(line)) {
      // header row, skip
      continue;
    }
    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 2) throw new Error(`CSV line ${i + 1} must have address,amount`);
    const [address, rawAmount] = parts;
    const amountStr = normalizeAmountString(rawAmount);
    out.push({ address, amountStr });
  }
  return out;
}

async function loadRecipients(inputPath) {
  const absolute = path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
  const content = fs.readFileSync(absolute, 'utf8');
  if (isJsonFile(inputPath)) return parseJsonRecipients(content);
  if (isCsvFile(inputPath)) return parseCsvRecipients(content);
  throw new Error('Unsupported input format. Use .json or .csv');
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function normalizeAmountString(amountStr) {
  // Remove $ currency symbol and thousands separators, keep digits and decimal point
  const cleaned = String(amountStr).trim().replace(/\$/g, '').replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`Invalid amount: ${amountStr}`);
  }
  return cleaned;
}

async function main() {
  const args = parseArgs();
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const RPC_URL = process.env.RPC_URL || 'https://bsc-testnet.bnbchain.org';
  const MAX_GAS_FRACTION = Number(process.env.MAX_GAS_FRACTION || '0.8'); // safety fraction of block gas limit
  const verbose = (args.verbose === true) || (process.env.VERBOSE === 'true');

  const RATE_LIMIT_RPS = Number(process.env.RATE_LIMIT_RPS || '5');
  const RATE_LIMIT_INTERVAL_MS = Number(process.env.RATE_LIMIT_INTERVAL_MS || (RATE_LIMIT_RPS > 0 ? Math.floor(1000 / RATE_LIMIT_RPS) : 0));
  const RETRY_MAX_ATTEMPTS = Number(process.env.RETRY_MAX_ATTEMPTS || '5');
  const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || '500');
  const RETRY_MAX_MS = Number(process.env.RETRY_MAX_MS || '5000');
  const SLEEP_BETWEEN_TX_MS = Number(process.env.SLEEP_BETWEEN_TX_MS || '750');
  const CHECKPOINT_FILE = process.env.CHECKPOINT_FILE || '.multisend-checkpoints.json';
  const DISABLE_CHECKPOINTS = (process.env.DISABLE_CHECKPOINTS === 'true') || (args.noCheckpoint === true);

  const defaultInput = './samples/csvjson.json';
  const input = args.input || process.env.INPUT_FILE || defaultInput;
  const tokenAddress = process.env.TOKEN_ADDRESS || args.token;
  const batchAddress = process.env.BATCH_SENDER_ADDRESS || args.batch;
  const decimalsOverride = process.env.DECIMALS ? Number(process.env.DECIMALS) : undefined;
  const isNative = (process.env.NATIVE === 'true') || (args.native === true);

  if (!PRIVATE_KEY) throw new Error('Set PRIVATE_KEY env');
  // If input was not provided, we default to samples/csvjson.json
  if (!args.input && !process.env.INPUT_FILE) {
    console.log(`[Config] --input not provided; using default: ${defaultInput}`);
  }
  if (!batchAddress) throw new Error('--batch BatchSender contract address is required or set BATCH_SENDER_ADDRESS');
  if (!isNative && !tokenAddress) throw new Error('ERC20 mode requires --token or TOKEN_ADDRESS');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const batch = new ethers.Contract(batchAddress, batchAbi, wallet);

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let lastCallAt = 0;
  async function limitPace() {
    if (!RATE_LIMIT_INTERVAL_MS || RATE_LIMIT_INTERVAL_MS <= 0) return;
    const now = Date.now();
    const wait = lastCallAt + RATE_LIMIT_INTERVAL_MS - now;
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
  }
  function isRateLimitError(e) {
    const msg = String(e?.message || '').toLowerCase();
    return e?.status === 429 || /429|rate limit|too many requests/.test(msg);
  }
  async function callWithRetry(fn, label = 'rpc') {
    let attempt = 0;
    let delay = RETRY_BASE_MS;
    for (;;) {
      try {
        await limitPace();
        return await fn();
      } catch (e) {
        attempt++;
        const rateLimited = isRateLimitError(e);
        if (!rateLimited && attempt >= RETRY_MAX_ATTEMPTS) throw e;
        if (attempt >= RETRY_MAX_ATTEMPTS) throw e;
        const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(delay * 0.2)));
        const waitMs = Math.min(delay + jitter, RETRY_MAX_MS);
        if (verbose) console.warn(`[RateLimit] ${label} attempt ${attempt} failed: waiting ${waitMs}ms`);
        await sleep(waitMs);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
  }

  console.log(`[Input] Reading recipients from: ${input}`);
  const entries = await loadRecipients(input);
  console.log(`[Input] Loaded ${entries.length} entries`);

  // Pre-check: ensure no duplicate recipient addresses in the input file
  const seenAddresses = new Set();
  const duplicateAddresses = new Set();
  for (const { address } of entries) {
    try {
      const norm = ethers.getAddress(address);
      if (seenAddresses.has(norm)) duplicateAddresses.add(norm);
      else seenAddresses.add(norm);
    } catch (_) {
      // ignore invalid addresses in duplicate check; they are handled later
    }
  }
  if (duplicateAddresses.size > 0) {
    throw new Error(`Duplicate recipient addresses found in input: ${Array.from(duplicateAddresses).join(', ')}`);
  }

  const absoluteInput = path.isAbsolute(input) ? input : path.join(process.cwd(), input);
  const sessionId = crypto.createHash('sha256').update(
    `${wallet.address}|${batchAddress}|${isNative ? 'native' : tokenAddress}|${absoluteInput}`
  ).digest('hex');
  let checkpoints = {};
  if (!DISABLE_CHECKPOINTS && fs.existsSync(CHECKPOINT_FILE)) {
    try {
      checkpoints = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8')) || {};
    } catch (e) {
      console.warn(`[Checkpoint] Failed to read ${CHECKPOINT_FILE}, starting fresh`);
      checkpoints = {};
    }
  }
  const sentKeys = new Set((checkpoints[sessionId]?.sentKeys) || []);
  const makeKey = (address, amountStr) => `${address}|${amountStr}`;
  let decimals = 18;
  let token;
  if (!isNative) {
    token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
    if (decimalsOverride !== undefined) {
      decimals = decimalsOverride;
    } else {
      try {
        decimals = await callWithRetry(() => token.decimals(), 'token.decimals');
      } catch (e) {
        console.warn('Token decimals() not available; defaulting to 18. Set DECIMALS in .env to override.');
        decimals = 18;
      }
    }
  } else {
    decimals = 18; // native BNB uses 18 decimals (wei)
  }

  // Validate and normalize addresses, amounts
  const validEntries = [];
  let skippedInvalid = 0;
  let skippedZero = 0;
  for (const { address, amountStr } of entries) {
    if (!ethers.isAddress(address)) {
      skippedInvalid++;
      if (verbose) console.log(`[Parse] Skipping invalid address: ${address}`);
      continue;
    }
    const amt = isNative ? ethers.parseEther(amountStr) : ethers.parseUnits(amountStr, decimals);
    if (amt <= 0n) {
      skippedZero++;
      if (verbose) console.log(`[Parse] Skipping zero/negative amount for ${address}: ${amountStr}`);
      continue; // skip zero/negative
    }
    const key = makeKey(address, amountStr);
    if (DISABLE_CHECKPOINTS || !sentKeys.has(key)) {
      validEntries.push({ address, amountStr, amt });
      if (verbose) console.log(`[Parse] ${address} => ${amountStr} (${amt} units)`);
    } else if (verbose) {
      console.log(`[Resume] Skipping already-sent entry: ${address} ${amountStr}`);
    }
  }

  if (validEntries.length === 0) throw new Error('No valid recipients/amounts remaining');
  const recipients = validEntries.map(e => e.address);
  const amounts = validEntries.map(e => e.amt);
  console.log(`[Parse] Valid recipients: ${recipients.length}, skipped invalid: ${skippedInvalid}, skipped zero: ${skippedZero}, already sent skipped: ${sentKeys.size}`);

  // Total amount
  const total = amounts.reduce((a, b) => a + b, 0n);
  if (!isNative) {
    const allowance = await callWithRetry(() => token.allowance(wallet.address, batchAddress), 'token.allowance');
    console.log(`[Approve] Current allowance: ${allowance}, required total: ${total}`);
    if (allowance < total) {
      console.log(`[Approve] Sending approve for ${total} to BatchSender ${batchAddress}...`);
      const tx = await callWithRetry(() => token.approve(batchAddress, total), 'token.approve');
      await callWithRetry(() => tx.wait(), 'tx.wait');
      console.log(`[Approve] Confirmed: ${tx.hash}`);
    } else {
      console.log('[Approve] Sufficient allowance exists, skipping approve');
    }
  } else {
    const balance = await callWithRetry(() => provider.getBalance(wallet.address), 'provider.getBalance');
    console.log(`[Balance] Native balance: ${balance}, required total: ${total}`);
    if (balance < total) {
      throw new Error(`Insufficient native balance. Required: ${total}, Available: ${balance}`);
    }
  }

  // Estimate block gas limit and choose chunk size
  const latest = await callWithRetry(() => provider.getBlock('latest'), 'provider.getBlock');
  const blockGasLimit = latest?.gasLimit ?? 30_000_000n; // fallback
  const gasBudget = BigInt(Math.floor(Number(blockGasLimit) * MAX_GAS_FRACTION));
  console.log(`[Gas] blockGasLimit=${blockGasLimit} gasBudget(frac=${MAX_GAS_FRACTION})=${gasBudget}`);

  async function estimateForCount(count) {
    const r = recipients.slice(0, count);
    const a = amounts.slice(0, count);
    try {
      if (isNative) {
        const val = a.reduce((x, y) => x + y, 0n);
        const est = await callWithRetry(() => batch.batchTransferNative.estimateGas(r, a, { value: val }), 'estimateGas.native');
        return est;
      } else {
        const est = await callWithRetry(() => batch.batchTransferERC20.estimateGas(tokenAddress, r, a), 'estimateGas.erc20');
        return est;
      }
    } catch (e) {
      return null;
    }
  }

  // Find a safe chunk size: try doubling until it fails or exceeds gas budget, then binary search
  let low = 1;
  let high = Math.min(recipients.length, 512); // cap initial exploration
  let safe = 1;

  for (let test = 1; test <= high; test *= 2) {
    const est = await estimateForCount(test);
    if (verbose) console.log(`[Estimate] try count=${test} => gas=${est}`);
    if (!est || est >= gasBudget) {
      high = test;
      break;
    } else {
      safe = test;
      low = test;
    }
    if (test === high) break;
  }

  // Binary search between low and high to refine
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    const est = await estimateForCount(mid);
    if (verbose) console.log(`[Estimate] mid=${mid} => gas=${est}`);
    if (est && est < gasBudget) {
      safe = mid;
      low = mid;
    } else {
      high = mid;
    }
  }

  const chunkSize = Math.max(1, safe);
  console.log(`[Chunk] Using chunk size: ${chunkSize} (recipients per tx)`);

  // Send in chunks
  const recipientChunks = chunk(recipients, chunkSize);
  const amountChunks = chunk(amounts, chunkSize);
  const entryChunks = chunk(validEntries, chunkSize);

  for (let i = 0; i < entryChunks.length; i++) {
    const entriesChunk = entryChunks[i];
    const r = entriesChunk.map(e => e.address);
    const a = entriesChunk.map(e => e.amt);
    const sum = a.reduce((x, y) => x + y, 0n);
    console.log(`[Send] Chunk ${i + 1}/${recipientChunks.length} recipients=${r.length} total=${sum}`);
    if (verbose) console.log(`[Send] Addresses: ${r.join(', ')}`);
    try {
      let tx, rcpt;
      if (isNative) {
        tx = await callWithRetry(() => batch.batchTransferNative(r, a, { value: sum }), 'batch.native');
      } else {
        tx = await callWithRetry(() => batch.batchTransferERC20(tokenAddress, r, a), 'batch.erc20');
      }
      console.log(`[Send] Submitted tx: ${tx.hash}`);
      rcpt = await callWithRetry(() => tx.wait(), 'tx.wait');
      console.log(`[Send] Confirmed: ${tx.hash} gasUsed=${rcpt?.gasUsed}`);
      // Mark entries as sent
      if (!DISABLE_CHECKPOINTS) {
        const newlySent = entriesChunk.map(e => makeKey(e.address, e.amountStr));
        const updated = new Set(sentKeys);
        newlySent.forEach(k => updated.add(k));
        checkpoints[sessionId] = { sentKeys: Array.from(updated) };
        try {
          fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoints, null, 2));
          if (verbose) console.log(`[Checkpoint] Updated ${CHECKPOINT_FILE} (${newlySent.length} new)`);
        } catch (e) {
          console.warn(`[Checkpoint] Failed to write ${CHECKPOINT_FILE}:`, e);
        }
        // Update in-memory set for subsequent chunks
        newlySent.forEach(k => sentKeys.add(k));
      }
      if (SLEEP_BETWEEN_TX_MS > 0) {
        if (verbose) console.log(`[Pace] Sleeping ${SLEEP_BETWEEN_TX_MS}ms before next chunk`);
        await sleep(SLEEP_BETWEEN_TX_MS);
      }
    } catch (e) {
      console.error(`[Send] Chunk ${i + 1} failed:`, e);
      throw e;
    }
  }

  console.log(`[Done] All chunks sent successfully. chunks=${recipientChunks.length} recipients=${recipients.length} total=${total}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});