#!/usr/bin/env node
// Convert a JSON array of { address, amount } to CSV "address,amount"
// Usage: node scripts/convert_csvjson_to_csv.mjs --input samples/csvjson.json --output samples/multisend.csv
import fs from 'fs'
import path from 'path'

function parseArgs() {
  const args = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '')
      const next = args[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i++ } else { out[key] = true }
    }
  }
  return out
}

function cleanAmount(raw) {
  if (raw == null) return ''
  const s = String(raw)
  // strip $ and , then trim
  const cleaned = s.replace(/\$/g, '').replace(/,/g, '').trim()
  // basic validation: allow digits with optional dot
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return ''
  return cleaned
}

function normalizeAddress(addr) {
  if (!addr) return ''
  return String(addr).trim()
}

function convert(jsonText) {
  const data = JSON.parse(jsonText)
  if (!Array.isArray(data)) throw new Error('JSON must be an array')
  const rows = []
  for (let i = 0; i < data.length; i++) {
    const item = data[i]
    const address = normalizeAddress(item.address || item.addr || item.to)
    const amount = cleanAmount(item.amount || item.value)
    if (!address || !amount) {
      // skip invalid rows
      continue
    }
    rows.push({ address, amount })
  }
  let csv = 'address,amount\n'
  csv += rows.map(r => `${r.address},${r.amount}`).join('\n')
  return csv
}

async function main() {
  const args = parseArgs()
  const input = args.input || 'samples/csvjson.json'
  const output = args.output || 'samples/multisend.csv'
  const absIn = path.isAbsolute(input) ? input : path.join(process.cwd(), input)
  const absOut = path.isAbsolute(output) ? output : path.join(process.cwd(), output)
  const content = fs.readFileSync(absIn, 'utf8')
  const csv = convert(content)
  fs.writeFileSync(absOut, csv)
  console.log(`Wrote ${rowsCount(csv)} rows to ${output}`)
}

function rowsCount(csv) {
  // minus header
  const lines = csv.split(/\r?\n/).filter(Boolean)
  return Math.max(0, lines.length - 1)
}

main().catch(err => {
  console.error('Conversion failed:', err?.message || err)
  process.exit(1)
})