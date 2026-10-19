/**
 * Durable shapes for the experience index.
 *
 * Three tables, all host-side and model-invisible:
 * - `scopes` holds one record per directory the user actually indexed. An
 *   un-indexed directory costs no row, so the list only grows when a human adds
 *   a scope.
 * - `entries` keeps the signpost metadata for one scope in a single record, so a
 *   reindex replaces it atomically instead of rewriting per-file rows.
 * - `hints` is only a rate-limit ledger for the "no index yet" line.
 *
 * Only metadata is stored: paths relative to the scope, categories, titles,
 * sizes, mtimes. File bodies stay on disk, where the model reads them with its
 * own tools.
 *
 * @module dsh-experience-index/domain
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * Persisted scope states. Staleness is deliberately *derived* by `checkStale`
 * rather than stored: a recorded flag is no more trustworthy than a fresh stat.
 */
export const SCOPE_STATES = ['indexed', 'excluded'] as const
export type ScopeState = (typeof SCOPE_STATES)[number]

const fileFact = z.object({
  relpath: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
})

const dirFact = z.object({
  relpath: z.string(),
  mtimeMs: z.number(),
})

const aggregate = z.object({
  category: z.string(),
  dir: z.string(),
  count: z.number(),
  mtimeMs: z.number(),
})

const forkOrigin = z.object({
  from: z.string(),
  at: z.number(),
  dropped: z.number(),
})

export const scopeRecord = z.object({
  /** Absolute, symlink-resolved directory that was indexed. */
  root: z.string(),
  name: z.string(),
  /** Repository containing the scope, or null for a plain directory. */
  repoRoot: z.string().nullable(),
  /** Main worktree root when the scope lives in a linked worktree. */
  mainRepoRoot: z.string().nullable(),
  /** Scope path relative to the repository root, or null outside git. */
  relToRepo: z.string().nullable(),
  state: z.enum(SCOPE_STATES),
  indexedAt: z.number(),
  indexerVersion: z.number(),
  origin: forkOrigin.nullable(),
  fingerprint: z.object({
    files: z.array(fileFact),
    dirs: z.array(dirFact),
  }),
  ignoreDigest: z.string(),
  stats: z.object({
    total: z.number(),
    byCategory: z.record(z.string(), z.number()),
    aggregates: z.array(aggregate),
  }),
})

export type ScopeRecord = z.infer<typeof scopeRecord>

const entry = z.object({
  relpath: z.string(),
  category: z.string(),
  title: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
})

export const entriesRecord = z.object({
  root: z.string(),
  items: z.array(entry),
})

export type EntriesRecord = z.infer<typeof entriesRecord>
export type EntryRecord = z.infer<typeof entry>

export const hintRecord = z.object({
  root: z.string(),
  lastNaggedAt: z.number(),
})

export type HintRecord = z.infer<typeof hintRecord>

/**
 * The domain declaration opened by the plugin. The argument is widened to `never`
 * because `defineDomain`'s generic instantiation over three nested zod schemas
 * exceeds TypeScript's depth budget; the schemas above remain the runtime
 * validation boundary.
 *
 * Version 2 changed the unit from a repository root to an arbitrary directory.
 */
export const experienceDomain = defineDomain({
  name: 'experience_index',
  version: 2,
  tables: {
    scopes: domainTable(scopeRecord as never),
    entries: domainTable(entriesRecord as never),
    hints: domainTable(hintRecord as never),
  },
} as never)
