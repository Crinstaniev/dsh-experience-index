/**
 * The compact panel behind the composer button.
 *
 * It reuses the same HTTP surface as the settings page, but stays focused on the
 * two things worth doing without leaving the conversation: seeing the summary and
 * (re)indexing a directory. Destructive operations stay on the settings page.
 *
 * The panel is session-scoped: the host resolves `sessionId` to the workspace
 * that owns the open conversation, so switching conversations switches the
 * "current directory" instead of pinning the most recently touched one.
 *
 * A native `<dialog>` is used deliberately: it gives a modal backdrop and Escape
 * handling without depending on the host's UI primitives or on the composer's
 * overflow context.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'

const API = '/api/experience-index'

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

const formatDate = value => (value ? new Date(value).toLocaleDateString('zh-CN') : '—')

const tailOf = path => {
  if (!path) return ''
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

const summaryOf = stats => {
  const parts = []
  for (const category of CATEGORY_ORDER) {
    const count = stats?.byCategory?.[category]
    if (count) parts.push(`${CATEGORY_LABEL[category] ?? category} ${count}`)
  }
  return parts.join(' · ')
}

async function readState(sessionId) {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  const response = await fetch(`${API}/state${query}`)
  if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`)
  return response.json()
}

async function postAction(path, payload) {
  const response = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || `请求失败（HTTP ${response.status}）`)
  return result
}

export function StatusBadge({ scope }) {
  if (!scope) return <span className="ei-badge ei-badge-warn">未索引</span>
  if (scope.state === 'excluded') return <span className="ei-badge ei-badge-muted">已排除</span>
  if (scope.stale) return <span className="ei-badge ei-badge-warn">可能过期</span>
  return <span className="ei-badge ei-badge-ok">已索引</span>
}

function Stat({ value, label, tone }) {
  return (
    <div className={`ei-stat${tone ? ` ei-stat--${tone}` : ''}`}>
      <span className="ei-stat-value">{value}</span>
      <span className="ei-stat-label">{label}</span>
    </div>
  )
}

export function ExperiencePanel({ open, onClose, sessionId }) {
  const dialog = useRef(null)
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (open && !element.open) element.showModal()
    else if (!open && element.open) element.close()
  }, [open])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setState(await readState(sessionId))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // Refetch on open and whenever the conversation changes underneath the panel.
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const run = async root => {
    setBusy(root)
    setError('')
    try {
      await postAction('index', { root })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  const scopes = state?.scopes ?? []
  const currentRoot = state?.currentRoot ?? null
  const currentScope = scopes.find(scope => scope.root === currentRoot) ?? null
  const staleCount = scopes.filter(scope => scope.stale).length
  const totalEntries = scopes.reduce((sum, scope) => sum + scope.stats.total, 0)
  const visible = scopes.slice(0, 5)

  return (
    <dialog
      ref={dialog}
      className="ei-panel"
      onClose={onClose}
      onClick={event => {
        // A click on the backdrop targets the dialog element itself.
        if (event.target === dialog.current) onClose()
      }}
    >
      <div className="ei-panel-body">
        <header className="ei-panel-head">
          <span className="ei-panel-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="8" cy="8" r="6.1" />
              <path d="M10.3 5.7 8.9 8.9 5.7 10.3 7.1 7.1z" />
            </svg>
          </span>
          <div className="ei-panel-titles">
            <h3>Experience Index</h3>
            <p>其它 agent 留下的经验文档索引</p>
          </div>
          <button type="button" className="ei-icon-btn" aria-label="关闭" onClick={onClose}>×</button>
        </header>

        {error !== '' && <div className="ei-alert" role="alert">{error}</div>}

        <div className="ei-stats">
          <Stat value={scopes.length} label="已索引目录" />
          <Stat value={totalEntries} label="可参考条目" />
          <Stat value={staleCount} label="可能过期" tone={staleCount > 0 ? 'warn' : undefined} />
        </div>

        <section className="ei-card">
          <div className="ei-row-between">
            <span className="ei-label">当前目录</span>
            <StatusBadge scope={currentScope} />
          </div>
          <div className="ei-path-line" title={currentRoot ?? ''}>
            {currentRoot ?? '未识别当前工作区'}
          </div>
          {currentScope !== null ? (
            <div className="ei-meta">
              {currentScope.stats.total} 条
              {summaryOf(currentScope.stats) === '' ? '' : ` · ${summaryOf(currentScope.stats)}`}
              {' · '}索引于 {formatDate(currentScope.indexedAt)}
            </div>
          ) : (
            <div className="ei-meta">还没有索引这个目录，模型目前看不到它的历史经验。</div>
          )}
          <button
            type="button"
            className="ei-primary ei-block"
            disabled={currentRoot === null || busy !== ''}
            onClick={() => void run(currentRoot)}
          >
            {busy === currentRoot ? '正在索引…' : currentScope === null ? '为当前目录建立索引' : '重建索引'}
          </button>
        </section>

        <section className="ei-card ei-card--plain">
          <div className="ei-row-between">
            <span className="ei-label">已索引目录</span>
            {scopes.length > 0 && <span className="ei-count">{scopes.length}</span>}
          </div>
          {loading && state === null && <p className="ei-hint">读取中…</p>}
          {!loading && scopes.length === 0 && (
            <div className="ei-empty-state">
              <p>还没有索引任何目录。</p>
              <p className="ei-hint">索引后，新会话会在上下文里收到一份"这里有什么"的路标。</p>
            </div>
          )}
          {scopes.length > 0 && (
            <ul className="ei-scope-list">
              {visible.map(scope => (
                <li key={scope.root} className={scope.root === currentRoot ? 'is-current' : undefined}>
                  <div className="ei-scope-main">
                    <div className="ei-scope-name">
                      {tailOf(scope.root)}
                      {scope.root === currentRoot && <span className="ei-dot-current" title="当前目录" />}
                    </div>
                    <div className="ei-scope-meta">
                      {scope.stats.total} 条 · {formatDate(scope.indexedAt)}
                    </div>
                  </div>
                  <StatusBadge scope={scope} />
                  <button
                    type="button"
                    className="ei-ghost"
                    disabled={busy !== ''}
                    onClick={() => void run(scope.root)}
                  >
                    {busy === scope.root ? '…' : '重建'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {scopes.length > visible.length && (
            <p className="ei-hint">还有 {scopes.length - visible.length} 个目录，在设置页查看。</p>
          )}
        </section>

        <footer className="ei-panel-foot">
          添加任意目录、排除、移除、查看条目：Settings → Experience Index
        </footer>
      </div>
    </dialog>
  )
}
