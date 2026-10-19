/**
 * HTTP routes for the settings UI.
 *
 * The host owns every filesystem and storage operation; the browser page only
 * renders state and asks for actions. Routes are namespaced so they cannot
 * collide with the harness or another plugin.
 *
 * @module dsh-experience-index/http
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ExperienceIndexService } from './service.js'

const PREFIX = '/api/experience-index'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function fail(message: string, code: string, status = 400): Response {
  return json({ error: message, code }, status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json()
    if (!isRecord(value)) throw new Error('not an object')
    return value
  } catch {
    throw new Error('Request body must be a JSON object')
  }
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`"${key}" must be a non-empty string`)
  return value
}

/** The most recently updated workspace, used to pre-fill the index form. */
function recentWorkspace(ctx: Context): string | null {
  try {
    const registry = (ctx as unknown as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as
      | { list?: () => Array<{ path?: unknown }> }
      | undefined
    const records = registry?.list?.() ?? []
    const first = records.find(record => typeof record.path === 'string')
    return typeof first?.path === 'string' ? first.path : null
  } catch {
    return null
  }
}

async function dispatch(
  ctx: Context,
  service: ExperienceIndexService,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (url.pathname === `${PREFIX}/state`) {
      const scopes = await service.list()
      const requested = url.searchParams.get('root')
      return json({ scopes, currentRoot: requested ?? recentWorkspace(ctx) })
    }

    if (url.pathname === `${PREFIX}/entries`) {
      const root = url.searchParams.get('root')
      if (root === null) return fail('root is required', 'INVALID_QUERY')
      return json({ items: service.entryList(root) })
    }

    if (url.pathname === `${PREFIX}/entry`) {
      const root = url.searchParams.get('root')
      const path = url.searchParams.get('path')
      if (root === null || path === null) return fail('root and path are required', 'INVALID_QUERY')
      const preview = await service.preview(root, path)
      return json(preview)
    }

    if (request.method !== 'POST') return fail('Method not allowed', 'METHOD_NOT_ALLOWED', 405)
    const input = await body(request)
    const root = stringField(input, 'root')

    if (url.pathname === `${PREFIX}/index`) {
      const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : undefined
      const scope = await service.indexDirectory(root, name)
      return json({ scope })
    }

    if (url.pathname === `${PREFIX}/exclude`) {
      const excluded = input.excluded !== false
      const scope = await service.setExcluded(root, excluded)
      if (scope === undefined) return fail('Directory is not indexed', 'NOT_INDEXED', 404)
      return json({ scope })
    }

    if (url.pathname === `${PREFIX}/forget`) {
      const forgotten = await service.forget(root)
      if (!forgotten) return fail('Directory is not indexed', 'NOT_INDEXED', 404)
      return json({ forgotten })
    }

    return fail('Route not found', 'NOT_FOUND', 404)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed'
    return fail(message, 'REQUEST_FAILED')
  }
}

/** Register the namespaced routes with the host connection service. */
export function registerHttp(ctx: Context, service: ExperienceIndexService): void {
  const routes: ReadonlyArray<readonly [string, ReadonlyArray<'GET' | 'POST'>]> = [
    [`${PREFIX}/state`, ['GET']],
    [`${PREFIX}/entries`, ['GET']],
    [`${PREFIX}/entry`, ['GET']],
    [`${PREFIX}/index`, ['POST']],
    [`${PREFIX}/exclude`, ['POST']],
    [`${PREFIX}/forget`, ['POST']],
  ]
  // `connection` is contributed by @deepseek-ai/dsh-client-connection through a
  // module augmentation this package does not depend on; the structural cast
  // keeps that dependency out of the build.
  const connection = (ctx as unknown as {
    connection: { fetch: { register: (route: Record<string, unknown>) => void } }
  }).connection
  for (const [path, methods] of routes) {
    connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      fetch: (request: Request) => dispatch(ctx, service, request),
    })
  }
}
