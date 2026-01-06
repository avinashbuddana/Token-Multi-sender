export type CsvRow = { address: string; amount: string }

export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  const rows: CsvRow[] = []
  let start = 0
  if (lines[0] && /address/i.test(lines[0]) && /amount/i.test(lines[0])) start = 1
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].split(',').map(s => s.trim())
    if (parts.length < 2) throw new Error(`CSV line ${i + 1} must have address,amount`)
    const [address, rawAmount] = parts
    const cleaned = rawAmount.replace(/\$/g, '').replace(/,/g, '')
    if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new Error(`Invalid amount at line ${i + 1}: ${rawAmount}`)
    rows.push({ address, amount: cleaned })
  }
  return rows
}