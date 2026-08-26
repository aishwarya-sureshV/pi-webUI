import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

const REQUEST_TIMEOUT_MS = 15_000

function resolveCodexExecutable() {
  return process.env.PI_WEB_CODEX_BIN || 'codex'
}

function rpcError(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string') return value.message
    try { return JSON.stringify(value) } catch { /* fall through */ }
  }
  return 'Unknown Codex app-server error'
}

/**
 * Read the signed-in user's Codex rate-limit snapshot through the documented
 * app-server protocol. This starts no thread or model turn and performs no
 * account mutation.
 */
export function readCodexRateLimits() {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCodexExecutable(), ['app-server', '--listen', 'stdio://'], {
      cwd: homedir(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try { child.stdin.end() } catch { /* already closed */ }
      try { child.kill() } catch { /* already exited */ }
      if (error) reject(error)
      else resolve(result)
    }
    const fail = (message) => {
      const details = stderr.trim()
      finish(new Error(details ? `${message}: ${details}` : message))
    }
    const send = (message) => {
      if (settled || child.stdin.destroyed) return
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    const handleMessage = (message) => {
      if (message?.id === 1) {
        if (message.error) {
          fail(`Codex app-server initialization failed: ${rpcError(message.error)}`)
          return
        }
        send({ method: 'initialized', params: {} })
        send({ method: 'account/rateLimits/read', id: 2 })
        return
      }
      if (message?.id === 2) {
        if (message.error) {
          fail(`Codex rate-limit request failed: ${rpcError(message.error)}`)
          return
        }
        finish(undefined, message.result)
      }
    }
    const drainStdout = () => {
      let newline = stdout.indexOf('\n')
      while (newline !== -1) {
        let line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line) {
          try { handleMessage(JSON.parse(line)) } catch { /* ignore non-protocol output */ }
        }
        newline = stdout.indexOf('\n')
      }
    }

    const timeout = setTimeout(() => fail('Codex rate-limit request timed out'), REQUEST_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      drainStdout()
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += chunk.toString('utf8')
    })
    child.stdin.on('error', (error) => {
      if (!settled) fail(`Codex app-server input failed: ${error.message}`)
    })
    child.once('error', (error) => finish(error))
    child.once('exit', (code, signal) => {
      if (!settled) fail(`Codex app-server exited before responding (${signal ?? code ?? 'unknown'})`)
    })
    child.once('spawn', () => send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'pi_web',
          title: 'pi-web',
          version: '0.1.0',
        },
      },
    }))
  })
}
