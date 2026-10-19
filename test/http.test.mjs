import assert from 'node:assert/strict'
import test from 'node:test'

import { workspaceForSession } from '../lib/http.js'

const registry = {
  list: () => [
    { path: '/work/alpha', sessionIds: ['session-a', 'session-b'] },
    { path: '/work/beta', sessionIds: ['session-c'] },
  ],
}

const ctx = { get: name => (name === 'workspaceRegistry' ? registry : undefined) }

test('a session resolves to the workspace that owns it', () => {
  assert.equal(workspaceForSession(ctx, 'session-c'), '/work/beta')
  assert.equal(workspaceForSession(ctx, 'session-b'), '/work/alpha')
})

test('an unknown or missing session resolves to null', () => {
  assert.equal(workspaceForSession(ctx, 'session-missing'), null)
  assert.equal(workspaceForSession(ctx, null), null)
  assert.equal(workspaceForSession(ctx, ''), null)
})

test('an unavailable registry degrades to null instead of throwing', () => {
  assert.equal(workspaceForSession({ get: () => undefined }, 'session-a'), null)
  assert.equal(workspaceForSession({ get: () => ({ list: () => { throw new Error('boom') } }) }, 'session-a'), null)
})
