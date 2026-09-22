// tools/build-airports.ts
// Builds public/airports/heroes.json from OurAirports (public domain) + EGM96.

/** RFC 4180 CSV → one object per data row, keyed by the header row. Blank lines are skipped. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    let field = ''
    if (text[i] === '"') {
      let j = i + 1
      for (;;) {
        const q = text.indexOf('"', j)
        if (q === -1) throw new Error(`CSV: unterminated quote starting at ${i}`)
        field += text.slice(j, q)
        if (text[q + 1] !== '"') {
          i = q + 1
          break
        }
        field += '"'
        j = q + 2
      }
    } else {
      let j = i
      while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j++
      field = text.slice(i, j)
      i = j
    }
    row.push(field)
    const c = text[i]
    if (c === ',') {
      i++
      if (i === n) row.push('')
      else continue
    } else if (c === '\r' && text[i + 1] === '\n') i += 2
    else if (c === '\r' || c === '\n') i++
    else if (i < n) throw new Error(`CSV: unexpected ${JSON.stringify(c)} after a quoted field at ${i}`)
    rows.push(row)
    row = []
  }
  const [header, ...body] = rows
  if (!header) return []
  return body
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => Object.fromEntries(header.map((k, j) => [k, r[j] ?? ''])))
}
