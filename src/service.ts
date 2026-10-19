/**
 * Business logic for the experience index, independent of the cordis plugin
 * wiring so it can be exercised without a running harness.
 *
 * The unit is a **directory scope**: any directory the user indexed. A session
 * resolves to the deepest scope containing its working directory, so a monorepo
 * can index `sub-project/` without also indexing its parent.
 *
 * @module dsh-experience-index/service
 */
import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { checkStale, copyWorktreeScope, indexScope } from './indexer.js'
import { renderSignpost } from './render.js'
import { canonicalDir, contains, relativeToRepo, resolveRepo, type RepoInfo } from './project.js'
import { LEGACY_PROBE_DIRS, type ResolvedConfig } from './config.js'
import type { EntriesRecord, HintRecord, ScopeRecord } from './domain.js'

/** Minimal structural view of a storage-domain table; the real one is generic. */
export interface Table<T> {
  get(key: string): T | undefined
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  entries(): Iterable<[string, T]>
  readonly size: number
}

export interface DomainHandle {
  table(name: string): Table<unknown>
  close(): void
}

export interface ServiceOptions {
  domain: DomainHandle
  config: ResolvedConfig
  dshHome: string
  now?: () => number
}

export interface ScopeSummary {
  root: string
  name: string
  repoRoot: string | null
  mainRepoRoot: string | null
  relToRepo: string | null
  state: string
  indexedAt: number
  stale: boolean
  origin: ScopeRecord['origin']
  stats: ScopeRecord['stats']
}

export type ResolveOutcome =
  | { kind: 'signpost'; text: string; root: string; stale: boolean }
  | { kind: 'hint'; text: string; root: string; detected: string[] }
  | { kind: 'none'; root: string }

const SUMMARY_ORDER = ['rule', 'runbook', 'design', 'analysis', 'note', 'state', 'log']

/** One-line summary of an indexed scope, used by the `/experience` command. */
export function describeScope(scope: ScopeRecord): string {
  const parts: string[] = []
  for (const category of SUMMARY_ORDER) {
    const count = scope.stats.byCategory[category]
    if (count !== undefined && count > 0) parts.push(`${category} ${count}`)
  }
  const total = `${scope.stats.total} file${scope.stats.total === 1 ? '' : 's'}`
  const breakdown = parts.length === 0 ? 'no reference material' : parts.join(' · ')
  return `${total} · ${breakdown}`
}

const HINT_FRAME_OPEN = '<system-reminder>'
const HINT_FRAME_CLOSE = '</system-reminder>'

export class ExperienceIndexService {
  private readonly scopes: Table<ScopeRecord>
  private readonly entriesTable: Table<EntriesRecord>
  private readonly hints: Table<HintRecord>

