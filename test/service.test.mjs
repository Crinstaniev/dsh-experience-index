import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { ExperienceIndexService } from '../lib/service.js'

/** Minimal in-memory stand-in for a storage-domain handle. */
function memoryDomain() {
  const tables = new Map()
  return {
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map())
      const table = tables.get(name)
      return {
        get: key => table.get(key),
        put: async (key, value) => {
          table.set(key, value)
        },
        delete: async key => table.delete(key),
        entries: () => [...table.entries()][Symbol.iterator](),
        get size() {
          return table.size
        },
      }
    },
    close() {},
  }
}

async function fixture(files, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-experience-svc-'))
  if (options.git !== false) await mkdir(join(root, '.git'), { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, content, 'utf8')
  }
  return root
}

function build(dshHome) {
  const clock = { now: 1_700_000_000_000 }
  const service = new ExperienceIndexService({
    domain: memoryDomain(),
    config: resolveConfig(undefined),
    dshHome,
    now: () => clock.now,
  })
  return { service, clock }
}

test('an indexed directory resolves to a signpost', async () => {
  const root = await fixture({
    '.codex/runbooks/r.md': '---\ndescription: packaging\n---\n',
    '.codex/tmux-remote-logs/a.md': 'log\n',
  })
  try {
    const { service } = build(root)
    await service.indexDirectory(root)
    const outcome = await service.resolve(root)
    assert.equal(outcome.kind, 'signpost')
    assert.match(outcome.text, /runbooks \(1\)/)
    assert.match(outcome.text, /packaging/)
    assert.match(outcome.text, /Not reference material/)
    assert.equal(outcome.stale, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a nested scope wins over its parent', async () => {
  const root = await fixture({
    '.codex/runbooks/parent.md': '# parent\n',
    'sub/.codex/runbooks/child.md': '# child\n',
  })
  try {
    const { service } = build(root)
    await service.indexDirectory(root)
    await service.indexDirectory(join(root, 'sub'))

    const canonicalRoot = await service.canonical(root)
    const canonicalSub = await service.canonical(join(root, 'sub'))

    const atRoot = await service.resolve(root)
    assert.equal(atRoot.kind, 'signpost')
    assert.equal(atRoot.root, canonicalRoot)

    const inSub = await service.resolve(join(root, 'sub'))
    assert.equal(inSub.kind, 'signpost')
    assert.equal(inSub.root, canonicalSub)
    assert.match(inSub.text, /\.codex\/runbooks\/child\.md/)
    assert.doesNotMatch(inSub.text, /parent\.md/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a directory without a repository can still be indexed', async () => {
  const root = await fixture({ '.comate/rules/a.mdr': '# rule\n' }, { git: false })
  try {
    const { service } = build(root)
    const scope = await service.indexDirectory(root)
    assert.equal(scope.repoRoot, null)
    assert.equal(scope.relToRepo, null)
    const outcome = await service.resolve(root)
    assert.equal(outcome.kind, 'signpost')
    assert.match(outcome.text, /rules \(1\)/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a directory with legacy directories gets one rate-limited hint', async () => {
  const root = await fixture({ '.codex/runbooks/r.md': '# r\n' })
  try {
    const { service, clock } = build(root)
    const first = await service.resolve(root)
    assert.equal(first.kind, 'hint')
    assert.match(first.text, /no experience index yet/)
    assert.deepEqual(first.detected, ['.codex'])

    assert.equal((await service.resolve(root)).kind, 'none')

    clock.now += 8 * 86_400_000
    assert.equal((await service.resolve(root)).kind, 'hint')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a directory without legacy directories stays silent', async () => {
  const root = await fixture({ 'README.md': '# plain\n' })
  try {
    const { service } = build(root)
    assert.equal((await service.resolve(root)).kind, 'none')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an excluded scope resolves to nothing even when indexed', async () => {
  const root = await fixture({ '.codex/runbooks/r.md': '# r\n' })
  try {
    const { service } = build(root)
    await service.indexDirectory(root)
    await service.setExcluded(root, true)
    assert.equal((await service.resolve(root)).kind, 'none')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a nested scope in a linked worktree is seeded from its main counterpart', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-experience-fork-'))
  const main = join(base, 'main')
  const worktree = join(base, 'feature')
  const mainScope = join(main, 'sub')
  try {
    await mkdir(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
    await mkdir(join(mainScope, '.codex', 'runbooks'), { recursive: true })
    await writeFile(join(mainScope, '.codex', 'runbooks', 'kept.md'), '# kept\n', 'utf8')
    await writeFile(join(mainScope, '.codex', 'runbooks', 'absent.md'), '# absent\n', 'utf8')

    await mkdir(join(worktree, 'sub', '.codex', 'runbooks'), { recursive: true })
    await writeFile(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`, 'utf8')
    await writeFile(join(worktree, 'sub', '.codex', 'runbooks', 'kept.md'), '# kept\n', 'utf8')

    const { service } = build(main)
    await service.indexDirectory(mainScope)

    const outcome = await service.resolve(join(worktree, 'sub'))
    assert.equal(outcome.kind, 'signpost')
    assert.equal(outcome.root, await service.canonical(join(worktree, 'sub')))
    assert.match(outcome.text, /Copied from the main worktree/)
    assert.match(outcome.text, /1 indexed entry is absent/)

    const worktreeScope = await service.canonical(join(worktree, 'sub'))
    const summary = await service.list()
    const seeded = summary.find(scope => scope.root === worktreeScope)
    assert.equal(seeded.origin.from, await service.canonical(mainScope))
    assert.equal(seeded.origin.dropped, 1)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
