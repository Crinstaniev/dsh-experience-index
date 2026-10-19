/**
 * Frontmatter parsing, one-line title extraction, and category refinement.
 *
 * Everything here is a pure function over the first few kilobytes of a file, so
 * indexing never reads a 33 KB runbook end to end: the signpost only needs one
 * sentence that lets a model decide whether the file is relevant.
 *
 * @module dsh-experience-index/classify
 */
import type { Category } from './config.js'

export interface Frontmatter {
  data: Record<string, string>
  /** Offset in the original text where the body starts. */
  bodyOffset: number
}

const FRONTMATTER_OPEN = /^---\r?\n/
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)\s*$/m

/** Parse the leading `---` block of a markdown-ish file. Total, never throws. */
export function parseFrontmatter(text: string): Frontmatter {
  if (!FRONTMATTER_OPEN.test(text)) return { data: {}, bodyOffset: 0 }
  const rest = text.replace(FRONTMATTER_OPEN, '')
  const close = FRONTMATTER_CLOSE.exec(rest)
  if (close === null) return { data: {}, bodyOffset: 0 }
  const block = rest.slice(0, close.index)
  const data: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    let value = match[2]!.trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value !== '') data[match[1]!] = value
  }
  return { data, bodyOffset: close.index + close[0].length }
}

/** Collapse whitespace and bound a title to the configured character budget. */
export function normalizeTitle(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

/**
 * Derive the one-line description used in the signpost. Order matters: an
 * explicit `description` beats a heading, a heading beats a bare first line, and
 * the file name is the last resort.
 */
export function extractTitle(text: string, fallbackName: string, maxChars: number): string {
  const { data, bodyOffset } = parseFrontmatter(text)
  const described = data.description ?? data.title ?? data.summary
  if (described !== undefined && described.trim() !== '') return normalizeTitle(described, maxChars)
  const body = text.slice(bodyOffset)
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line === '---') continue
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading !== null) return normalizeTitle(heading[1]!, maxChars)
    const plain = line.replace(/^[-*+]\s+/, '').replace(/^>\s+/, '')
    return normalizeTitle(plain, maxChars)
  }
  return normalizeTitle(fallbackName.replace(/\.(md|mdr|mdc|markdown)$/i, ''), maxChars)
}

/** A file under one of these segments is never worth signposting. */
const SKIP_SEGMENTS = new Set(['worktrees', 'tmp', 'node_modules', '.git', 'dist', 'target'])

/** File-name shapes that describe live state rather than durable experience. */
const STATE_NAME = /(?:^|[-_.])(registry|state)(?:[-_.]|$)/i
const LOG_NAME = /(?:^|[-_.])(log|logs|transcript)(?:[-_.]|$)/i

export type RefinedCategory = Category | 'skip'

/**
 * Refine a source-declared category with path and file-name evidence. This is
 * where `.codex/tmux-pane-registry.md` stops counting as a runbook: it is live
 * state, and signposting it would send the model to the wrong place.
 */
export function refineCategory(base: Category, relativePath: string): RefinedCategory {
  const segments = relativePath.split('/')
  for (const segment of segments.slice(0, -1)) {
    if (SKIP_SEGMENTS.has(segment)) return 'skip'
  }
  const name = segments[segments.length - 1] ?? ''
  if (base === 'log' || base === 'state') return base
  if (STATE_NAME.test(name)) return 'state'
  if (LOG_NAME.test(name)) return 'log'
  return base
}

/** Whether a file extension can carry experience notes at all. */
export function isTextCandidate(relativePath: string): boolean {
  return /\.(md|mdr|mdc|markdown)$/i.test(relativePath)
}

/** A basename without its extension, used as the final title fallback. */
export function baseName(relativePath: string): string {
  const index = relativePath.lastIndexOf('/')
  return index === -1 ? relativePath : relativePath.slice(index + 1)
}
