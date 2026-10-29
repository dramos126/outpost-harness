// A publish's deletions (docs/modules/workspaces-data.md): what a chat deleted is told from what
// appeared on the source since by the seed list, nothing is removed but the list the person
// read, and the question stands on the bar past the session's end (launchers.md). The ssh the
// removal would run is stood in for; nothing leaves the machine.
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-publish-'))
process.env.OUTPOST_DATA = path.join(tmp, 'data')
process.env.OUTPOST_SESSIONS = path.join(tmp, 'sessions')
process.env.OUTPOST_WORKSPACES = path.join(tmp, 'workspaces')
process.env.OUTPOST_CONFIG = path.join(tmp, 'config')
process.env.OUTPOST_DATASETS = path.join(tmp, 'datasets')
process.env.HOME = tmp
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const sshRuns = []
// What the source prints back: the rmdir loop names each folder it removed; 'busy' never goes.
const sshAnswer = (command) => [...command.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => p.startsWith('old') && !p.includes('busy')).join('\n')
mock.module('../server/environments.mjs', {
  namedExports: {
    sshRun: async (env, command) => (sshRuns.push({ env: env.name, command }), sshAnswer(command)),
    sshTarget: async (env) => ({ args: ['-p', '22'], target: `${env.user}@${env.host}` }),
  },
})
// The manifest the repo would declare, without a mirror to read it from.
mock.module('../server/workspaces/git.mjs', {
  namedExports: {
    mirrorPath: (id) => path.join(tmp, 'mirrors', id),
    defaultBranch: async () => 'main',
    git: async (args) => {
      if (args[0] === 'show') return JSON.stringify({ datasets: [{ name: 'reports', env: 'BT', access: 'write' }] })
      throw new Error('not here')
    },
  },
})

const { parseListing, parseListingDirs, planDeletes, emptiedFolders, removeFromSource, seenSeed, excludeRule } = await import('../server/workspaces/datasets.mjs')
const structured = await import('../server/launchers/structured.mjs')
// The host the dataset's source is on, saved as Settings would (its key is never read here).
const { saveEnvironment } = await import('../server/config.mjs')
await saveEnvironment({ name: 'nas-1', user: 'u', host: 'nas-1.lan' })

test('a listing is read by regular file, size with commas, and time as printed', () => {
  const files = parseListing(
    [
      'drwxr-xr-x          4,096 2026/10/17 14:33:12 .',
      'drwxr-xr-x          4,096 2026/10/17 14:33:12 runs',
      '-rw-r--r--      1,234,567 2026/10/16 09:01:02 runs/a b.json',
      '-rw-r--r--              0 2026/10/17 14:33:12 runs/empty',
      'lrwxrwxrwx              5 2026/10/17 14:33:12 link -> runs',
      '',
    ].join('\n')
  )
  assert.deepEqual(files, { 'runs/a b.json': { size: 1234567, mtime: '2026/10/16 09:01:02' }, 'runs/empty': { size: 0, mtime: '2026/10/17 14:33:12' } })
})

