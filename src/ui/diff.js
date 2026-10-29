// A line diff for the page: what an update to a routine changes in its prompt (conversation.js,
// the routine card). Pure, so it is tested without a browser.

/**
 * What changed between two texts, line by line: `[{ op: ' ' | '+' | '-', text }]`, by longest
 * common subsequence. A text of fewer than three lines is cut at its sentences instead, so a
 * prompt written as one long paragraph still shows which sentence moved.
 */
export function diffLines(from, to) {
  const split = (s) => {
    const lines = String(s || '').split('\n')
    return lines.length < 3 ? String(s || '').split(/(?<=[.!?])\s+/) : lines
  }
  const a = split(from)
  const b = split(to)
  // Past this many cells the table would stall the page; the whole of both is shown instead.
  if (a.length * b.length > 250_000) return [...a.map((text) => ({ op: '-', text })), ...b.map((text) => ({ op: '+', text }))]
  const n = a.length
  const m = b.length
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i++] })
      j++
    } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: a[i++] })
    else out.push({ op: '+', text: b[j++] })
  }
  while (i < n) out.push({ op: '-', text: a[i++] })
  while (j < m) out.push({ op: '+', text: b[j++] })
  return out
}
