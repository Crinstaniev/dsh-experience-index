/**
 * Signpost categories and configuration defaults.
 *
 * The index is a discovery surface, not a retrieval service: it records enough
 * metadata for a model to decide whether a file from an earlier agent session is
 * worth opening with its own read/grep tools. Categories therefore describe
 * *what a file is*, and only the last two are treated as noise.
 *
 * @module dsh-experience-index/config
 */
import z from '@deepseek-ai/schemastery'

/** What one indexed file is. `log` and `state` are counted, never expanded. */
export type Category = 'rule' | 'runbook' | 'design' | 'analysis' | 'note' | 'state' | 'log'

/** One `sources` row: which paths belong to which category. */
export interface SourceRule {
  glob: string
  category: Category
}

/**
 * Default allowlist. Keys off *semantic positions* such as `runbooks/` or
 * `rules/`, never off "every markdown file": a blacklist would chase each new
 * agent's directory naming, while a miss here only costs one omission.
 */
export const DEFAULT_SOURCES: SourceRule[] = [
  { glob: '.comate/rules/*.mdr', category: 'rule' },
  { glob: '.comate/rules/**/*.mdr', category: 'rule' },
  { glob: '.claude/rules/**/*.md', category: 'rule' },
  { glob: '.cursor/rules/*.mdc', category: 'rule' },
  { glob: '.github/copilot-instructions.md', category: 'rule' },
  { glob: '.codex/runbooks/**/*.md', category: 'runbook' },
  { glob: '.codex/analysis/**/*.md', category: 'analysis' },
  { glob: '.codex/**/live-design.md', category: 'design' },
  { glob: '.codex/**/*-design.md', category: 'design' },
  { glob: '.codex/**/summary.md', category: 'note' },
  { glob: '.comate/project_notes/**/*.md', category: 'note' },
  { glob: '.agents/notes/**/*.md', category: 'note' },
  { glob: '.codex/tmux-remote-logs/**/*.md', category: 'log' },
  { glob: '.codex/tmux-pane-registry.md', category: 'state' },
  { glob: '.codex/tmp/**/*', category: 'state' },
]

/** Categories rendered as one aggregate line instead of per-file entries. */
export const DEFAULT_COUNT_ONLY: Category[] = ['log', 'state']

/** Rendering order; more authoritative categories first. */
export const CATEGORY_ORDER: Category[] = ['rule', 'runbook', 'design', 'analysis', 'note', 'state', 'log']

/** Relative path of the per-project ignore file; committed with the repository. */
export const PROJECT_IGNORE_FILE = '.dsh/experience-ignore'

/** Relative path of the user-global ignore file under `$DSH_HOME`. */
export const GLOBAL_IGNORE_FILE = 'experience-ignore'

/** Directory names probed to decide whether a project is worth hinting about. */
export const LEGACY_PROBE_DIRS = ['.codex', '.comate', '.claude', '.agents']

/** Bump when indexing semantics change so stored indexes become stale. */
export const INDEXER_VERSION = 1

/**
 * Loader-facing configuration shape. Declared explicitly rather than inferred
 * from the schema: the inferred generic is deep enough to slow down `tsc`
 * substantially, and the resolved form below is what the indexer consumes.
 */
export interface ExperienceConfig {
  repoRootMarkers?: string[]
  sources?: SourceRule[]
  countOnlyCategories?: Category[]
  legacyRootNames?: string[]
  legacyMaxDepth?: number
  maxLegacyRoots?: number
  smallCategoryLimit?: number
  maxTitleChars?: number
  headBytes?: number
  signpostMaxBytes?: number
  hintRepeatDays?: number
}

export const Config = z.object({
  repoRootMarkers: z.array(z.string()).default(['.git']),
  sources: z
    .array(z.object({ glob: z.string(), category: z.string() }))
    .default(DEFAULT_SOURCES.map(source => ({ ...source }))),
  countOnlyCategories: z.array(z.string()).default([...DEFAULT_COUNT_ONLY]),
  /** Directory names treated as detached "experience roots" anywhere below the project root. */
  legacyRootNames: z.array(z.string()).default([...LEGACY_PROBE_DIRS]),
  /** How deep below the project root those detached roots are discovered. */
  legacyMaxDepth: z.natural().default(3),
  maxLegacyRoots: z.natural().default(32),
  smallCategoryLimit: z.natural().default(6),
  maxTitleChars: z.natural().default(96),
  headBytes: z.natural().default(4096),
  signpostMaxBytes: z.natural().default(2048),
  hintRepeatDays: z.natural().default(7),
})

export type ResolvedConfig = {
  repoRootMarkers: string[]
  sources: SourceRule[]
  countOnlyCategories: Category[]
  legacyRootNames: string[]
  legacyMaxDepth: number
  maxLegacyRoots: number
  smallCategoryLimit: number
  maxTitleChars: number
  headBytes: number
  signpostMaxBytes: number
  hintRepeatDays: number
}

/** Normalize loader-provided config into the shape the indexer consumes. */
export function resolveConfig(config: ExperienceConfig | undefined): ResolvedConfig {
  const value = config ?? {}
  return {
    repoRootMarkers: value.repoRootMarkers ?? ['.git'],
    sources: (value.sources ?? DEFAULT_SOURCES).map(source => ({
      glob: source.glob,
      category: source.category as Category,
    })),
    countOnlyCategories: (value.countOnlyCategories ?? DEFAULT_COUNT_ONLY) as Category[],
    legacyRootNames: value.legacyRootNames ?? [...LEGACY_PROBE_DIRS],
    legacyMaxDepth: value.legacyMaxDepth ?? 3,
    maxLegacyRoots: value.maxLegacyRoots ?? 32,
    smallCategoryLimit: value.smallCategoryLimit ?? 6,
    maxTitleChars: value.maxTitleChars ?? 96,
    headBytes: value.headBytes ?? 4096,
    signpostMaxBytes: value.signpostMaxBytes ?? 2048,
    hintRepeatDays: value.hintRepeatDays ?? 7,
  }
}
