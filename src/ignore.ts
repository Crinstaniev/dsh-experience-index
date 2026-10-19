/**
 * Per-project and user-global ignore rules.
 *
 * Rules live on disk (`.dsh/experience-ignore`, committed with the repository)
 * rather than only in the database, so a decision to treat a file as noise
 * travels with the checkout and survives a rebuild of the index.
 *
 * @module dsh-experience-index/ignore
 */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { globToRegExp, normalizePattern } from './glob.js'
import { GLOBAL_IGNORE_FILE, PROJECT_IGNORE_FILE } from './config.js'

export interface IgnoreRule {
  negated: boolean
  regex: RegExp
  /** Matching the final path segment too, so a bare `notes.md` works anywhere. */
  basename: string | null
}

/** Parse gitignore-like text into ordered rules; later rules win. */
export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    const pattern = normalizePattern(negated ? line.slice(1) : line)
    if (pattern === '') continue
    const hasSlash = pattern.includes('/')
    rules.push({
      negated,
      regex: globToRegExp(pattern),
      basename: hasSlash ? null : pattern.replace(/^\*\*\//, ''),
    })
  }
  return rules
}

/** Whether a relative path is ignored once all rules are applied in order. */
export function isIgnored(relativePath: string, rules: readonly IgnoreRule[]): boolean {
  let ignored = false
  const base = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  for (const rule of rules) {
    const matched = rule.regex.test(relativePath) || (rule.basename !== null && globToRegExp(rule.basename).test(base))
    if (matched) ignored = !rule.negated
  }
  return ignored
}

export interface IgnoreState {
  rules: IgnoreRule[]
  /** SHA-1 over every source file so an edited rule set invalidates the index. */
  digest: string
  sources: string[]
}

/** Read `${dshHome}/experience-ignore` then the project file; project rules win. */
export async function loadIgnore(root: string, dshHome: string): Promise<IgnoreState> {
  const sources = [join(dshHome, GLOBAL_IGNORE_FILE), join(root, PROJECT_IGNORE_FILE)]
  const rules: IgnoreRule[] = []
  const digest = createHash('sha1')
  for (const path of sources) {
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    digest.update(`${path}\u0000`)
    digest.update(text)
    rules.push(...parseIgnore(text))
  }
  return { rules, digest: digest.digest('hex'), sources }
}

/** Default harness home, matching `dsh-home-paths` resolution. */
export function defaultDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return fromEnv === undefined || fromEnv === '' ? join(homedir(), '.dsh') : fromEnv
}