test('what is on the source and not here is new, a conflict, or this chat’s deletion, by the seed', () => {
  const t1 = '2026/10/16 09:00:00'
  const t2 = '2026/10/17 09:00:00'
  const seed = { 'runs/kept': { size: 1, mtime: t1 }, 'runs/gone': { size: 1, mtime: t1 }, 'runs/edited': { size: 1, mtime: t1 }, 'other/gone': { size: 1, mtime: t1 }, 'runs/gone-there': { size: 1, mtime: t1 } }
  const source = { 'runs/kept': { size: 1, mtime: t1 }, 'runs/gone': { size: 1, mtime: t1 }, 'runs/edited': { size: 2, mtime: t2 }, 'runs/new': { size: 1, mtime: t2 }, 'other/gone': { size: 1, mtime: t1 } }
  const local = ['runs/kept', 'runs/mine']
  assert.deepEqual(planDeletes({ seed, source, local }), { fresh: ['runs/new'], conflicts: ['runs/edited'], candidates: ['other/gone', 'runs/gone'], folders: [], removedThere: [], editedHere: [], behind: [], clashes: [] })
  // `path` narrows every group to the folder, as it narrows the send.
  assert.deepEqual(planDeletes({ seed, source, local, rel: 'runs' }), { fresh: ['runs/new'], conflicts: ['runs/edited'], candidates: ['runs/gone'], folders: [], removedThere: [], editedHere: [], behind: [], clashes: [] })
  // No seed yet (a copy from before this shipped): nothing is a deletion, everything missing is pulled.
  assert.deepEqual(planDeletes({ seed: {}, source, local }), { fresh: ['other/gone', 'runs/edited', 'runs/gone', 'runs/new'], conflicts: [], candidates: [], folders: [], removedThere: [], editedHere: [], behind: [], clashes: [] })
})

test('what another chat removed there is dropped here when untouched, and sent back when edited here', () => {
  const t1 = '2026/10/16 09:00:00'
  const at = new Date(2026, 9, 16, 9, 0, 0).getTime()
  const seed = { 'old/a': { size: 1, mtime: t1 }, 'old/b': { size: 1, mtime: t1 }, 'old/c': { size: 1, mtime: t1 }, 'runs/a': { size: 1, mtime: t1 } }
  const source = { 'runs/a': { size: 1, mtime: t1 } }
  const local = ['old/a', 'old/b', 'old/c', 'old/d', 'runs/a']
  // a: as seen, the listing's rounding under a second; b: edited here since; c: no stat; d: new here.
  const localStats = { 'old/a': { size: 1, mtimeMs: at + 900 }, 'old/b': { size: 2, mtimeMs: at + 60000 }, 'old/d': { size: 1, mtimeMs: at } }
  const plan = planDeletes({ seed, source, local, localStats })
  assert.deepEqual(plan.removedThere, ['old/a'])
  assert.deepEqual(plan.editedHere, ['old/b', 'old/c'])
  assert.deepEqual(plan.candidates, [])
  assert.deepEqual(planDeletes({ seed, source, local, localStats, rel: 'runs' }).removedThere, [])
})

test('a file another chat’s yes removed is dropped even when this copy’s seed lost it', () => {
  const t1 = '2026/10/16 09:00:00'
  const at = new Date(2026, 9, 16, 9, 0, 0).getTime()
  // A sync before the fix rewrote the seed to the source and kept the stale files here.
  const removed = { 'old/a': { size: 1, mtime: t1 }, 'old/b': { size: 1, mtime: t1 } }
  const local = ['old/a', 'old/b', 'old/new']
  const localStats = { 'old/a': { size: 1, mtimeMs: at }, 'old/b': { size: 5, mtimeMs: at + 60000 }, 'old/new': { size: 1, mtimeMs: at } }
  const plan = planDeletes({ seed: {}, source: {}, local, localStats, removed })
  // b is the same path with other content, so new here; it goes, like old/new.
  assert.deepEqual(plan.removedThere, ['old/a'])
  assert.deepEqual(plan.editedHere, [])
})

