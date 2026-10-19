/**
 * Build and validate one directory scope's signpost index.
 *
 * The indexer is intentionally shallow: it records *where* experience lives and
 * roughly *what it is*, reading only the first few kilobytes of each file. File
 * bodies are never copied into the database, so the checkout stays the single
 * source of truth and a stale index can only mislabel a document, never shadow
 * its current content.
 *
 * Patterns are resolved in two scopes. A row whose first segment names a detached
 * experience root (`.codex`, `.comate`, `.claude`, `.agents`) applies to *every*
 * such directory found below the scope, so a monorepo with
 * `sub-project/.codex/runbooks` is not invisible. Every other row stays anchored
 * at the scope directory.
 *
 * @module dsh-experience-index/indexer
 */
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { findDirsNamed, globBaseDir, globToRegExp, normalizePattern, walkFiles } from './glob.js'
import { isIgnored, loadIgnore } from './ignore.js'
import { baseName, extractTitle, isTextCandidate, refineCategory } from './classify.js'
import { CATEGORY_ORDER, INDEXER_VERSION, type Category, type ResolvedConfig } from './config.js'
import { relativeToRepo, type RepoInfo } from './project.js'
import type { EntriesRecord, EntryRecord, ScopeRecord } from './domain.js'

export interface IndexInput {
  scopeRoot: string
  /** Display name; defaults to the directory basename. */
  name?: string
  repo: RepoInfo
  config: ResolvedConfig
  dshHome: string
  signal?: AbortSignal
  now?: number
}

export interface IndexResult {
  scope: ScopeRecord
  entries: EntriesRecord
}

interface CompiledSource {
  category: Category
  /** Detached root this row is relative to, or null when anchored at the scope. */
  legacyDir: string | null
  /** Pattern relative to that detached root, or the full pattern when anchored. */
  pattern: string
  regex: RegExp
  literal: boolean
  base: string
}

/** Read at most `bytes` from the start of a file; never loads the whole body. */
async function readHead(absolute: string, bytes: number): Promise<string> {
  const handle = await open(absolute, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await handle.close()
  }
}

/** Category ordering for both entries and rendered groups. */
function categoryRank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category as Category)
  return index === -1 ? CATEGORY_ORDER.length : index
}

/** Compile configured sources once per index run. */
function compileSources(config: ResolvedConfig): CompiledSource[] {
  const legacyNames = new Set(config.legacyRootNames)
  return config.sources.map(source => {
    const normalized = normalizePattern(source.glob)
    const first = normalized.split('/')[0] ?? ''
    const detached = legacyNames.has(first)
    const pattern = detached ? normalized.slice(first.length + 1) : normalized
    return {
      category: source.category,
      legacyDir: detached ? first : null,
      pattern,
      regex: globToRegExp(pattern),
      literal: !/[*?]/.test(pattern),
      base: globBaseDir(pattern),
    }
  })
}

