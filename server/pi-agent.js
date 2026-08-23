/**
 * Pi RPC process pool.
 *
 * Each logical session key owns its own `pi --mode rpc` child process (the same
 * model AgentDeck uses). Commands arrive as JSON over HTTP, events stream out
 * over Server-Sent Events. One process = one session at a time; `new_session`
 * and `switch_session` rebind the process to a fresh conversation.
 */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

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

function resolvePiExecutable() {
  return process.env.PI_WEB_PI_BIN || 'pi'
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

  async start(cwd) {
    if (this.process) {
      try { return { ok: true, state: await this.getState() } }
      catch (error) { return { ok: false, error: String(error?.message ?? error) } }
    }
    this.setStatus('starting')
    this.stdoutBuffer = ''
    const args = ['--mode', 'rpc', '--approve', '--append-system-prompt', CO_PARTNER_PROMPT]
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
    const state = await this.getState()
    this.setStatus(state.isStreaming ? 'working' : 'ready')
    return { ok: true, state }
  }

  prompt(message) { return this.runCommand({ type: 'prompt', message }) }
  steer(message) { return this.runCommand({ type: 'steer', message }) }
  followUp(message) { return this.runCommand({ type: 'follow_up', message }) }
  abort() { return this.runCommand({ type: 'abort' }) }
  newSession() { return this.runCommand({ type: 'new_session' }) }
  switchSession(sessionPath) { return this.runCommand({ type: 'switch_session', sessionPath }) }
  compact(customInstructions) {
    return this.runCommand({ type: 'compact', ...(customInstructions ? { customInstructions } : {}) })
  }
  setModel(provider, modelId) { return this.runCommand({ type: 'set_model', provider, modelId }) }
  setThinkingLevel(level) { return this.runCommand({ type: 'set_thinking_level', level }) }

  async getState() {
    const response = await this.send({ type: 'get_state' })
    if (response.success === false) throw new Error(response.error ?? 'get_state failed')
    return response.data
  }

  async getCommands() {
    const response = await this.send({ type: 'get_commands' })
    return response.success === false
      ? { ok: false, error: response.error ?? 'failed' }
      : { ok: true, commands: response.data ?? [] }
  }

  async getAvailableModels() {
    const response = await this.send({ type: 'get_available_models' })
    return response.success === false
      ? { ok: false, error: response.error ?? 'failed' }
      : { ok: true, models: response.data ?? [] }
  }

  async getThinkingLevels() {
    const response = await this.send({ type: 'get_available_thinking_levels' })
    return response.success === false
      ? { ok: false, error: response.error ?? 'failed' }
      : { ok: true, levels: response.data ?? [] }
  }

  async runCommand(command) {
    try {
      const response = await this.send(command)
      return response.success === false
        ? { ok: false, error: response.error ?? `${command.type} failed` }
        : { ok: true, data: response.data }
    } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
  }

  send(command) {
    if (!this.process) return Promise.reject(new Error('Pi process is not running'))
    const id = `req-${this.nextRequestId++}`
    const payload = { ...command, id }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) { this.pending.delete(id); reject(error) }
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
    try { event = JSON.parse(line) } catch { return }
    if (event.type === 'response' && event.id && this.pending.has(event.id)) {
      const { resolve } = this.pending.get(event.id)
      this.pending.delete(event.id)
      resolve(event)
      return
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