test('the seed keeps only what this chat has seen, so a file that never reached the copy stays new', () => {
  const t1 = '2026/10/16 09:00:00'
  const t2 = '2026/10/17 09:00:00'
  const at2 = new Date(2026, 9, 17, 9, 0, 0).getTime()
  const at1 = new Date(2026, 9, 16, 9, 0, 0).getTime()
  const seed = { 'research/a': { size: 1, mtime: t1 }, 'runs/gone': { size: 1, mtime: t1 }, 'runs/edited': { size: 1, mtime: t1 }, 'old/removed': { size: 1, mtime: t1 }, 'scout/index': { size: 1, mtime: t1 } }
  // A narrow publish of research/: scout/ gained a run outside it, never pulled; runs/edited
  // was deleted here and changed there since; scout/index changed there, the copy still the old.
  const source = { 'research/a': { size: 2, mtime: t2 }, 'research/sent': { size: 1, mtime: t2 }, 'runs/gone': { size: 1, mtime: t1 }, 'runs/edited': { size: 3, mtime: t2 }, 'scout/run': { size: 1, mtime: t2 }, 'scout/index': { size: 2, mtime: t2 } }
  const localStats = { 'research/a': { size: 2, mtimeMs: at2 }, 'research/sent': { size: 1, mtimeMs: at2 }, 'scout/index': { size: 1, mtimeMs: at1 } }
  const files = seenSeed({ seed, source, localStats })
  assert.deepEqual(files, { 'research/a': { size: 2, mtime: t2 }, 'research/sent': { size: 1, mtime: t2 }, 'runs/gone': { size: 1, mtime: t1 }, 'runs/edited': { size: 1, mtime: t1 }, 'scout/index': { size: 1, mtime: t1 } })
  // Next time: the run is pulled, the deletion is still this chat's, the edit there a conflict,
  // and the stale index behind.
  const plan = planDeletes({ seed: files, source, local: Object.keys(localStats), localStats })
  assert.deepEqual(plan.fresh, ['scout/run'])
  assert.deepEqual(plan.candidates, ['runs/gone'])
  assert.deepEqual(plan.conflicts, ['runs/edited'])
  assert.deepEqual(plan.behind, ['scout/index'])
  assert.deepEqual(plan.clashes, [])
})

test('a file on both sides is pulled when changed there only, sent when changed here only, and a clash when both', () => {
  const t1 = '2026/10/20 03:00:00'
  const t2 = '2026/10/21 06:00:00'
  const at = (h) => new Date(2026, 9, 20, 3, 0, 0).getTime() + h * 3600e3
  const base = { size: 10, mtime: t1 }
  const seed = { same: base, there: base, here: base, both: base, legacy: { size: 20, mtime: t2 }, mine: base }
  const source = { same: base, there: { size: 20, mtime: t2 }, here: base, both: { size: 20, mtime: t2 }, legacy: { size: 20, mtime: t2 }, mine: base, unseen: { size: 5, mtime: t2 } }
  const localStats = {
    same: { size: 10, mtimeMs: at(0) },
    there: { size: 10, mtimeMs: at(0) },
    here: { size: 11, mtimeMs: at(30) },
    // The routine rewrote it at 06:00; the chat edited its stale copy after: row 3, a clash.
    both: { size: 11, mtimeMs: at(40) },
    // A seed from before: the source's newer version recorded against a copy that never got it.
    legacy: { size: 10, mtimeMs: at(0) },
    // Older than what this chat saw, and the source unchanged: behind as well.
    mine: { size: 9, mtimeMs: at(-5) },
    // On both sides, never seen, not the same: someone else made the same path.
    unseen: { size: 6, mtimeMs: at(1) },
  }
  const plan = planDeletes({ seed, source, local: Object.keys(localStats), localStats })
  assert.deepEqual(plan.behind, ['legacy', 'mine', 'there'])
  assert.deepEqual(plan.clashes, ['both', 'unseen'])
  assert.deepEqual([...plan.fresh, ...plan.conflicts, ...plan.candidates], [])
  // Unmerged: a clash stays one while its saved version is there, even with the source as marked.
  const marked = { ...seed, both: { size: 20, mtime: t2, clash: true } }
  assert.deepEqual(planDeletes({ seed: marked, source, local: Object.keys(localStats), localStats, theirs: new Set(['both']) }).clashes, ['both', 'unseen'])
  // Merged, its saved version deleted: changed here only against the source's, so sent.
  assert.deepEqual(planDeletes({ seed: marked, source, local: Object.keys(localStats), localStats }).clashes, ['unseen'])
  // `path` narrows these too.
  assert.deepEqual(planDeletes({ seed, source, local: Object.keys(localStats), localStats, rel: 'there' }).behind, ['there'])
})

