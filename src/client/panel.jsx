/**
 * The compact panel behind the composer button.
 *
 * It reuses the same HTTP surface as the settings page, but stays focused on the
 * two things worth doing without leaving the conversation: seeing the summary and
 * (re)indexing a directory. Destructive operations stay on the settings page.
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

const formatTime = value => (value ? new Date(value).toLocaleDateString('zh-CN') : '—')

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

async function readState() {
  const response = await fetch(`${API}/state`)
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

export function ExperiencePanel({ open, onClose }) {
  const dialog = useRef(null)
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (open && !element.open) element.showModal()
    else if (!open && element.open) element.close()
  }, [open])

  const refresh = useCallback(async () => {
    try {
      setState(await readState())
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const run = async (action, root) => {
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
  const visible = scopes.slice(0, 6)

  return (
    <dialog
      ref={dialog}
      className="ei-dialog"
      onClose={onClose}
      onClick={event => {
        // A click on the backdrop targets the dialog element itself.
        if (event.target === dialog.current) onClose()
      }}
    >
      <div className="ei-dialog-inner">
        <header className="ei-dialog-head">
          <div>
            <h3>Experience Index</h3>
            <p className="ei-hint">
              {scopes.length === 0
                ? '还没有索引任何目录'
                : `${scopes.length} 个目录 · ${totalEntries} 条${staleCount > 0 ? ` · ${staleCount} 个可能过期` : ''}`}
            </p>
          </div>
          <button type="button" className="ei-close" aria-label="关闭" onClick={onClose}>×</button>
        </header>

        {error !== '' && <div className="ei-alert" role="alert">{error}</div>}

        <section className="ei-dialog-current">
          <div className="ei-dialog-label">
            <span>当前目录</span>
            <StatusBadge scope={currentScope} />
          </div>
          <code className="ei-path" title={currentRoot ?? ''}>{currentRoot ?? '未知'}</code>
          {currentScope !== null && (
            <p className="ei-hint">
              {currentScope.stats.total} 条{summaryOf(currentScope.stats) === '' ? '' : ` · ${summaryOf(currentScope.stats)}`}
              {' · '}索引于 {formatTime(currentScope.indexedAt)}
            </p>
          )}
          <button
            type="button"
            className="ei-primary"
            disabled={currentRoot === null || busy !== ''}
            onClick={() => void run('index', currentRoot)}
          >
            {busy === currentRoot ? '索引中…' : currentScope === null ? '建立索引' : '重建索引'}
          </button>
        </section>

        {visible.length > 0 && (
          <section className="ei-dialog-list">
            <div className="ei-dialog-label"><span>已索引目录</span></div>
            <ul>
              {visible.map(scope => (
                <li key={scope.root}>
                  <div className="ei-dialog-row">
                    <span className="ei-dialog-name" title={scope.root}>{tailOf(scope.root)}</span>
                    <StatusBadge scope={scope} />
                    <span className="ei-num">{scope.stats.total}</span>
                    <span className="ei-time">{formatTime(scope.indexedAt)}</span>
                    <button
                      type="button"
                      disabled={busy !== ''}
                      onClick={() => void run('index', scope.root)}
                    >
                      {busy === scope.root ? '…' : '重建'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {scopes.length > visible.length && (
              <p className="ei-hint">还有 {scopes.length - visible.length} 个目录，可在设置页查看。</p>
            )}
          </section>
        )}

        <footer className="ei-dialog-foot">
          完整操作（添加任意目录、排除、移除、查看条目）在 Settings → Experience Index。
        </footer>
      </div>
    </dialog>
  )
}
