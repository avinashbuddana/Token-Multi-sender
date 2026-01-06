import React from 'react'
import { parseCsv, CsvRow } from '../lib/csv'

type Props = {
  onParsed: (rows: CsvRow[]) => void
}

export default function CsvUpload({ onParsed }: Props) {
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const rows = parseCsv(text)
    onParsed(rows)
  }
  return (
    <div className="panel">
      <label>Upload CSV (address,amount)</label>
      <input type="file" accept=".csv" onChange={handleFile} />
      <p className="muted">Header row optional. Amounts accept decimals; `$` and commas are stripped.</p>
    </div>
  )
}