test('a clash is excluded from the send by its exact path, wildcards escaped', () => {
  assert.equal(excludeRule('scout/families.json'), '/scout/families.json')
  assert.equal(excludeRule('runs/a [b]*.json'), '/runs/a \\[b]\\*.json')
  assert.equal(excludeRule('odd\\name'), '/odd\\name')
})

test('a yes removes the files named and no others, under the source, and takes them off the seed', async () => {
  const ws = path.join(tmp, 'workspaces', 'w1')
  const seedFile = path.join(ws, 'data', 'bt', '.seed-reports.json')
  fs.mkdirSync(path.dirname(seedFile), { recursive: true })
  fs.writeFileSync(seedFile, JSON.stringify({ at: 1, files: { 'runs/gone': { size: 1, mtime: 'x' }, 'runs/kept': { size: 1, mtime: 'x' } } }))
  const repo = { id: 'bt', name: 'bt', dataSources: [{ dataset: 'reports', host: 'nas-1', path: '/mnt/reports' }] }
  const removed = await removeFromSource(repo, 'reports', ws, ['runs/gone', "it's here/odd name.json", 'runs/gone'])
  assert.deepEqual(removed, { files: ['runs/gone', "it's here/odd name.json"], folders: [] })
  assert.equal(sshRuns.length, 1)
  assert.equal(sshRuns[0].env, 'nas-1')
  assert.equal(sshRuns[0].command, `cd '/mnt/reports' && rm -f -- 'runs/gone' 'it'\\''s here/odd name.json'`)
  assert.deepEqual(JSON.parse(fs.readFileSync(seedFile, 'utf8')).files, { 'runs/kept': { size: 1, mtime: 'x' } })
  // Recorded for every chat, as the source listed it; a path the seed never had has no entry.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'datasets', 'removed-bt-reports.json'), 'utf8')), { 'runs/gone': { size: 1, mtime: 'x' } })
  // A path that could leave the dataset is refused before anything runs.
  for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../b', 'a\nb', '']) {
    await assert.rejects(removeFromSource(repo, 'reports', ws, ['runs/x', bad]), /not a path inside the dataset/)
  }
  assert.equal(sshRuns.length, 1)
})

test('a standing question has no timeout, outlives denyAll, and is withdrawn by id or answered on the bar', async () => {
  const input = { question: 'Remove 2 files?', yes: 'remove them', card: { kind: 'files', title: '2 files', files: ['a', 'b'] } }
  const standing = structured.awaitApproval('wq', { toolName: structured.OUTPOST_ASK, input, toolUseId: 'deletes-1', standing: true })
  const plain = structured.awaitApproval('wq', { toolName: 'Bash', input: { command: 'ls' } })
  structured.denyAll('wq', 'The session was ended')
  assert.deepEqual(await plain, { behavior: 'deny', message: 'The session was ended' })
  const rec = { workspaceId: 'wq' }
  assert.equal(structured.isAsking(rec), true)
  assert.equal(structured.askingLine(rec), 'Asking you a question')
  assert.deepEqual(structured.askOf(rec), { kind: 'question', head: 'Remove 2 files?' })
  const drawn = structured.describePrompt(rec)
  assert.equal(drawn.head, 'Outpost is asking you')
  assert.deepEqual(drawn.card, input.card)
  assert.deepEqual(drawn.options.map((o) => o.key), ['allow', 'deny'])
  assert.equal(structured.withdraw('wq', 'nope'), false)
  assert.equal(structured.withdraw('wq', 'deletes-1'), true)
  assert.deepEqual(await standing, { behavior: 'deny', message: 'withdrawn' })
  assert.equal(structured.isAsking(rec), false)
  const again = structured.awaitApproval('wq', { toolName: structured.OUTPOST_ASK, input, toolUseId: 'deletes-2', standing: true })
  assert.equal(structured.answer('wq', 'allow', { id: 'deletes-2' }).ok, true)
  assert.equal((await again).behavior, 'allow')
})

