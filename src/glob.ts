/**
 * A deliberately small glob dialect: `*`, `?`, and whole-segment `**`.
 *
 * Indexing must not depend on `fs.glob` (Node 22+) or a third-party matcher, so
 * the conversion is local and total. Patterns are always relative to the project
 * root and use `/` separators.
 *
 * @module dsh-experience-index/glob
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const SPECIAL = /[.*+?^${}()|[\]\\]/g

/** Escape one literal glob segment while translating `*` and `?`. */
function segmentToRegExp(segment: string): string {
  let out = ''
  for (const char of segment) {
    if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else out += char.replace(SPECIAL, '\\$&')
  }
  return out
}

/**
 * Translate a glob into an anchored regular expression over a `/`-separated
 * relative path. A whole-segment `**` matches zero or more segments.
 */
export function globToRegExp(pattern: string): RegExp {
  const parts = pattern.split('/').filter(part => part.length > 0)
  let source = ''
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!
    const last = index === parts.length - 1
    if (part === '**') {
      source += last ? '.*' : '(?:[^/]+/)*'
      continue
    }
    source += segmentToRegExp(part)
    if (!last) source += '/'
  }
  return new RegExp(`^${source}$`)
}

/** Whether a relative path matches any compiled glob. */
export function matchesAny(relativePath: string, compiled: readonly RegExp[]): boolean {
  return compiled.some(pattern => pattern.test(relativePath))
}

/** Strip leading `./` and trailing `/` so patterns and paths compare cleanly. */
export function normalizePattern(pattern: string): string {
  return pattern.replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * The non-glob directory prefix of a pattern: the deepest directory that can be
 * walked without evaluating wildcards. A `runbooks` pattern yields
 * `.codex/runbooks`; a pattern whose wildcard sits directly under `.codex`
 * (live-design) yields `.codex`.
 */
export function globBaseDir(pattern: string): string {
  const parts = normalizePattern(pattern).split('/').filter(part => part.length > 0)
  const literal: string[] = []
  for (const part of parts) {
    if (part.includes('*') || part.includes('?')) break
    literal.push(part)
  }
  if (literal.length === parts.length) literal.pop()
  return literal.join('/')
}

/** Directories never worth descending into while collecting candidates. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'target', 'dist', '__pycache__'])

/** One walked file: path relative to the walk root plus its absolute path. */
export interface WalkedFile {
  relative: string
  absolute: string
}

/**
 * Find directories whose basename matches `names`, bounded by depth and count.
 *
 * This is what makes sub-project experience visible: a repository may contain
 * `services/api/.codex` and `services/worker/.codex` below a single root, and a
 * root-anchored glob would never reach either. Discovery lists directories only;
 * it never reads files, and it stops descending once it finds a match.
 */
export async function findDirsNamed(
  root: string,
  names: readonly string[],
  options: { maxDepth?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<string[]> {
  const wanted = new Set(names)
  const maxDepth = options.maxDepth ?? 3
  const limit = options.limit ?? 32
  const found: string[] = []
  const queue: Array<{ relative: string; depth: number }> = [{ relative: '', depth: 0 }]
  while (queue.length > 0 && found.length < limit) {
    options.signal?.throwIfAborted()
    const current = queue.shift()!
    let entries
    try {
      entries = await readdir(current.relative === '' ? root : join(root, current.relative), {
        withFileTypes: true,
      })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      const relative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`
      if (wanted.has(entry.name)) {
        found.push(relative)
        if (found.length >= limit) break
        continue
      }
      if (current.depth + 1 < maxDepth) queue.push({ relative, depth: current.depth + 1 })
    }
  }
  return found
}

/**
 * Walk one directory tree and yield regular files as `/`-separated paths
 * relative to `root`. Symlinks are followed only for files; directory symlinks
 * are skipped to keep traversal bounded and cycle-free.
 */
export async function* walkFiles(
  root: string,
  options: { maxDepth?: number; signal?: AbortSignal; onDirectory?: (relative: string) => void } = {},
): AsyncGenerator<WalkedFile> {
  const maxDepth = options.maxDepth ?? 12
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: root, relative: '', depth: 0 },
  ]
  while (queue.length > 0) {
    options.signal?.throwIfAborted()
    const current = queue.shift()!
    options.onDirectory?.(current.relative)
    let entries
    try {
      entries = await readdir(current.absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && SKIP_DIRS.has(entry.name)) continue
      const relative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`
      const absolute = join(current.absolute, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (current.depth + 1 > maxDepth) continue
        queue.push({ absolute, relative, depth: current.depth + 1 })
        continue
      }
      if (entry.isFile()) {
        yield { relative, absolute }
        continue
      }
      if (entry.isSymbolicLink()) {
        // Follow file symlinks only: a linked skill directory can point outside
        // the repository and would otherwise make traversal unbounded.
        try {
          const { stat } = await import('node:fs/promises')
          const target = await stat(absolute)
          if (target.isFile()) yield { relative, absolute }
        } catch {
          // A broken symlink is simply not a candidate.
        }
      }
    }
  }
}
