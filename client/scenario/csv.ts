// client/scenario/csv.ts
// A minimal RFC 4180 CSV parser: quoted fields (commas, "" and newlines inside), CRLF or LF line endings, a leading
// BOM stripped, and a trailing newline that adds no extra row. No header handling: that is format.ts's job.

export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let dirty = false // has the current row seen any content since the last row was closed?

  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else {
        field += c
        i++
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      dirty = true
      i++
    } else if (c === ',') {
      row.push(field)
      field = ''
      dirty = true
      i++
    } else if (c === '\r' && s[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      dirty = false
      i += 2
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      dirty = false
      i++
    } else {
      field += c
      dirty = true
      i++
    }
  }
  if (dirty || field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}