test('a listing’s folders are read too, never the root', () => {
  const text = ['drwxr-xr-x          4,096 2026/10/17 14:33:12 .', 'drwxr-xr-x          4,096 2026/10/17 14:33:12 runs', 'drwxr-xr-x          4,096 2026/10/17 14:33:12 runs/a b', '-rw-r--r--             12 2026/10/16 09:01:02 runs/a b/x.json'].join('\n')
  assert.deepEqual(parseListingDirs(text), ['runs', 'runs/a b'])
})

test('a move leaves no old folder behind; one empty before, or in the copy, or still holding a file, stays', () => {
  // foo/a/b.json moved to bar/foo/a/b.json; was-empty/ (and its empty child) were empty before;
  // kept-empty/ is empty in the copy too; shared/ still holds a file another chat put there.
  const sourceFiles = ['foo/a/b.json', 'bar/foo/a/b.json', 'shared/gone.json', 'shared/theirs.json', 'mixed/gone.json']
  const sourceDirs = ['foo', 'foo/a', 'bar', 'bar/foo', 'bar/foo/a', 'was-empty', 'was-empty/sub', 'kept-empty', 'shared', 'mixed', 'mixed/empty-before']
  const localDirs = ['bar', 'bar/foo', 'bar/foo/a', 'kept-empty']
  const candidates = ['foo/a/b.json', 'shared/gone.json', 'mixed/gone.json']
  assert.deepEqual(emptiedFolders({ sourceFiles, sourceDirs, localDirs, candidates }), ['foo/a', 'foo'])
  // Asked to tidy what is already empty there and absent here: those too, never one in the copy.
  assert.deepEqual(emptiedFolders({ sourceFiles, sourceDirs, localDirs, candidates, emptyToo: true }), ['foo/a', 'mixed/empty-before', 'was-empty/sub', 'foo', 'mixed', 'was-empty'])
  // With path set, only inside it, and never the path itself.
  assert.deepEqual(emptiedFolders({ sourceFiles, sourceDirs, localDirs, candidates, rel: 'foo' }), ['foo/a'])
  // planDeletes hands the same list on.
  const seed = Object.fromEntries(['foo/a/b.json'].map((p) => [p, { size: 1, mtime: 't' }]))
  const source = { 'foo/a/b.json': { size: 1, mtime: 't' }, 'bar/foo/a/b.json': { size: 1, mtime: 't' } }
  const plan = planDeletes({ seed, source, local: ['bar/foo/a/b.json'], sourceDirs: ['foo', 'foo/a', 'bar', 'bar/foo', 'bar/foo/a'], localDirs: ['bar', 'bar/foo', 'bar/foo/a'] })
  assert.deepEqual(plan.candidates, ['foo/a/b.json'])
  assert.deepEqual(plan.folders, ['foo/a', 'foo'])
})

test('a yes removes the folders with rmdir, deepest first, and answers only those that went', async () => {
  const ws = path.join(tmp, 'workspaces', 'w2')
  const repo = { id: 'bt', name: 'bt', dataSources: [{ dataset: 'reports', host: 'nas-1', path: '/mnt/reports' }] }
  sshRuns.length = 0
  const r = await removeFromSource(repo, 'reports', ws, ['old/a/x.json'], ['old/a', 'old/busy', 'old'])
  assert.deepEqual(r.files, ['old/a/x.json'])
  assert.deepEqual(r.folders, ['old/a', 'old'])
  assert.match(sshRuns[1].command, /^cd '\/mnt\/reports' && for d in 'old\/a' 'old\/busy' 'old'; do rmdir -- "\$d" 2>\/dev\/null && printf/)
  assert.doesNotMatch(sshRuns[1].command, /rm -r|rm -f/)
  await assert.rejects(removeFromSource(repo, 'reports', ws, [], ['../up']), /not a path inside the dataset/)
})
