/**
 * `dsh-experience-index` — signposts knowledge left behind by earlier agent
 * sessions, so a new session knows what exists before designing a workflow from
 * scratch.
 *
 * Responsibilities are deliberately narrow:
 * - index a directory on explicit request and store only metadata;
 * - inject one bounded signpost per session (and one rate-limited hint when a
 *   directory with legacy agent directories has no index yet);
 * - expose the same operations to the settings UI over HTTP.
 *
 * It registers no model-facing tools: reading a discovered file is the model's
 * own job with `read`/`grep`/`glob`, which is why the index can stay small and
 * never has to mirror document contents.
 *
 * @module dsh-experience-index
 */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Config as ConfigSchema, resolveConfig } from './config.js'
import { experienceDomain } from './domain.js'
import { defaultDshHome } from './ignore.js'
import { describeScope, ExperienceIndexService, type DomainHandle } from './service.js'
import { registerHttp } from './http.js'

export const name = 'dsh-experience-index'
export const inject = ['storageDomain', 'workingDirectory']
export const Config = ConfigSchema

/** Minimal shape of the pre-step payload this plugin reads. */
interface PreStepPayload {
  agent: { session?: object } & Record<string, unknown>
  messages: unknown[]
  step: number
  signal: AbortSignal
}

interface PreStepDecision {
  kind?: string
  messages: unknown[]
}

type PreStepHandler = (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>

/** Whether the visible batch already carries a signpost or hint from this plugin. */
function hasInjected(messages: readonly unknown[]): boolean {
  for (const message of messages) {
    const source = (message as { source?: { kind?: unknown } } | undefined)?.source
    if (source?.kind === 'experience-index') return true
  }
  return false
}

/**
 * Mount the plugin: open the storage domain, subscribe to the first step of each
 * session, and serve the settings UI.
 */
export async function apply(ctx: Context, config: unknown): Promise<void> {
  const resolved = resolveConfig(config as Parameters<typeof resolveConfig>[0])
  const dshHome = defaultDshHome()

  const domain = (await ctx.storageDomain.open(experienceDomain)) as unknown as DomainHandle
  ctx.effect(() => () => domain.close())
  const service = new ExperienceIndexService({ domain, config: resolved, dshHome })

  /** Sessions already offered context; one signpost per session is the budget. */
  const injectedSessions = new WeakSet<object>()

  const signpostStep: (payload: PreStepPayload, decision: PreStepDecision) => Promise<PreStepDecision> = async (
    payload,
    decision,
  ) => {
    const session = payload.agent.session
    if (session === undefined || session === null) return decision
    if (injectedSessions.has(session)) return decision

    // Resume and replay can present an existing signpost in the entering batch;
    // re-resolving it would duplicate a durable message.
    if (hasInjected(payload.messages) || hasInjected(decision.messages)) {
      injectedSessions.add(session)
      return decision
    }

    let cwd: string
    try {
      cwd = await (
        ctx as unknown as {
          workingDirectory: { ensure: (agent: unknown, signal: AbortSignal) => Promise<string> }
        }
      ).workingDirectory.ensure(payload.agent, payload.signal)
    } catch {
      return decision
    }

    const outcome = await service.resolve(cwd)
    injectedSessions.add(session)
    if (outcome.kind === 'none') return decision

    const message = createUserMessage({
      content: [{ type: 'text', text: outcome.text }],
      // The message-source union is closed inside dsh-llm; plugins contribute
      // their own kinds at runtime, exactly as dsh-agent-instructions does.
      source: {
        kind: 'experience-index',
        form: outcome.kind === 'hint' ? 'hint' : 'signpost',
        scopeRoot: outcome.root,
      } as never,
    })
    return { ...decision, messages: [...decision.messages, message] }
  }

  const handler: PreStepHandler = async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    // A signpost is advisory context: a failure here must never break the turn.
    try {
      return await signpostStep(payload, decision)
    } catch (error) {
      const logger = (ctx as unknown as { logger?: { warn?: (...args: unknown[]) => void } }).logger
      if (logger?.warn !== undefined) logger.warn('experience index signpost failed: %o', error)
      return decision
    }
  }

  ;(ctx.on as unknown as (event: string, listener: PreStepHandler) => void)('agent/pre-step', handler)

  ctx.inject(['connection'], connectionCtx => {
    registerHttp(connectionCtx, service)
  })

  // `/experience [directory]` is the in-chat entry point: index the working
  // directory, or an explicit path, without opening Settings.
  ctx.inject(['commands'], commandCtx => {
    // `commands` reaches the client through a module augmentation this package
    // does not depend on, so the registry is addressed structurally.
    const commands = (commandCtx as unknown as {
      commands: { register: (definition: unknown) => void }
    }).commands
    commands.register({
      name: 'experience',
      description: 'Index experience files left by earlier agent sessions',
      input: { hint: '[directory]' },
      handler: async ({ agent, rawInput, signal }: {
        agent: unknown
        rawInput: string
        signal: AbortSignal
      }) => {
        try {
          const cwd = await (
            ctx as unknown as {
              workingDirectory: { ensure: (agent: unknown, signal: AbortSignal) => Promise<string> }
            }
          ).workingDirectory.ensure(agent, signal)
          const argument = rawInput.trim().split(/\s+/)[0] ?? ''
          const target = argument === '' ? cwd : isAbsolute(argument) ? argument : resolve(cwd, argument)
          const scope = await service.indexDirectory(target)
          return {
            kind: 'success' as const,
            text: `Indexed ${scope.root} — ${describeScope(scope)}. The next session in this directory receives the signpost.`,
          }
        } catch (error) {
          return {
            kind: 'error' as const,
            text: `/experience: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    })
  })
}
