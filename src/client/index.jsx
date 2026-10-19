import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ExperiencePanel } from './panel.jsx'
import './style.css'

const API = '/api/experience-index'
const ENTRY = 'dsh-experience-index'

const CATEGORY_LABEL = {
  rule: '规则',
  runbook: '流程',
  design: '设计',
  analysis: '分析',
  note: '笔记',
  state: '状态',
  log: '日志',
}
const CATEGORY_ORDER = ['rule', 'runbook', 'design', 'analysis', 'note', 'state', 'log']

const formatTime = value => (value ? new Date(value).toLocaleString('zh-CN') : '—')
const formatSize = bytes =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`

const summaryOf = stats => {
  const parts = []
  for (const category of CATEGORY_ORDER) {
    const count = stats?.byCategory?.[category]
    if (count) parts.push(`${CATEGORY_LABEL[category] ?? category} ${count}`)
  }
  return parts.join(' · ') || '无可参考条目'
}

/** The path segment that tells two sibling scopes apart. */
const tailOf = path => {
  if (!path) return ''
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

function Badge({ tone = 'idle', children }) {
  return <span className={`ei-badge ei-badge-${tone}`}>{children}</span>
}

function StatusCell({ scope }) {
  if (!scope) return <Badge tone="warn">未索引</Badge>
  if (scope.state === 'excluded') return <Badge tone="muted">已排除</Badge>
  if (scope.stale) return <Badge tone="warn">索引可能过期</Badge>
  return <Badge tone="ok">已索引</Badge>
}

function Row({ scope, currentRoot, disabled, onAction, expanded, entries, loadingEntries }) {
  const isCurrent = currentRoot !== null && currentRoot === scope.root
  return (
    <>
      <tr className={isCurrent ? 'ei-row-current' : undefined}>
        <td>
          <div className="ei-name">
            {tailOf(scope.root)}
            {isCurrent && <Badge tone="info">当前</Badge>}
            {scope.origin && <Badge tone="info">fork 复制</Badge>}
            {scope.relToRepo ? <Badge tone="muted">{scope.repoRoot ? tailOf(scope.repoRoot) : ''} 仓库内</Badge> : null}
          </div>
          <div className="ei-path" title={scope.root}>{scope.root}</div>
        </td>
        <td><StatusCell scope={scope} /></td>
        <td className="ei-num">{scope.stats.total}</td>
        <td className="ei-summary">{summaryOf(scope.stats)}</td>
        <td className="ei-time">{formatTime(scope.indexedAt)}</td>
        <td className="ei-actions">
          <button type="button" disabled={disabled} onClick={() => onAction('reindex', scope.root)}>重建</button>
          <button type="button" disabled={disabled} onClick={() => onAction('entries', scope.root)}>
            {expanded ? '收起' : '条目'}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAction(scope.state === 'excluded' ? 'include' : 'exclude', scope.root)}
          >
            {scope.state === 'excluded' ? '恢复' : '排除'}
          </button>
          <button type="button" className="ei-danger" disabled={disabled} onClick={() => onAction('forget', scope.root)}>移除</button>
        </td>
      </tr>
      {expanded && (
        <tr className="ei-entries-row">
          <td colSpan={6}>
            {loadingEntries && <p className="ei-hint">正在读取条目…</p>}
            {!loadingEntries && entries.length === 0 && <p className="ei-hint">没有可展开的条目。</p>}
            {!loadingEntries && entries.length > 0 && (
              <ul className="ei-entries">
                {entries.map(entry => (
                  <li key={entry.relpath}>
                    <Badge tone="muted">{CATEGORY_LABEL[entry.category] ?? entry.category}</Badge>
                    <code>{entry.relpath}</code>
                    <span className="ei-entry-title">{entry.title}</span>
                    <span className="ei-entry-meta">{formatSize(entry.size)} · {formatTime(entry.mtimeMs)}</span>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function Index() {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [entries, setEntries] = useState([])
  const [loadingEntries, setLoadingEntries] = useState(false)
  const [draft, setDraft] = useState('')

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${API}/state`)
      if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`)
      setState(await response.json())
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const scopes = state?.scopes ?? []
  const currentRoot = state?.currentRoot ?? null
  const currentScope = useMemo(
    () => scopes.find(scope => scope.root === currentRoot) ?? null,
    [scopes, currentRoot],
  )

  const post = async (path, payload) => {
    const response = await fetch(`${API}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `请求失败（HTTP ${response.status}）`)
    return result
  }

  const onAction = async (action, root) => {
    if (action === 'entries') {
      if (expanded === root) {
        setExpanded(null)
        return
      }
      setExpanded(root)
      setLoadingEntries(true)
      setEntries([])
      try {
        const response = await fetch(`${API}/entries?root=${encodeURIComponent(root)}`)
        if (!response.ok) throw new Error('读取条目失败')
        const payload = await response.json()
        setEntries(payload.items ?? [])
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoadingEntries(false)
      }
      return
    }

    setBusy(action)
    setNotice('')
    try {
      if (action === 'index' || action === 'reindex') {
        await post('index', { root })
        setNotice(action === 'index' ? '已建立索引。' : '已重建索引。')
        setDraft('')
      } else if (action === 'forget') {
        if (!window.confirm('移除索引不会删除磁盘上的文件，继续？')) return
        await post('forget', { root })
        setNotice('已移除该目录的索引。')
      } else {
        await post('exclude', { root, excluded: action === 'exclude' })
        setNotice(action === 'exclude' ? '已排除，后续会话不再提示。' : '已恢复。')
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  const submitDraft = event => {
    event.preventDefault()
    const value = draft.trim()
    if (value === '') return
    void onAction('index', value)
  }

  return (
    <section className="ei-root">
      <header className="ei-head">
        <div>
          <h3>Experience Index</h3>
          <p className="ei-hint">
            把其它 agent 留在目录里的经验文件登记成"路标"，让新会话知道有哪些可参考的文档。
            索引以目录为单位：子项目可以单独索引，不必是整个仓库。正文仍由模型自己读取。
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy !== ''}>刷新</button>
      </header>

      {error !== '' && <div className="ei-alert" role="alert">{error}</div>}
      {notice !== '' && <div className="ei-notice">{notice}</div>}

      <div className="ei-current">
        <div className="ei-current-head">
          <h4>当前目录</h4>
          {currentRoot !== null && <code>{currentRoot}</code>}
        </div>
        {currentRoot === null && <p className="ei-hint">还没有打开过工作区，或工作区注册表不可用。</p>}
        {currentRoot !== null && (
          <div className="ei-current-body">
            <StatusCell scope={currentScope} />
            {currentScope !== null && (
              <span className="ei-hint">
                {currentScope.stats.total} 条 · {summaryOf(currentScope.stats)} · {formatTime(currentScope.indexedAt)}
              </span>
            )}
            <button
              type="button"
              className="ei-primary"
              disabled={busy !== ''}
              onClick={() => void onAction(currentScope === null ? 'index' : 'reindex', currentRoot)}
            >
              {currentScope === null ? '建立索引' : '重建索引'}
            </button>
          </div>
        )}
        <form className="ei-current-body" onSubmit={submitDraft}>
          <span className="ei-hint">或为任意目录建立索引：</span>
          <input
            className="ei-input"
            type="text"
            placeholder="/absolute/path/to/directory"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            disabled={busy !== ''}
          />
          <button type="submit" disabled={busy !== '' || draft.trim() === ''}>索引该目录</button>
        </form>
      </div>

      <div className="ei-table-wrap">
        <table className="ei-table">
          <thead>
            <tr>
              <th>目录</th>
              <th>状态</th>
              <th>条目</th>
              <th>分类</th>
              <th>索引时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {scopes.length === 0 && (
              <tr><td colSpan={6} className="ei-empty">还没有索引任何目录。点"建立索引"开始。</td></tr>
            )}
            {scopes.map(scope => (
              <Row
                key={scope.root}
                scope={scope}
                currentRoot={currentRoot}
                disabled={busy !== ''}
                onAction={(action, root) => void onAction(action, root)}
                expanded={expanded === scope.root}
                entries={expanded === scope.root ? entries : []}
                loadingEntries={expanded === scope.root && loadingEntries}
              />
            ))}
          </tbody>
        </table>
      </div>

      <footer className="ei-foot">
        <span className="ei-hint">
          嵌套目录可以各自索引，会话里只有最深的那个生效。项目级忽略规则写在目录的
          <code>.dsh/experience-ignore</code>，随仓库一起提交。
        </span>
        {busy !== '' && <span className="ei-hint">正在执行 {busy}…</span>}
      </footer>
    </section>
  )
}

function CompassIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="6.1" />
      <path d="M10.3 5.7 8.9 8.9 5.7 10.3 7.1 7.1z" />
    </svg>
  )
}

/** Composer button: one click from the conversation to the summary panel. */
function Trigger() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="ei-trigger"
        title="Experience Index"
        aria-label="Experience Index"
        aria-haspopup="dialog"
        onClick={() => setOpen(value => !value)}
      >
        <CompassIcon />
      </button>
      <ExperiencePanel open={open} onClose={() => setOpen(false)} />
    </>
  )
}

export const inject = ['slots']
export function apply(ctx) {
  // Three entries: the composer button (fastest), the top-level Settings page
  // (full management), and the `/experience` command on the host side.
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'experience-index-trigger',
        order: 50,
      },
      Trigger,
    ),
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'experience-index',
        order: 16,
        label: () => 'Experience Index',
      },
      Index,
    ),
  )
}
export default { name: ENTRY, inject, apply }