  constructor(private readonly options: ServiceOptions) {
    this.scopes = options.domain.table('scopes') as Table<ScopeRecord>
    this.entriesTable = options.domain.table('entries') as Table<EntriesRecord>
    this.hints = options.domain.table('hints') as Table<HintRecord>
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private get markers(): string[] {
    return this.options.config.repoRootMarkers
  }

  /** Canonicalize a directory path, resolving symlinks when possible. */
  async canonical(dir: string): Promise<string> {
    return canonicalDir(dir)
  }

  /** Read the stored scope without touching the filesystem. */
  record(root: string): ScopeRecord | undefined {
    return this.scopes.get(root)
  }

  /** Read the stored signpost entries without touching the filesystem. */
  entries(root: string): EntriesRecord {
    return this.entriesTable.get(root) ?? { root, items: [] }
  }

  /**
   * The deepest stored scope containing `cwd`. Nested scopes are allowed, and the
   * most specific one wins so a session in `repo/sub/` never receives the parent
   * repository's signpost as well.
   */
  selectScope(cwd: string): ScopeRecord | undefined {
    let best: ScopeRecord | undefined
    for (const [, scope] of this.scopes.entries()) {
      if (!contains(scope.root, cwd)) continue
      if (best === undefined || scope.root.length > best.root.length) best = scope
    }
    return best
  }

  /** Build the index for one directory and persist it as a scope. */
  async indexDirectory(dir: string, name?: string): Promise<ScopeRecord> {
    const root = await canonicalDir(dir)
    const repo = await resolveRepo(root, this.markers)
    const result = await indexScope({
      scopeRoot: root,
      name,
      repo,
      config: this.options.config,
      dshHome: this.options.dshHome,
      now: this.now,
    })
    await this.entriesTable.put(root, result.entries)
    await this.scopes.put(root, result.scope)
    await this.hints.delete(root)
    return result.scope
  }

  /** Re-run indexing, which is the same operation by construction. */
  async reindex(dir: string): Promise<ScopeRecord> {
    return this.indexDirectory(dir)
  }

  /** Exclude or re-include a scope without deleting its metadata. */
  async setExcluded(directory: string, excluded: boolean): Promise<ScopeRecord | undefined> {
    const root = await canonicalDir(directory)
    const current = this.scopes.get(root)
    if (current === undefined) return undefined
    const next: ScopeRecord = { ...current, state: excluded ? 'excluded' : 'indexed' }
    await this.scopes.put(root, next)
    return next
  }

  /** Remove a scope record and its entries; the checkout is untouched. */
  async forget(directory: string): Promise<boolean> {
    const root = await canonicalDir(directory)
    await this.entriesTable.delete(root)
    await this.hints.delete(root)
    return this.scopes.delete(root)
  }

  /** Every stored scope, with staleness computed on demand. */
  async list(): Promise<ScopeSummary[]> {
    const summaries: ScopeSummary[] = []
    for (const [, scope] of this.scopes.entries()) {
      const stale = scope.state === 'excluded' ? false : await checkStale(scope, this.options.dshHome)
      summaries.push({
        root: scope.root,
        name: scope.name,
        repoRoot: scope.repoRoot,
        mainRepoRoot: scope.mainRepoRoot,
        relToRepo: scope.relToRepo,
        state: scope.state,
        indexedAt: scope.indexedAt,
        stale,
        origin: scope.origin,
        stats: scope.stats,
      })
    }
    summaries.sort((a, b) => a.root.localeCompare(b.root))
    return summaries
  }

  /** Every stored entry for one scope, for the settings UI's expandable list. */
  entryList(root: string): Array<{ relpath: string; category: string; title: string; size: number; mtimeMs: number }> {
    return this.entries(root).items.map(item => ({ ...item }))
  }

  /** Read a bounded preview of one indexed path for the settings UI. */
  async preview(root: string, relativePath: string, maxBytes = 16384): Promise<{ text: string; truncated: boolean }> {
    const { open } = await import('node:fs/promises')
    const handle = await open(join(root, relativePath), 'r')
    try {
      const buffer = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const truncated = bytesRead > maxBytes
      return { text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8'), truncated }
    } finally {
      await handle.close()
    }
  }

  /** Detect which legacy-agent directories exist, for a hint or diagnostics. */
  async detectLegacyDirs(root: string): Promise<string[]> {
    const found: string[] = []
    for (const dir of LEGACY_PROBE_DIRS) {
      try {
        const info = await stat(join(root, dir))
        if (info.isDirectory()) found.push(dir)
      } catch {
        // Absent is the common case.
      }
    }
    return found
  }

  private async shouldHint(root: string): Promise<boolean> {
    const hint = this.hints.get(root)
    if (hint === undefined) return true
    return this.now - hint.lastNaggedAt >= this.options.config.hintRepeatDays * 86_400_000
  }

  private async recordHint(root: string): Promise<void> {
    await this.hints.put(root, { root, lastNaggedAt: this.now })
  }

  private renderHint(detected: readonly string[]): string {
    const dirs = detected.map(dir => `${dir}/`).join(', ')
    return [
      HINT_FRAME_OPEN,
      'This directory has no experience index yet.',
      `Detected directories from earlier agent sessions: ${dirs}.`,
      'If you are taking over existing work, index it from Settings → Experience Index',
      'before designing a workflow from scratch.',
      HINT_FRAME_CLOSE,
    ].join('\n')
  }

  /**
   * Find the main-worktree counterpart of a directory whose scope should be seeded.
   *
   * A linked worktree maps back by its path relative to the repository root, so a
   * scope at `main/sub` seeds `worktree/sub` — not the whole checkout.
   */
  private async worktreeCounterpart(
    cwd: string,
    repo: RepoInfo,
  ): Promise<{ scopeRoot: string; mainScope: ScopeRecord } | null> {
    if (!repo.isWorktree || repo.repoRoot === null || repo.mainRepoRoot === null) return null
    const inside = relative(repo.repoRoot, cwd)
    if (inside.startsWith('..') || isAbsolute(inside)) return null
    const mainCwd = join(repo.mainRepoRoot, inside)
    const mainScope = this.selectScope(mainCwd)
    if (mainScope === undefined || mainScope.state === 'excluded') return null
    const scopeRel = relativeToRepo(repo.mainRepoRoot, mainScope.root)
    if (scopeRel === null) return null
    const scopeRoot = scopeRel === '' ? repo.repoRoot : join(repo.repoRoot, scopeRel)
    if (this.scopes.get(scopeRoot) !== undefined) return null
    return { scopeRoot, mainScope }
  }

  private render(scope: ScopeRecord, cwd: string, stale: boolean): ResolveOutcome {
    const rendered = renderSignpost({
      scope,
      entries: this.entries(scope.root),
      stale,
      cwd,
      maxBytes: this.options.config.signpostMaxBytes,
      smallCategoryLimit: this.options.config.smallCategoryLimit,
    })
    return { kind: 'signpost', text: rendered.text, root: scope.root, stale }
  }

  /**
   * Decide what one session should see for this working directory.
   *
   * Precedence: the deepest containing scope wins; an excluded scope silences the
   * directory; a linked worktree is seeded from its main counterpart on first
   * sight; otherwise a directory containing legacy agent directories gets one
   * rate-limited hint.
   */
  async resolve(cwd: string): Promise<ResolveOutcome> {
    const canonical = await canonicalDir(cwd)
    const existing = this.selectScope(canonical)
    if (existing !== undefined) {
      if (existing.state === 'excluded') return { kind: 'none', root: existing.root }
      return this.render(existing, canonical, await checkStale(existing, this.options.dshHome))
    }

    const repo = await resolveRepo(canonical, this.markers)
    const counterpart = await this.worktreeCounterpart(canonical, repo)
    if (counterpart !== null) {
      const copied = await copyWorktreeScope({
        scopeRoot: counterpart.scopeRoot,
        repo,
        mainScope: counterpart.mainScope,
        mainEntries: this.entries(counterpart.mainScope.root),
        config: this.options.config,
        dshHome: this.options.dshHome,
        now: this.now,
      })
      await this.entriesTable.put(counterpart.scopeRoot, copied.entries)
      await this.scopes.put(counterpart.scopeRoot, copied.scope)
      return this.render(copied.scope, canonical, false)
    }

    const detected = await this.detectLegacyDirs(canonical)
    if (detected.length === 0) return { kind: 'none', root: canonical }
    if (!(await this.shouldHint(canonical))) return { kind: 'none', root: canonical }
    await this.recordHint(canonical)
    return { kind: 'hint', text: this.renderHint(detected), root: canonical, detected }
  }
}