/** Stat one directory mtime, skipping anything that vanished mid-walk. */
async function dirFact(root: string, relative: string): Promise<{ relpath: string; mtimeMs: number } | null> {
  try {
    const info = await stat(relative === '' ? root : join(root, relative))
    if (!info.isDirectory()) return null
    return { relpath: relative, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

/** The directory part of a `/`-separated relative path. */
function parentOf(relative: string): string {
  const index = relative.lastIndexOf('/')
  return index === -1 ? '' : relative.slice(0, index)
}

/** Add every ancestor of a detached root so a newly created sibling is detected. */
function markAncestors(relative: string, into: Set<string>): void {
  let current = relative
  for (;;) {
    into.add(current)
    const parent = parentOf(current)
    if (parent === '') break
    current = parent
  }
}

/** Stable ordering for aggregate rows, shared by index and copy paths. */
function aggregateSort(
  aggregates: ReadonlyArray<ScopeRecord['stats']['aggregates'][number]>,
): ScopeRecord['stats']['aggregates'] {
  return [...aggregates].sort(
    (a, b) => categoryRank(a.category) - categoryRank(b.category) || a.dir.localeCompare(b.dir),
  )
}

/**
 * Index one directory scope from scratch: walk the allowlisted positions,
 * classify every candidate, and record the metadata plus the fingerprint that
 * later detects drift.
 */
export async function indexScope(input: IndexInput): Promise<IndexResult> {
  const { scopeRoot, repo, config, dshHome, signal } = input
  const now = input.now ?? Date.now()
  const ignore = await loadIgnore(scopeRoot, dshHome)
  const sources = compileSources(config)
  const countOnly = new Set<string>(config.countOnlyCategories)

  const legacyRoots = await findDirsNamed(scopeRoot, config.legacyRootNames, {
    maxDepth: config.legacyMaxDepth,
    limit: config.maxLegacyRoots,
    signal,
  })

  const legacyGroups = new Map<string, CompiledSource[]>()
  const anchored: CompiledSource[] = []
  for (const source of sources) {
    if (source.legacyDir === null) {
      anchored.push(source)
      continue
    }
    const group = legacyGroups.get(source.legacyDir)
    if (group === undefined) legacyGroups.set(source.legacyDir, [source])
    else group.push(source)
  }

  const seen = new Map<string, { absolute: string; category: Category }>()
  // Only directories that can actually gain or lose a candidate are fingerprinted.
  // Recording every walked directory would produce thousands of stats on each
  // session start for a scope with a large `.codex/tmp`.
  const watchedDirs = new Set<string>([''])
  const addCandidate = (relative: string, absolute: string, category: Category): void => {
    if (seen.has(relative)) return
    if (isIgnored(relative, ignore.rules)) return
    seen.set(relative, { absolute, category })
  }

  for (const legacyRoot of legacyRoots) {
    const name = baseName(legacyRoot)
    const group = legacyGroups.get(name)
    if (group === undefined) continue
    markAncestors(legacyRoot, watchedDirs)
    for (const source of group) {
      if (source.base !== '') watchedDirs.add(`${legacyRoot}/${source.base}`)
    }
    for await (const file of walkFiles(join(scopeRoot, legacyRoot), { signal })) {
      const source = group.find(candidate => candidate.regex.test(file.relative))
      if (source === undefined) continue
      addCandidate(`${legacyRoot}/${file.relative}`, file.absolute, source.category)
    }
  }

  for (const source of anchored) {
    if (source.literal) {
      const absolute = join(scopeRoot, source.pattern)
      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      const parent = parentOf(source.pattern)
      if (parent !== '') watchedDirs.add(parent)
      addCandidate(source.pattern, absolute, source.category)
      continue
    }
    if (source.base === '') continue
    watchedDirs.add(source.base)
    for await (const file of walkFiles(join(scopeRoot, source.base), { signal })) {
      const relative = `${source.base}/${file.relative}`
      if (!source.regex.test(relative)) continue
      addCandidate(relative, file.absolute, source.category)
    }
  }

  const items: EntryRecord[] = []
  const aggregates = new Map<string, { category: string; dir: string; count: number; mtimeMs: number }>()
  for (const [relative, candidate] of seen) {
    const refined = refineCategory(candidate.category, relative)
    if (refined === 'skip') continue
    if (countOnly.has(refined)) {
      const dir = parentOf(relative)
      if (dir !== '') watchedDirs.add(dir)
      const key = `${refined}\u0000${dir}`
      const existing = aggregates.get(key)
      if (existing !== undefined) existing.count += 1
      else aggregates.set(key, { category: refined, dir, count: 1, mtimeMs: 0 })
      continue
    }
    if (!isTextCandidate(relative)) continue
    let info
    try {
      info = await stat(candidate.absolute)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const dir = parentOf(relative)
    if (dir !== '') watchedDirs.add(dir)
    const text = await readHead(candidate.absolute, config.headBytes)
    const title = extractTitle(text, baseName(relative), config.maxTitleChars)
    items.push({ relpath: relative, category: refined, title, size: info.size, mtimeMs: info.mtimeMs })
  }

  for (const aggregate of aggregates.values()) {
    const fact = await dirFact(scopeRoot, aggregate.dir)
    aggregate.mtimeMs = fact?.mtimeMs ?? 0
  }

  items.sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.relpath.localeCompare(b.relpath))

  const files: ScopeRecord['fingerprint']['files'] = items.map(item => ({
    relpath: item.relpath,
    size: item.size,
    mtimeMs: item.mtimeMs,
  }))
  const dirs: ScopeRecord['fingerprint']['dirs'] = []
  for (const relative of [...watchedDirs].sort()) {
    const fact = await dirFact(scopeRoot, relative)
    if (fact !== null) dirs.push(fact)
  }

  const byCategory: Record<string, number> = {}
  for (const item of items) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1
  for (const aggregate of aggregates.values()) {
    byCategory[aggregate.category] = (byCategory[aggregate.category] ?? 0) + aggregate.count
  }
  const total = items.length + [...aggregates.values()].reduce((sum, entry) => sum + entry.count, 0)

  const scope: ScopeRecord = {
    root: scopeRoot,
    name: input.name ?? baseName(scopeRoot),
    repoRoot: repo.repoRoot,
    mainRepoRoot: repo.mainRepoRoot,
    relToRepo: relativeToRepo(repo.repoRoot, scopeRoot),
    state: 'indexed',
    indexedAt: now,
    indexerVersion: INDEXER_VERSION,
    origin: null,
    fingerprint: { files, dirs },
    ignoreDigest: ignore.digest,
    stats: {
      total,
      byCategory,
      aggregates: aggregateSort([...aggregates.values()]),
    },
  }
  return { scope, entries: { root: scopeRoot, items } }
}

export interface CopyInput {
  /** Directory created for the worktree counterpart of the main scope. */
  scopeRoot: string
  name?: string
  repo: RepoInfo
  mainScope: ScopeRecord
  mainEntries: EntriesRecord
  config: ResolvedConfig
  dshHome: string
  now?: number
}

/**
 * Seed a directory in a freshly created worktree from its main-worktree
 * counterpart.
 *
 * Only metadata is copied, then every path is re-validated against the new
 * checkout: the fingerprint must describe *this* directory, or the first session
 * would immediately mark the copy stale. Entries missing from the branch are
 * dropped and counted, because that divergence is expected, not an error.
 */
export async function copyWorktreeScope(input: CopyInput): Promise<IndexResult> {
  const { scopeRoot, repo, mainScope, mainEntries, dshHome } = input
  const now = input.now ?? Date.now()
  const ignore = await loadIgnore(scopeRoot, dshHome)
  const items: EntryRecord[] = []
  let dropped = 0
  for (const item of mainEntries.items) {
    let info
    try {
      info = await stat(join(scopeRoot, item.relpath))
    } catch {
      dropped += 1
      continue
    }
    if (!info.isFile() || isIgnored(item.relpath, ignore.rules)) {
      dropped += 1
      continue
    }
    items.push({ ...item, size: info.size, mtimeMs: info.mtimeMs })
  }

  const files = items.map(item => ({ relpath: item.relpath, size: item.size, mtimeMs: item.mtimeMs }))
  const dirs: ScopeRecord['fingerprint']['dirs'] = []
  const seenDirs = new Set<string>()
  for (const item of items) {
    const dir = parentOf(item.relpath)
    if (seenDirs.has(dir)) continue
    seenDirs.add(dir)
    const fact = await dirFact(scopeRoot, dir)
    if (fact !== null) dirs.push(fact)
  }

  const byCategory: Record<string, number> = {}
  for (const item of items) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1
  const aggregates = mainScope.stats.aggregates
  for (const aggregate of aggregates) {
    byCategory[aggregate.category] = (byCategory[aggregate.category] ?? 0) + aggregate.count
  }

  const scope: ScopeRecord = {
    root: scopeRoot,
    name: input.name ?? baseName(scopeRoot),
    repoRoot: repo.repoRoot,
    mainRepoRoot: repo.mainRepoRoot,
    relToRepo: relativeToRepo(repo.repoRoot, scopeRoot),
    state: 'indexed',
    indexedAt: now,
    indexerVersion: INDEXER_VERSION,
    origin: { from: mainScope.root, at: now, dropped },
    fingerprint: { files, dirs },
    ignoreDigest: ignore.digest,
    stats: {
      total: items.length + aggregates.reduce((sum, entry) => sum + entry.count, 0),
      byCategory,
      aggregates: aggregateSort(aggregates),
    },
  }
  return { scope, entries: { root: scopeRoot, items } }
}

/**
 * Whether a stored index still describes the directory. Cheap by design: one stat
 * per indexed file and per watched directory, plus the ignore-rule digest. No
 * directory walk and no file reads.
 */
export async function checkStale(scope: ScopeRecord, dshHome: string): Promise<boolean> {
  if (scope.indexerVersion !== INDEXER_VERSION) return true
  const ignore = await loadIgnore(scope.root, dshHome)
  if (ignore.digest !== scope.ignoreDigest) return true
  for (const file of scope.fingerprint.files) {
    let info
    try {
      info = await stat(join(scope.root, file.relpath))
    } catch {
      return true
    }
    if (!info.isFile()) return true
    if (info.size !== file.size) return true
    if (Math.abs(info.mtimeMs - file.mtimeMs) > 0.5) return true
  }
  for (const dir of scope.fingerprint.dirs) {
    let info
    try {
      info = await stat(dir.relpath === '' ? scope.root : join(scope.root, dir.relpath))
    } catch {
      return true
    }
    if (!info.isDirectory()) return true
    if (Math.abs(info.mtimeMs - dir.mtimeMs) > 0.5) return true
  }
  return false
}
