// The files a chat wrote or pointed the person at (docs/modules/harnesses.md `readFiles`,
// `readFileVersion`; docs/modules/workspaces.md *Files*): the path rule both sides share, the
// transcript as the record of every version, and the disk read bounded to the workspace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-files-'))
process.env.OUTPOST_DATA = path.join(tmp, 'data')
process.env.OUTPOST_WORKSPACES = path.join(tmp, 'workspaces')
process.env.OUTPOST_CONFIG = path.join(tmp, 'config')
process.env.HOME = tmp

const { pathMentions } = await import('../server/lib/paths.mjs')
const harness = (await import('../server/harnesses/claude-code.mjs')).default
const { BIN_BYTES, DOWNLOAD_BYTES, contentTypeOf, insideWorkspace, placeFiles, readWorkspaceBytes, readWorkspaceFile, scratchLike, sourceLike } = await import('../server/workspaces/files.mjs')

const ws = path.join(tmp, 'workspaces', 'w1')
const repo = path.join(ws, 'outpost')
const cwd = repo
const sid = '0f1c3b6e-5d0a-4b6a-9b1e-2c3d4e5f6a7b'

// A transcript as the CLI writes one: two Writes of the same path, a mention, a cited source
// file, a sidechain Write that is not this conversation's, and a line being written right now.
const rec = (type, content, extra = {}) => JSON.stringify({ type, uuid: `${type}-${Math.random()}`, timestamp: extra.at || '2026-10-14T10:00:00Z', message: { role: type, content }, ...extra })
const write = (id, file_path, content) => ({ type: 'tool_use', id, name: 'Write', input: { file_path, content } })
const lines = [
  rec('user', [{ type: 'text', text: 'write me a report' }]),
  rec('assistant', [write('toolu_01AAA', `${repo}/temp/report.md`, '# v1\n\nfirst')], { at: '2026-10-14T10:01:00Z' }),
  rec('user', [{ type: 'tool_result', tool_use_id: 'toolu_01AAA', content: 'ok' }]),
  rec('assistant', [write('toolu_01BBB', `${repo}/temp/report.md`, '# v2\n\nsecond')], { at: '2026-10-14T10:02:00Z' }),
  rec('assistant', [write('toolu_01CCC', `${repo}/src/main.js`, 'export {}')], { at: '2026-10-14T10:02:30Z' }),
  rec('assistant', [{ type: 'text', text: 'Done. Read temp/report.md; the change is in src/main.js:12. Also see temp/notes.md.' }], { at: '2026-10-14T10:03:00Z' }),
  rec('assistant', [write('toolu_01DDD', `${repo}/temp/side.md`, 'side')], { isSidechain: true }),
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01EEE","name":"Write","input":{"file_path":"/x/y.md","con',
]
const projectDir = path.join(tmp, '.claude', 'projects', '-ws-outpost')
fs.mkdirSync(projectDir, { recursive: true })
fs.writeFileSync(path.join(projectDir, `${sid}.jsonl`), lines.join('\n') + '\n')

