/**
 * The machine itself: how busy its CPUs are, how much memory is taken, how full the disk the
 * workspaces live on is. Drawn as one line at the foot of the sidebar (ui.md).
 *
 * CPU is a delta of `os.cpus()` times since the previous ask, so it is the average over the
 * page's poll interval rather than a single instant; a first ask (or one after a long quiet)
 * takes two samples a moment apart instead, since a delta from boot is no reading at all.
 */
import os from 'node:os'
import fsp from 'node:fs/promises'
import { WORKSPACES_DIR } from './workspaces/index.mjs'

/** Several open tabs polling is one reading. */
const CACHE_MS = 2_000

/** A previous sample older than this is too long an average to call "now". */
const SAMPLE_MAX_AGE_MS = 60_000

/** Gap between the two samples of a first reading. */
const FIRST_SAMPLE_MS = 250

let previous = null
let cache = null

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total, at: Date.now() }
}

async function cpuPercent() {
  let before = previous
  if (!before || Date.now() - before.at > SAMPLE_MAX_AGE_MS) {
    before = cpuTimes()
    await new Promise((r) => setTimeout(r, FIRST_SAMPLE_MS))
  }
  const now = cpuTimes()
  previous = now
  const total = now.total - before.total
  return total > 0 ? Math.round((100 * (total - (now.idle - before.idle))) / total) : 0
}

/** The volume the workspaces are on: the one that fills up. Falls back to home. */
async function disk() {
  for (const dir of [WORKSPACES_DIR, os.homedir()]) {
    try {
      const s = await fsp.statfs(dir)
      const total = s.blocks * s.bsize
      // `bavail`, not `bfree`: what an unprivileged process can still write, which is what `df` shows.
      const free = s.bavail * s.bsize
      const used = total - s.bfree * s.bsize
      return { percent: total ? Math.round((100 * used) / (used + free)) : 0, used, total }
    } catch {
      /* not made yet on a fresh box: try the next */
    }
  }
  return null
}

/** `{ cpu, memory, disk }`, each `{ percent, used?, total? }` or null. Never throws. */
export async function readSystem() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const total = os.totalmem()
  // libuv's free memory is MemAvailable on Linux, so page cache does not read as taken.
  const used = total - os.freemem()
  const value = {
    cpu: { percent: await cpuPercent().catch(() => 0), cores: os.cpus().length },
    memory: { percent: total ? Math.round((100 * used) / total) : 0, used, total },
    disk: await disk(),
  }
  cache = { at: Date.now(), value }
  return value
}

/*
 * The detail behind the line: what the window opened from its arrow shows. Read only while
 * that window is open, so its second CPU sample is never paid by the five-second poll.
 */

/** Real filesystems; the rest of /proc/mounts is tmpfs, cgroups, overlays and the like. */
const DISK_TYPES = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'nfs', 'nfs4', 'cifs'])

let previousCores = null

function coreTimes() {
  return { at: Date.now(), cores: os.cpus().map((c) => c.times) }
}

async function corePercents() {
  let before = previousCores
  if (!before || Date.now() - before.at > SAMPLE_MAX_AGE_MS) {
    before = coreTimes()
    await new Promise((r) => setTimeout(r, FIRST_SAMPLE_MS))
  }
  const now = coreTimes()
  previousCores = now
  return now.cores.map((t, i) => {
    const b = before.cores[i]
    if (!b) return 0
    const busy = (x) => x.user + x.nice + x.sys + x.irq
    const total = busy(t) + t.idle - (busy(b) + b.idle)
    return total > 0 ? Math.round((100 * (busy(t) - busy(b))) / total) : 0
  })
}

/** /proc/meminfo in bytes, or null off Linux. */
async function meminfo() {
  try {
    const out = {}
    for (const line of (await fsp.readFile('/proc/meminfo', 'utf8')).split('\n')) {
      const m = /^(\w+):\s+(\d+)/.exec(line)
      if (m) out[m[1]] = Number(m[2]) * 1024
    }
    return out
  } catch {
    return null
  }
}

async function memoryDetail() {
  const m = await meminfo()
  const total = m?.MemTotal || os.totalmem()
  const available = m?.MemAvailable ?? os.freemem()
  return {
    total,
    used: total - available,
    cache: m ? (m.Buffers || 0) + (m.Cached || 0) + (m.SReclaimable || 0) : null,
    swapTotal: m?.SwapTotal ?? null,
    swapUsed: m ? (m.SwapTotal || 0) - (m.SwapFree || 0) : null,
  }
}

