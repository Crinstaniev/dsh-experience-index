/**
 * Directory scopes and the repository they happen to live in.
 *
 * The indexing unit is an explicit directory, not a repository root: a monorepo
 * may index `sub-project/` on its own, and a directory outside any repository can
 * still be indexed. Git is consulted only when it has to be — to know whether a
 * scope is a linked worktree that should be seeded from its main counterpart.
 *
 * @module dsh-experience-index/project
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface RepoInfo {
  /** Repository (or worktree) root containing the directory, or null outside git. */
  repoRoot: string | null
  /** Main worktree root when `repoRoot` is a linked worktree. */
  mainRepoRoot: string | null
  isWorktree: boolean
}

/** Canonicalize a directory: absolute, symlink-resolved, no trailing separator. */
export async function canonicalDir(dir: string): Promise<string> {
  const absolute = resolve(dir)
  try {
    return await realpath(absolute)
  } catch {
    return absolute
  }
}

/** Read the `gitdir:` line of a linked worktree's `.git` file. */
async function readGitDirFile(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(text)
    if (match === null) return null
    const value = match[1]!.trim()
    return isAbsolute(value) ? value : resolve(dirname(path), value)
  } catch {
    return null
  }
}

/**
 * Recover the main worktree root from `<main>/.git/worktrees/<name>`.
 * Returns null for gitdir layouts this plugin does not model.
 */
export function mainRootFromGitDir(gitDir: string): string | null {
  const normalized = gitDir.replace(/[\\/]+$/, '')
  const worktrees = dirname(normalized)
  if (basename(worktrees) !== 'worktrees') return null
  const dotGit = dirname(worktrees)
  if (basename(dotGit) !== '.git') return null
  return dirname(dotGit)
}

/** Whether `child` is `parent` or lives underneath it. */
export function contains(parent: string, child: string): boolean {
  if (parent === child) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Find the repository containing a directory by climbing to the nearest marker.
 * A linked worktree exposes `.git` as a file whose `gitdir:` points at the main
 * repository, which is enough to recover the main root without a git subprocess.
 */
export async function resolveRepo(dir: string, markers: readonly string[]): Promise<RepoInfo> {
  let current = await canonicalDir(dir)
  for (;;) {
    for (const marker of markers) {
      const candidate = join(current, marker)
      let info
      try {
        info = await stat(candidate)
      } catch {
        continue
      }
      if (info.isDirectory()) return { repoRoot: current, mainRepoRoot: null, isWorktree: false }
      if (info.isFile()) {
        const gitDir = await readGitDirFile(candidate)
        const mainRoot = gitDir === null ? null : mainRootFromGitDir(gitDir)
        return {
          repoRoot: current,
          // Canonicalize the counterpart too: the `gitdir:` value is written by
          // git and may spell the same directory through a different path.
          mainRepoRoot: mainRoot === null ? null : await canonicalDir(mainRoot),
          isWorktree: true,
        }
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return { repoRoot: null, mainRepoRoot: null, isWorktree: false }
}

/** The scope directory's path relative to its repository root, using `/`. */
export function relativeToRepo(repoRoot: string | null, scopeRoot: string): string | null {
  if (repoRoot === null) return null
  if (repoRoot === scopeRoot) return ''
  const rel = relative(repoRoot, scopeRoot)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/** Render `target` relative to `cwd`, using `/` so injected paths are portable. */
export function displayPath(cwd: string, target: string): string {
  const rel = relative(cwd, target)
  if (rel === '') return '.'
  return rel.split(sep).join('/')
}
