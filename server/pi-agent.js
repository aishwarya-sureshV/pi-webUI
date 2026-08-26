/**
 * Pi RPC process pool.
 *
 * Each logical session key owns its own `pi --mode rpc` child process (the same
 * model AgentDeck uses). Commands arrive as JSON over HTTP, events stream out
 * over Server-Sent Events. One process = one session at a time; `new_session`
 * and `switch_session` rebind the process to a fresh conversation.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { readCodexRateLimits } from './codex-usage.js'

const CO_PARTNER_PROMPT = [
  'You are working inside a web workbench as a thinking co-partner.',
  'Keep every reasoning summary minimal: state only what is useful and necessary for the next',
  'output — the decision, the immediate reason, and the expected evidence. Cut all redundancy:',
  'do not restate the user’s request, drop filler and hedging, and never dump a full',
  'chain-of-thought. A few focused lines are enough.',
  'Before a tool call or material action, give a one-line decision-oriented rationale (what, why,',
  'expected evidence). After tools run, briefly note how the evidence changed the conclusion.',
  'Use plain language and stay terse throughout.',
].join(' ')

const PLAN_MODE_PROMPT = [
  'You are in plan mode, a strictly read-only exploration phase.',
  'Inspect the workspace with the available read-only tools, ask concise clarifying questions when needed,',
  'and do not attempt to edit, write, install, or otherwise change files or external state.',
  'Finish with a detailed numbered implementation plan under an exact "Plan:" heading:',
  'Plan:',
  '1. First step description',
  '2. Second step description',
  'Do not execute the plan until the user explicitly chooses Execute plan in the interface.',
].join('\n')

const USAGE_CACHE_TTL_MS = 5 * 60_000

function resolvePiExecutable() {
  return process.env.PI_WEB_PI_BIN || 'pi'
}

function usageWindowLabel(seconds) {
  if (seconds <= 6 * 60 * 60) return 'Current session'
  if (seconds >= 6 * 24 * 60 * 60 && seconds <= 8 * 24 * 60 * 60) return 'Current week'
  const hours = Math.round(seconds / 3600)
  return hours >= 48 ? `${Math.round(hours / 24)} day limit` : `${hours} hour limit`
}

function formatResetTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return undefined
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(epochSeconds * 1000))
}

class PiAgentProcess {
  constructor(sessionKey) {
    this.sessionKey = sessionKey
    this.process = undefined
    this.decoder = new StringDecoder('utf8')
    this.stdoutBuffer = ''
    this.nextRequestId = 1
    this.pending = new Map()
    this.status = 'stopped'
    this.lastState = undefined
    this.usageRequest = undefined
    this.usageCache = { at: 0, result: undefined }
    /** @type {Set<(event: object) => void>} */
    this.listeners = new Set()
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event) {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* listener errors must not kill the pump */ }
    }
  }

  setStatus(status, error) {
    this.status = status
    this.emit({ type: '__status', sessionKey: this.sessionKey, status, ...(error ? { error } : {}) })
  }

  async start(cwd, options = {}) {
    // A bogus cwd surfaces as a confusing 'spawn pi ENOENT' (Node reports the
    // same errno for a missing working directory as for a missing binary).
    // Fall back to $HOME and tell the UI.
    if (cwd && !existsSync(cwd)) {
      this.emit({ type: '__status', sessionKey: this.sessionKey, status: this.status })
      cwd = homedir()
      queueMicrotask(() => this.emit({ type: 'stderr', sessionKey: this.sessionKey,
        message: `cwd not found; opened in ${cwd} instead` }))
    }
    if (this.process) {
      try { return { ok: true, state: await this.getState() } }
      catch (error) { return { ok: false, error: String(error?.message ?? error) } }
    }
    this.setStatus('starting')
    this.stdoutBuffer = ''
    const systemPrompt = options.agentMode === 'plan'
      ? `${CO_PARTNER_PROMPT}\n\n${PLAN_MODE_PROMPT}`
      : CO_PARTNER_PROMPT
    const args = ['--mode', 'rpc', '--approve', '--append-system-prompt', systemPrompt]
    if (options.accessMode === 'read-only' || options.agentMode === 'plan') {
      args.push('--tools', 'read,grep,find,ls')
    }
    if (options.sessionPath) args.push('--session', options.sessionPath)
    if (options.model?.provider && options.model?.id) args.push('--provider', options.model.provider, '--model', options.model.id)
    if (options.thinkingLevel) args.push('--thinking', options.thinkingLevel)
    const child = spawn(resolvePiExecutable(), args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = child
    child.stdout.on('data', (chunk) => this.readStdout(chunk))
    child.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim()
      if (message) this.emit({ type: 'stderr', sessionKey: this.sessionKey, message })
    })
    child.once('error', (error) => {
      this.failPending(error)
      this.process = undefined
      this.setStatus('error', error.message)
    })
    child.once('exit', (code, signal) => {
      this.flushStdout()
      this.failPending(new Error(`Pi exited (${signal ?? code ?? 'unknown'})`))
      this.process = undefined
      if (this.status !== 'stopped') {
        const err = code && code !== 0 ? `Pi exited with code ${code}` : undefined
        this.setStatus(err ? 'error' : 'stopped', err)
      }
    })
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    let state
    try {
      state = await this.getState(15_000)
    } catch (error) {
      this.stop()
      throw new Error(`Pi did not finish starting within 15 seconds: ${String(error?.message ?? error)}`)
    }
    this.setStatus(state.isStreaming ? 'working' : 'ready')
    return { ok: true, state }
  }

  prompt(message, images) { return this.runCommand({ type: 'prompt', message, ...(images?.length ? { images } : {}) }) }
  steer(message, images) { return this.runCommand({ type: 'steer', message, ...(images?.length ? { images } : {}) }) }
  followUp(message, images) { return this.runCommand({ type: 'follow_up', message, ...(images?.length ? { images } : {}) }) }
  abort() { return this.runCommand({ type: 'abort' }) }
  newSession() { return this.runSessionCommand({ type: 'new_session' }) }
  async switchSession(sessionPath) {
    const result = await this.runSessionCommand({ type: 'switch_session', sessionPath }, 20_000)
    if (result.ok) this.usageCache = { at: 0, result: undefined }
    if (!result.ok || !result.state?.isStreaming) return result

    // A persisted session can contain an interrupted turn from another Pi
    // process. Never let that stale flag turn a read-only resume into a live
    // run in the web UI.
    await this.abort()
    this.setStatus('ready')
    try {
      const [state, messages] = await Promise.all([this.getState(10_000), this.getMessages(10_000)])
      return { ...result, state: { ...state, isStreaming: false }, messages }
    } catch {
      return { ...result, state: { ...result.state, isStreaming: false } }
    }
  }
  compact(customInstructions) {
    return this.runCommand({ type: 'compact', ...(customInstructions ? { customInstructions } : {}) })
  }
  async setModel(provider, modelId) {
    const result = await this.runCommand({ type: 'set_model', provider, modelId })
    if (!result.ok) return result
    this.usageCache = { at: 0, result: undefined }
    try {
      return { ok: true, data: result.data, state: await this.getState() }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
  setThinkingLevel(level) { return this.runCommand({ type: 'set_thinking_level', level }) }

  async getState(timeoutMs) {
    const response = await this.send({ type: 'get_state' }, timeoutMs)
    if (response.success === false) throw new Error(response.error ?? 'get_state failed')
    this.lastState = response.data
    return this.lastState
  }

  async getMessages(timeoutMs) {
    const response = await this.send({ type: 'get_messages' }, timeoutMs)
    if (response.success === false) throw new Error(response.error ?? 'get_messages failed')
    const data = response.data
    return Array.isArray(data) ? data : (data?.messages ?? [])
  }

  async getEntries() {
    const response = await this.send({ type: 'get_entries' })
    if (response.success === false) throw new Error(response.error ?? 'get_entries failed')
    const data = response.data
    return Array.isArray(data) ? data : (data?.entries ?? [])
  }

  async forkAt(timestamp) {
    const entries = await this.getEntries()
    const assistantEntries = entries.filter((entry) =>
      entry?.type === 'message' && entry?.message?.role === 'assistant' && entry?.id,
    )
    if (assistantEntries.length === 0) return { ok: false, error: 'No assistant response is available to fork.' }
    const requested = Number(timestamp)
    const entry = Number.isFinite(requested)
      ? assistantEntries.reduce((closest, candidate) => {
          const closestTime = Number(closest?.message?.timestamp ?? Date.parse(closest?.timestamp ?? ''))
          const candidateTime = Number(candidate?.message?.timestamp ?? Date.parse(candidate?.timestamp ?? ''))
          return Math.abs(candidateTime - requested) < Math.abs(closestTime - requested) ? candidate : closest
        })
      : assistantEntries.at(-1)
    const entryIndex = entries.findIndex((candidate) => candidate?.id === entry?.id)
    const nextUser = entries.slice(entryIndex + 1).find((candidate) =>
      candidate?.type === 'message' && candidate?.message?.role === 'user' && candidate?.id,
    )
    return nextUser
      ? this.runSessionCommand({ type: 'fork', entryId: nextUser.id })
      : this.runSessionCommand({ type: 'clone' })
  }

  async runSessionCommand(command, timeoutMs) {
    const result = await this.runCommand(command, timeoutMs)
    if (!result.ok) return result
    try {
      const [state, messages] = await Promise.all([this.getState(timeoutMs), this.getMessages(timeoutMs)])
      return { ok: true, state, messages, data: result.data }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  // pi answers these with envelopes like { models: [...] } — unwrap to arrays.
  async getCommands() {
    const response = await this.send({ type: 'get_commands' })
    if (response.success === false) return { ok: false, error: response.error ?? 'failed' }
    const data = response.data
    return { ok: true, commands: Array.isArray(data) ? data : (data?.commands ?? []) }
  }

  async getAvailableModels() {
    const response = await this.send({ type: 'get_available_models' })
    if (response.success === false) return { ok: false, error: response.error ?? 'failed' }
    const data = response.data
    return { ok: true, models: Array.isArray(data) ? data : (data?.models ?? []) }
  }

  async getThinkingLevels() {
    const response = await this.send({ type: 'get_available_thinking_levels' })
    if (response.success === false) return { ok: false, error: response.error ?? 'failed' }
    const data = response.data
    return { ok: true, levels: Array.isArray(data) ? data : (data?.levels ?? []) }
  }

  async getUsage(force = false) {
    const now = Date.now()
    if (!force && this.usageCache.result && now - this.usageCache.at < USAGE_CACHE_TTL_MS) {
      return this.usageCache.result
    }
    if (this.usageRequest) return this.usageRequest
    this.usageRequest = this.loadUsage()
      .then((result) => {
        if (result?.ok) this.usageCache = { at: Date.now(), result }
        return result
      })
      .finally(() => { this.usageRequest = undefined })
    return this.usageRequest
  }

  async loadUsage() {
    let state = this.lastState
    try { state ??= await this.getState(5_000) }
    catch (error) { return { ok: false, error: String(error?.message ?? error) } }
    const identity = `${state?.model?.provider ?? ''}/${state?.model?.id ?? ''}`.toLowerCase()
    if (identity.includes('grok')) return this.loadGrokUsage()
    if (identity.includes('openai-codex')) return this.loadCodexUsage(state?.model?.id)
    if (identity.includes('ollama')) return this.loadOllamaUsage()
    return { ok: true, usage: { available: false, provider: state?.model?.provider ?? 'Provider', windows: [] } }
  }

  async loadGrokUsage() {
    try {
      const grokHome = process.env.GROK_HOME || join(homedir(), '.grok')
      const auth = JSON.parse(await readFile(join(grokHome, 'auth.json'), 'utf8'))
      const token = auth?.['https://accounts.x.ai/sign-in']?.key
        ?? Object.values(auth ?? {}).find((entry) => typeof entry?.key === 'string')?.key
      if (typeof token !== 'string' || token.length === 0) {
        return { ok: true, usage: { available: false, provider: 'Grok', windows: [] } }
      }

      const response = await fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'grok-cli',
          'x-xai-token-auth': 'xai-grok-cli',
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Grok usage returned ${response.status}`)
      const payload = await response.json()
      const config = payload?.config ?? payload
      const usedPercent = Number(config?.creditUsagePercent)
      const resetAt = Date.parse(String(config?.currentPeriod?.end ?? config?.billingPeriodEnd ?? '')) / 1000
      const resetsAt = formatResetTime(resetAt)
      const windows = Number.isFinite(usedPercent)
        ? [{ label: 'Current week', usedPercent, ...(resetsAt ? { resetsAt } : {}) }]
        : []
      return {
        ok: true,
        usage: {
          available: windows.length > 0,
          provider: 'Grok',
          windows,
          updatedAt: new Date().toISOString(),
        },
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async loadCodexUsage(modelId) {
    try {
      const payload = await readCodexRateLimits()
      const normalizedModel = String(modelId ?? '').toLowerCase()
      const rateLimits = Object.values(payload?.rateLimitsByLimitId ?? {}).filter(Boolean)
      const selected = normalizedModel.includes('spark')
        ? rateLimits.find((entry) => `${entry?.limitId ?? ''} ${entry?.limitName ?? ''}`.toLowerCase().includes('spark'))
        : rateLimits.find((entry) => String(entry?.limitId ?? '').toLowerCase() === 'codex')
      const limits = selected ?? payload?.rateLimits ?? rateLimits[0]
      const windows = [limits?.primary, limits?.secondary].filter(Boolean).map((window) => ({
        label: usageWindowLabel(Number(window.windowDurationMins ?? 0) * 60),
        usedPercent: Number(window.usedPercent ?? 0),
        ...(formatResetTime(Number(window.resetsAt)) ? { resetsAt: formatResetTime(Number(window.resetsAt)) } : {}),
      }))
      return {
        ok: true,
        usage: {
          available: windows.length > 0,
          provider: 'Codex',
          plan: String(limits?.planType ?? '').replace(/(^|_)(\w)/g, (_match, _prefix, letter) => ` ${letter.toUpperCase()}`).trim() || undefined,
          windows,
          updatedAt: new Date().toISOString(),
        },
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async loadOllamaUsage() {
    try {
      const messages = await this.getMessages()
      const tokens = messages.reduce((total, message) => {
        if (message?.role !== 'assistant' || !message.usage) return total
        const input = Number(message.usage.input ?? 0)
        const output = Number(message.usage.output ?? 0)
        const combined = Number(message.usage.totalTokens ?? input + output)
        return { input: total.input + input, output: total.output + output, total: total.total + combined }
      }, { input: 0, output: 0, total: 0 })
      return {
        ok: true,
        usage: {
          available: tokens.total > 0,
          provider: 'Ollama',
          windows: [],
          ...(tokens.total > 0 ? { tokens } : {}),
          updatedAt: new Date().toISOString(),
        },
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async runCommand(command, timeoutMs) {
    try {
      const response = await this.send(command, timeoutMs)
      return response.success === false
        ? { ok: false, error: response.error ?? `${command.type} failed` }
        : { ok: true, data: response.data }
    } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
  }

  send(command, timeoutMs) {
    if (!this.process) return Promise.reject(new Error('Pi process is not running'))
    const id = `req-${this.nextRequestId++}`
    const payload = { ...command, id }
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`${command.type} timed out`))
          }, timeoutMs)
        : undefined
      this.pending.set(id, {
        resolve: (value) => {
          if (timeout) clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout)
          reject(error)
        },
      })
      this.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.pending.delete(id)
          if (timeout) clearTimeout(timeout)
          reject(error)
        }
      })
    })
  }

  readStdout(chunk) {
    this.stdoutBuffer += this.decoder.write(chunk)
    this.drainStdout()
  }

  flushStdout() {
    this.stdoutBuffer += this.decoder.end()
    this.drainStdout()
    this.stdoutBuffer = ''
  }

  drainStdout() {
    let index = this.stdoutBuffer.indexOf('\n')
    while (index !== -1) {
      let line = this.stdoutBuffer.slice(0, index)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line) this.handleLine(line)
      index = this.stdoutBuffer.indexOf('\n')
    }
  }

  handleLine(line) {
    let event
    try { event = JSON.parse(line) } catch {
      this.emit({ type: 'pi_raw_line', sessionKey: this.sessionKey, raw: line })
      return
    }
    if (event.type === 'response' && event.id && this.pending.has(event.id)) {
      const { resolve } = this.pending.get(event.id)
      this.pending.delete(event.id)
      resolve(event)
      // Responses are part of the RPC lifecycle too. Keep them on the shared
      // event stream so the backend log can show the command boundary and its
      // raw acknowledgement, not only the agent's streamed events.
      this.emit({ ...event, sessionKey: this.sessionKey })
      return
    }
    if (event.type === 'agent_start') this.setStatus('working')
    if (event.type === 'agent_settled') {
      this.setStatus('ready')
      void this.getState()
        .then((state) => this.emit({ type: 'state', sessionKey: this.sessionKey, state }))
        .catch(() => {})
    }
    this.emit({ ...event, sessionKey: this.sessionKey })
  }

  failPending(error) {
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }

  stop() {
    this.status = 'stopped'
    if (this.process) {
      this.process.kill()
      this.process = undefined
    }
    this.failPending(new Error('Pi process stopped'))
    this.emit({ type: '__status', sessionKey: this.sessionKey, status: 'stopped' })
  }
}

export class PiAgentPool {
  constructor() {
    /** @type {Map<string, PiAgentProcess>} */
    this.agents = new Map()
  }

  get(sessionKey) {
    let agent = this.agents.get(sessionKey)
    if (!agent) { agent = new PiAgentProcess(sessionKey); this.agents.set(sessionKey, agent) }
    return agent
  }

  stop(sessionKey) {
    if (sessionKey) { this.agents.get(sessionKey)?.stop(); this.agents.delete(sessionKey); return }
    for (const agent of this.agents.values()) agent.stop()
    this.agents.clear()
  }
}