/** Each real filesystem once — a btrfs subvolume is the same device mounted again. */
async function disksDetail() {
  let lines = []
  try {
    lines = (await fsp.readFile('/proc/mounts', 'utf8')).split('\n')
  } catch {
    /* off Linux: the line's one disk is all there is */
  }
  const seen = new Set()
  const out = []
  for (const line of lines) {
    const [device, raw, type] = line.split(' ')
    if (!DISK_TYPES.has(type) || seen.has(device)) continue
    const mount = raw.replace(/\\040/g, ' ')
    seen.add(device)
    try {
      const s = await fsp.statfs(mount)
      const total = s.blocks * s.bsize
      if (!total) continue
      out.push({ mount, type, total, used: total - s.bfree * s.bsize, free: s.bavail * s.bsize })
    } catch {
      /* unmounted between the read and the stat, or not ours to look at */
    }
  }
  if (!out.length) {
    const d = await disk()
    if (d) out.push({ mount: WORKSPACES_DIR, type: '', total: d.total, used: d.used, free: d.total - d.used })
  }
  return out
}

/**
 * The machine's aggregate CPU from /proc/stat, which, unlike `os.cpus()`, splits out iowait:
 * the one number that tells a load average full of processes stuck on disk from one full of
 * work. Off Linux it falls back to `os.cpus()`, with iowait 0.
 */
async function statTimes() {
  try {
    const line = (await fsp.readFile('/proc/stat', 'utf8')).split('\n', 1)[0]
    const [user, nice, sys, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number)
    const busy = user + nice + sys + irq + softirq + steal
    return { busy, iowait, total: busy + idle + iowait, at: Date.now() }
  } catch {
    const t = cpuTimes()
    return { busy: t.total - t.idle, iowait: 0, total: t.total, at: t.at }
  }
}

/** `{ percent, iowait }` between two `statTimes`. */
function cpuBetween(before, now) {
  const total = now.total - before.total
  if (total <= 0) return { percent: 0, iowait: 0 }
  return { percent: Math.round((100 * (now.busy - before.busy)) / total), iowait: Math.round((100 * (now.iowait - before.iowait)) / total) }
}

let previousStat = null

async function cpuNow() {
  let before = previousStat
  if (!before || Date.now() - before.at > SAMPLE_MAX_AGE_MS) {
    before = await statTimes()
    await new Promise((r) => setTimeout(r, FIRST_SAMPLE_MS))
  }
  const now = await statTimes()
  previousStat = now
  return cpuBetween(before, now)
}

/*
 * The last fifteen minutes, for the window's sparklines. Sampled by the server on its own
 * timer, not by the window, so the lines are already drawn the moment it opens. A sample is
 * a read of /proc/stat, /proc/meminfo and loadavg every 30 s: nothing worth turning off.
 */
const HISTORY_EVERY_MS = 30_000
const HISTORY_SIZE = 30
const history = []
let historyStat = null

async function sampleHistory() {
  const now = await statTimes()
  const before = historyStat
  historyStat = now
  if (!before) return
  const total = os.totalmem()
  const m = await meminfo()
  history.push({
    at: now.at,
    load: os.loadavg()[0],
    cpu: cpuBetween(before, now).percent,
    memory: (m?.MemTotal || total) - (m?.MemAvailable ?? os.freemem()),
  })
  if (history.length > HISTORY_SIZE) history.shift()
}

sampleHistory().catch(() => {})
// unref: a timer of its own must never be what keeps a test or a stopping server alive.
setInterval(() => sampleHistory().catch(() => {}), HISTORY_EVERY_MS).unref()

/** `{ cores, cpu, load, uptime, memory, disks, history }`. */
export async function readSystemDetail() {
  const [cores, cpu, memory, disks] = await Promise.all([
    corePercents().catch(() => []),
    cpuNow().catch(() => ({ percent: 0, iowait: 0 })),
    memoryDetail(),
    disksDetail(),
  ])
  return { cores, cpu, load: os.loadavg(), uptime: os.uptime(), memory, disks, history }
}