// The workspace: the report on disk as edited since, a Bash-made file in temp/, a link out.
fs.mkdirSync(path.join(repo, 'temp'), { recursive: true })
fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
fs.writeFileSync(path.join(repo, 'temp', 'report.md'), '# v3 on disk\n')
fs.writeFileSync(path.join(repo, 'temp', 'notes.md'), 'made with bash\n')
fs.writeFileSync(path.join(repo, 'src', 'main.js'), 'export {}\n')
fs.writeFileSync(path.join(tmp, 'outside.md'), 'not yours\n')
fs.symlinkSync(path.join(tmp, 'outside.md'), path.join(repo, 'temp', 'link.md'))
fs.writeFileSync(path.join(repo, 'temp', 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x47]))
fs.writeFileSync(path.join(repo, 'temp', 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
const manifest = { id: 'w1', status: 'ready', repos: [{ id: 'outpost', name: 'outpost', path: repo }] }
const ref = { cliSessionId: sid }

test('a path in prose is a token with a slash and an extension, and nothing in a URL or a link is one', () => {
  assert.deepEqual(pathMentions('Read temp/report.md, then `src/main.js:42`.'), [
    { path: 'temp/report.md', line: 0 },
    { path: 'src/main.js', line: 42 },
  ])
  assert.deepEqual(pathMentions('See https://example.com/a/b.md and [doc](docs/c.md) and README.md and temp/.'), [])
  assert.deepEqual(pathMentions('&quot;temp/x.md&quot; *temp/y.md* ./z/w.txt ~/n.md /abs/p.md.'), [
    { path: 'temp/x.md', line: 0 },
    { path: 'temp/y.md', line: 0 },
    { path: './z/w.txt', line: 0 },
    { path: '~/n.md', line: 0 },
    { path: '/abs/p.md', line: 0 },
  ])
})

test('readFiles lists every Write by path, newest version first, with when an answer last named it', async () => {
  const { ok, files, missing } = await harness.readFiles(ref, { cwd })
  assert.equal(ok, true)
  assert.equal(missing, false)
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
  const report = byPath[`${repo}/temp/report.md`]
  assert.deepEqual(
    report.writes.map((w) => w.id),
    ['toolu_01BBB', 'toolu_01AAA'],
    'both versions, newest first'
  )
  assert.equal(report.writes[0].at, Date.parse('2026-10-14T10:02:00Z'))
  assert.equal(report.mentions, 1)
  assert.equal(report.mentionedAt, Date.parse('2026-10-14T10:03:00Z'))
  assert.equal(byPath[`${repo}/src/main.js`].writes.length, 1)
  assert.equal(byPath[`${repo}/src/main.js`].mentionedAt, Date.parse('2026-10-14T10:03:00Z'), 'a line reference is still a mention')
  assert.deepEqual(byPath[`${repo}/temp/notes.md`].writes, [], 'mentioned, never written')
  assert.equal(byPath[`${repo}/temp/side.md`], undefined, "a subagent's Write is not this conversation's")
  assert.equal(byPath['/x/y.md'], undefined, 'a line being written is skipped')
})

test('readFileVersion serves the Write the id names, and only a Write', async () => {
  const v1 = await harness.readFileVersion(ref, 'toolu_01AAA')
  assert.equal(v1.ok, true)
  assert.equal(v1.text, '# v1\n\nfirst')
  assert.equal(v1.path, `${repo}/temp/report.md`)
  assert.equal(v1.at, Date.parse('2026-10-14T10:01:00Z'))
  assert.equal((await harness.readFileVersion(ref, 'toolu_01ZZZ')).ok, false)
  assert.equal((await harness.readFileVersion(ref, '../etc/passwd')).ok, false)
})

test('placeFiles says what is on disk and drops a cited source file that was never written', async () => {
  const { files } = await harness.readFiles(ref, { cwd })
  const placed = await placeFiles(manifest, files, cwd)
  const byPath = Object.fromEntries(placed.map((f) => [f.path, f]))
  assert.equal(byPath[`${repo}/temp/report.md`].onDisk, true)
  assert.equal(byPath[`${repo}/temp/report.md`].size, '# v3 on disk\n'.length)
  assert.equal(byPath[`${repo}/temp/notes.md`].onDisk, true, 'a Bash-made file in temp/ the answer named is listed')
  assert.equal(byPath[`${repo}/src/main.js`].onDisk, true, 'a source file the session wrote is listed')
  const cited = await placeFiles(manifest, [{ path: `${repo}/src/other.js`, writes: [], mentions: 1, mentionedAt: 1 }], cwd)
  assert.deepEqual(cited, [], 'a cited source file that was never written is not the list')
  const gone = await placeFiles(manifest, [{ path: `${repo}/temp/gone.md`, writes: [{ id: 'toolu_01GGG', at: 1, bytes: 1 }], mentions: 0, mentionedAt: 0 }], cwd)
  assert.equal(gone[0].onDisk, false, 'a written file no longer on disk stays, for its versions')
})

test('a source file the session Wrote is never For you, even when an answer names it; a report it Wrote still is', async () => {
  const { files } = await harness.readFiles(ref, { cwd })
  const byPath = Object.fromEntries((await placeFiles(manifest, files, cwd)).map((f) => [f.path, f]))
  const main = byPath[`${repo}/src/main.js`]
  assert.equal(main.mentionedAt, 0, 'src/main.js is Also written')
  assert.equal(main.cited, true, 'the mention is kept as cited')
  assert.equal(byPath[`${repo}/temp/report.md`].mentionedAt, Date.parse('2026-10-14T10:03:00Z'), 'temp/report.md is still For you')
  assert.ok(byPath[`${repo}/temp/notes.md`].mentionedAt, 'a Bash-made file the answer named is unchanged')
  for (const p of ['a/b.ts', 'x.PY', 'styles.scss', 'conf.toml']) assert.equal(sourceLike(p), true, p)
  for (const p of ['r.md', 'n.txt', 'page.html', 'd.json', 'c.yml', 't.csv', 'i.png', 'doc.pdf', 'Makefile', '.bashrc']) assert.equal(sourceLike(p), false, p)
})

test('scratchLike is outside every checkout or inside a checkout temp/', () => {
  assert.equal(scratchLike(manifest, `${repo}/temp/a.md`), true)
  assert.equal(scratchLike(manifest, `${ws}/home/notes.md`), true)
  assert.equal(scratchLike(manifest, `${repo}/src/a.js`), false)
  assert.equal(scratchLike(manifest, `${repo}/temporary/a.md`), false)
})

test('readWorkspaceFile reads inside the workspace and refuses anything that leads out of it', async () => {
  const disk = await readWorkspaceFile(manifest, 'temp/report.md', { cwd })
  assert.equal(disk.ok, true)
  assert.equal(disk.text, '# v3 on disk\n')
  assert.equal(disk.truncated, false)
  assert.equal((await readWorkspaceFile(manifest, `${repo}/temp/report.md`)).text, '# v3 on disk\n', 'absolute works without a cwd')
  assert.equal(insideWorkspace(manifest, '../../outside.md', cwd), '', 'climbing out by letters')
  assert.equal((await readWorkspaceFile(manifest, path.join(tmp, 'outside.md'))).outside, true)
  assert.equal((await readWorkspaceFile(manifest, '~/notes.md')).outside, true)
  const link = await readWorkspaceFile(manifest, 'temp/link.md', { cwd })
  assert.equal(link.ok, false)
  assert.equal(link.outside, true, 'a link out of the workspace is not followed')
  const missing = await readWorkspaceFile(manifest, 'temp/nope.md', { cwd })
  assert.equal(missing.ok, true)
  assert.equal(missing.missing, true)
  assert.equal((await readWorkspaceFile(manifest, 'temp', { cwd })).ok, false, 'a folder')
  const bin = await readWorkspaceFile(manifest, 'temp/bin.dat', { cwd })
  assert.equal(bin.ok, true, 'not text is an answer, so the page asks for the bytes')
  assert.equal(bin.binary, true)
  assert.equal(bin.text, '')
  assert.equal(bin.size, 4)
  assert.equal((await readWorkspaceFile(manifest, 'temp/report.md\0.png', { cwd })).ok, false, 'a NUL')
  const cut = await readWorkspaceFile(manifest, 'temp/report.md', { cwd, maxBytes: 4 })
  assert.equal(cut.text, '# v3')
  assert.equal(cut.truncated, true)
})

test('readWorkspaceBytes is bounded as the text read is, typed by extension, and refused whole past its cap', async () => {
  const png = await readWorkspaceBytes(manifest, 'temp/chart.png', { cwd })
  assert.equal(png.ok, true)
  assert.equal(png.type, 'image/png')
  assert.deepEqual([...png.bytes], [0x89, 0x50, 0x4e, 0x47])
  assert.equal(png.size, 4)
  assert.equal((await readWorkspaceBytes(manifest, 'temp/bin.dat', { cwd })).type, 'application/octet-stream', 'an unknown extension')
  assert.equal((await readWorkspaceBytes(manifest, 'temp/report.md', { cwd })).type, 'application/octet-stream', 'text is never served as a type that runs')
  assert.equal(contentTypeOf('a/B.JPG'), 'image/jpeg')
  assert.equal(contentTypeOf('x.svg'), 'image/svg+xml')
  assert.equal(contentTypeOf('doc.pdf'), 'application/pdf')
  assert.equal(contentTypeOf('page.html'), 'application/octet-stream')
  assert.equal((await readWorkspaceBytes(manifest, path.join(tmp, 'outside.md'))).outside, true, 'outside by its letters')
  assert.equal((await readWorkspaceBytes(manifest, '../../outside.md', { cwd })).outside, true, 'climbing out')
  assert.equal((await readWorkspaceBytes(manifest, 'temp/link.md', { cwd })).outside, true, 'a link out is not followed')
  assert.equal((await readWorkspaceBytes(manifest, 'temp/chart.png\0', { cwd })).ok, false, 'a NUL')
  assert.equal((await readWorkspaceBytes(manifest, 'temp', { cwd })).ok, false, 'a folder')
  assert.equal((await readWorkspaceBytes(manifest, 'temp/nope.png', { cwd })).missing, true)
  // Both caps: the viewer's, and the larger one the Download link asks for.
  assert.equal(BIN_BYTES, 8 * 1024 * 1024)
  assert.equal(DOWNLOAD_BYTES, 64 * 1024 * 1024)
  fs.writeFileSync(path.join(repo, 'temp', 'big.bin'), Buffer.alloc(BIN_BYTES + 1, 7))
  const over = await readWorkspaceBytes(manifest, 'temp/big.bin', { cwd })
  assert.equal(over.ok, false)
  assert.equal(over.tooBig, true)
  assert.equal(over.size, BIN_BYTES + 1)
  assert.equal(over.bytes, undefined, 'refused whole, never cut')
  const down = await readWorkspaceBytes(manifest, 'temp/big.bin', { cwd, maxBytes: DOWNLOAD_BYTES })
  assert.equal(down.ok, true)
  assert.equal(down.bytes.length, BIN_BYTES + 1)
})
