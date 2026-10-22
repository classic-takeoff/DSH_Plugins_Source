// Host half of the Windows native notification bridge.
//
// Responsibilities:
//   * observe completed root-Agent turns and derive a title/summary;
//   * show a real Windows toast through show-toast.ps1 (WinRT, not HTML);
//   * keep opaque token -> session mappings and a loopback activation server;
//   * deliver a toast reply through ctx.sessionController.prompt(), the same
//     admission path the Web client uses;
//   * hand "open session" activations to the Client half;
//   * consume activations spooled while the Host was not running.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const SOURCE_HELPER = join(PLUGIN_DIR, 'dsh-toast.exe')
const SOURCE_SHOW_SCRIPT = join(PLUGIN_DIR, 'show-toast.ps1')
const SOURCE_ICON = join(PLUGIN_DIR, '..', 'icon.png')
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const AUMID = 'com.deepseek.dsh.notify'
const BASE_PATH = '/dsh-desktop-notify'
const STATE_VERSION = 1
const TURN_SCAN_LIMIT = 800
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const OPEN_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_OPENS = 8
const MAX_TOKENS = 500
const MAX_HANDLED = 1000

const DEFAULTS = {
  enabled: true,
  notifyWhenFocused: false,
  sound: true,
  soundEffect: 'default',
  summaryChars: 180,
}

// Toast audio accepts the same ms-winsoundevent names Windows uses for its own
// per-app notification sounds. `default` leaves the toast silent attribute
// unset so Windows plays the configured system notification sound; `none`
// mutes the toast.
const SOUND_EFFECTS = new Set(['default', 'none', 'im', 'mail', 'reminder', 'sms', 'generic'])

function resolveSoundEffect(options) {
  if (options.sound === false) return 'none'
  const raw = typeof options.sound === 'string' ? options.sound : options.soundEffect
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : 'default'
  return SOUND_EFFECTS.has(value) ? value : 'default'
}

export const inject = ['sessions', 'sessionController', 'webServer']

const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
const DATA_DIR = join(localAppData, 'DeepSeekHarness', 'desktop-notify')
const RUNTIME_DIR = join(DATA_DIR, 'bin')
const STATE_PATH = join(DATA_DIR, 'state.json')
const BRIDGE_PATH = join(DATA_DIR, 'bridge.ini')
const PENDING_DIR = join(DATA_DIR, 'pending')

// The plugin may live in a sandboxed checkout (for example the DSH workspace),
// where executing files from that tree yields a Low-integrity child and blocks
// HKCU writes. Deploying the two runtime files under LOCALAPPDATA keeps the
// helper and PowerShell at the Host's own integrity level.
let helperPath = join(RUNTIME_DIR, 'dsh-toast.exe')
let showScriptPath = join(RUNTIME_DIR, 'show-toast.ps1')

const APP_PATH = process.execPath
const APP_NAME = basename(APP_PATH).toLowerCase()
let iconPath = existsSync(join(dirname(APP_PATH), 'resources', 'icon.png'))
  ? join(dirname(APP_PATH), 'resources', 'icon.png')
  : join(RUNTIME_DIR, 'icon.png')
const SHORTCUT_PATH = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness', 'Notifications.lnk',
)

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false
  try {
    return timingSafeEqual(Buffer.from(left), Buffer.from(right))
  } catch {
    return false
  }
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function lastJsonLine(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/u)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      // keep looking for a complete line
    }
  }
  return undefined
}

function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/gu, ' [代码] ')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/[*_~>]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function clamp(text, limit) {
  const value = String(text ?? '').trim()
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function apply(ctx, config) {
  if (process.platform !== 'win32') return
  if (!APP_NAME.includes('deepseek harness') && APP_NAME !== 'electron.exe') return

  const options = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  if (options.enabled === false) return

  const soundEffect = resolveSoundEffect(options)

  const logger = typeof ctx.logger === 'function' ? ctx.logger('windows-notify') : console
  const web = ctx.webServer
  const routeKey = randomBytes(24).toString('base64url')
  const bridgeSecret = randomBytes(32).toString('hex')

  const state = {
    tokens: new Map(),
    pendingOpens: [],
    handledReplies: new Set(),
  }

  let presence = { focused: false, visible: false, at: 0 }
  let registration = { ok: false, error: 'not started' }
  let setting = ''
  let lastDelivery = null
  let lastDisabledLog = 0
  let closed = false
  let bridgeServer
  let bridgePort = 0
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  let readyResolved = false
  let saveChain = Promise.resolve()
  let spoolBusy = false
  const timers = new Set()
  const children = new Set()
  const routeDisposers = []
  const inflightReplies = new Set()
  const handledTurns = new Set()
  const agentRunning = new Set()

  function logWarn(message) {
    try { logger.warn(message) } catch { /* logging must not break notifications */ }
  }

  function logInfo(message) {
    try { logger.info(message) } catch { /* logging must not break notifications */ }
  }

  function finishReady(value) {
    if (readyResolved) return
    readyResolved = true
    readyResolve(value)
  }

  function rememberTimer(timer) {
    timers.add(timer)
    return timer
  }

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  function runProcess(file, args, timeoutMs) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(file, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) })
        return
      }

      children.add(child)
      let stdout = ''
      let stderr = ''
      let settled = false
      let timer
      const finish = (code, out, err) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        children.delete(child)
        resolve({ code, stdout: out, stderr: err })
      }
      timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        finish(-1, stdout, `${stderr}\nprocess timed out`)
      }, timeoutMs)
      timer.unref?.()

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(-64 * 1024)
      })
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-64 * 1024)
      })
      child.once('error', (error) => finish(-1, stdout, error.message))
      child.once('close', (code) => finish(code ?? -1, stdout, stderr))
    })
  }

  function runPowerShell(extraArgs, timeoutMs) {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', showScriptPath,
      ...extraArgs,
    ]
    return runProcess(POWERSHELL, args, timeoutMs).then((result) => {
      const parsed = lastJsonLine(result.stdout)
      return {
        ok: parsed?.ok === true,
        setting: typeof parsed?.setting === 'string' ? parsed.setting : '',
        error: typeof parsed?.error === 'string' && parsed.error.length > 0
          ? parsed.error
          : result.stderr.trim(),
        code: result.code,
      }
    })
  }

  async function atomicWrite(path, text) {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, text, { encoding: 'utf8' })
    await rename(temporary, path)
  }

  async function loadState() {
    try {
      const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.version === STATE_VERSION) {
        if (parsed.tokens && typeof parsed.tokens === 'object') {
          for (const [token, info] of Object.entries(parsed.tokens)) {
            if (typeof token !== 'string' || token.length < 16 || token.length > 128) continue
            if (!info || typeof info !== 'object' || typeof info.sessionId !== 'string') continue
            const at = Number(info.at)
            if (!Number.isFinite(at)) continue
            state.tokens.set(token, { sessionId: info.sessionId, at })
          }
        }
        if (Array.isArray(parsed.pendingOpens)) {
          for (const entry of parsed.pendingOpens.slice(-MAX_PENDING_OPENS)) {
            if (!entry || typeof entry.token !== 'string' || typeof entry.sessionId !== 'string') continue
            state.pendingOpens.push({
              token: entry.token,
              sessionId: entry.sessionId,
              at: Number(entry.at) || Date.now(),
            })
          }
        }
        if (Array.isArray(parsed.handledReplies)) {
          for (const token of parsed.handledReplies) {
            if (typeof token === 'string') state.handledReplies.add(token)
          }
        }
      }
    } catch {
      // First run or an unreadable file: start from empty state.
    }
    pruneState()
  }

  function pruneState() {
    const now = Date.now()
    for (const [token, info] of state.tokens) {
      if (!info || now - info.at > TOKEN_TTL_MS) state.tokens.delete(token)
    }
    if (state.tokens.size > MAX_TOKENS) {
      const oldest = [...state.tokens.entries()].sort((a, b) => a[1].at - b[1].at)
      for (const [token] of oldest.slice(0, state.tokens.size - MAX_TOKENS)) state.tokens.delete(token)
    }
    state.pendingOpens = state.pendingOpens.filter((entry) => now - entry.at < OPEN_TTL_MS).slice(-MAX_PENDING_OPENS)
    if (state.handledReplies.size > MAX_HANDLED) {
      const values = [...state.handledReplies]
      state.handledReplies = new Set(values.slice(-MAX_HANDLED))
    }
  }

  function saveState() {
    const snapshot = {
      version: STATE_VERSION,
      tokens: Object.fromEntries(state.tokens),
      pendingOpens: state.pendingOpens,
      handledReplies: [...state.handledReplies].slice(-MAX_HANDLED),
    }
    saveChain = saveChain
      .then(() => atomicWrite(STATE_PATH, JSON.stringify(snapshot)))
      .catch((error) => logWarn(`state save failed: ${error instanceof Error ? error.message : String(error)}`))
    return saveChain
  }

  async function writeBridgeFile() {
    const content = [
      '# Generated by dsh-windows-notify. Contains a per-process loopback secret.',
      `port=${bridgePort}`,
      `secret=${bridgeSecret}`,
      `app=${APP_PATH}`,
      `aumid=${AUMID}`,
      '',
    ].join('\n')
    await atomicWrite(BRIDGE_PATH, content)
  }

  async function startBridge() {
    bridgeServer = createServer((req, res) => {
      handleBridge(req, res).catch((error) => {
        try { json(res, 500, { ok: false, error: 'internal' }) } catch { /* headers may be sent */ }
        logWarn(`bridge handler failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    await new Promise((resolve, reject) => {
      bridgeServer.once('error', reject)
      bridgeServer.listen(0, '127.0.0.1', () => {
        bridgeServer.off('error', reject)
        resolve()
      })
    })
    bridgePort = bridgeServer.address().port
    await writeBridgeFile()
  }

  function isAuthorizedBridge(req) {
    return sameSecret(req.headers['x-dsh-notify-secret'], bridgeSecret)
  }

  async function handleBridge(req, res) {
    if (closed) return json(res, 503, { ok: false, error: 'shutting down' })
    if (!isAuthorizedBridge(req)) return json(res, 401, { ok: false, error: 'unauthorized' })

    if (req.method === 'GET' && req.url === '/status') {
      return json(res, 200, {
        aumid: AUMID,
        appPath: APP_PATH,
        iconPath,
        helper: helperPath,
        showScript: showScriptPath,
        shortcut: SHORTCUT_PATH,
        registration,
        setting,
        lastDelivery,
        pendingOpens: state.pendingOpens.length,
        presence,
      })
    }

    if (req.method !== 'POST' || req.url !== '/activate') return json(res, 404, { ok: false, error: 'not found' })

    const body = await readBody(req)
    const params = new URLSearchParams(body)
    const token = params.get('token') ?? ''
    const action = params.get('action') ?? ''
    const text = params.get('text') ?? ''

    if (!state.tokens.has(token)) {
      if (state.handledReplies.has(token) || inflightReplies.has(token)) {
        return json(res, 409, { ok: true, duplicate: true })
      }
      return json(res, 410, { ok: false, error: 'unknown-token' })
    }

    if (action === 'open') {
      const info = state.tokens.get(token)
      addPendingOpen(token, info.sessionId)
      return json(res, 200, { ok: true })
    }

    if (action === 'reply') {
      const value = text.trim()
      if (value.length === 0) return json(res, 400, { ok: false, error: 'empty-reply' })
      if (value.length > 4000) return json(res, 400, { ok: false, error: 'reply-too-long' })
      const result = await deliverReply(token, value)
      if (result.ok) return json(res, 200, { ok: true, duplicate: result.duplicate === true })
      if (result.duplicate) return json(res, 409, { ok: true, duplicate: true })
      return json(res, 500, { ok: false, error: result.error ?? 'send-failed' })
    }

    return json(res, 400, { ok: false, error: 'unknown-action' })
  }

  function addPendingOpen(token, sessionId) {
    if (!state.tokens.has(token)) return false
    const existing = state.pendingOpens.find((entry) => entry.token === token)
    if (existing) {
      existing.at = Date.now()
      return true
    }
    state.pendingOpens.push({ token, sessionId, at: Date.now() })
    state.pendingOpens = state.pendingOpens.slice(-MAX_PENDING_OPENS)
    saveState()
    return true
  }

  async function deliverReply(token, text) {
    const info = state.tokens.get(token)
    if (!info) return { ok: false, error: 'unknown-token' }
    if (state.handledReplies.has(token)) return { ok: true, duplicate: true }
    if (inflightReplies.has(token)) return { ok: false, duplicate: true, error: 'in-flight' }

    inflightReplies.add(token)
    try {
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: info.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, AbortSignal.timeout(60_000))
      state.handledReplies.add(token)
      state.tokens.delete(token)
      state.pendingOpens = state.pendingOpens.filter((entry) => entry.token !== token)
      saveState()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logWarn(`reply delivery failed: ${message}`)
      return { ok: false, error: message }
    } finally {
      inflightReplies.delete(token)
    }
  }

  function authorizedClient(req, url) {
    return sameSecret(req.headers['x-dsh-notify-key'], routeKey) ||
      sameSecret(url.searchParams.get('key'), routeKey)
  }

  function setupRoutes() {
    if (!web) return

    const pending = web.register({
      kind: 'exact',
      path: `${BASE_PATH}/pending`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method' })
        if (!authorizedClient(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' })
        pruneState()
        return json(res, 200, {
          opens: state.pendingOpens.map((entry) => ({
            token: entry.token,
            sessionId: entry.sessionId,
            at: entry.at,
          })),
        })
      },
    })
    routeDisposers.push(pending)

    const ack = web.register({
      kind: 'exact',
      path: `${BASE_PATH}/ack`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        if (!authorizedClient(req, new URL(req.url ?? '/', 'http://127.0.0.1'))) {
          return json(res, 401, { ok: false, error: 'unauthorized' })
        }
        let body
        try {
          body = JSON.parse(await readBody(req, 8 * 1024))
        } catch {
          return json(res, 400, { ok: false, error: 'invalid-json' })
        }
        const tokens = Array.isArray(body?.tokens)
          ? body.tokens.filter((token) => typeof token === 'string')
          : []
        if (tokens.length === 0) return json(res, 200, { ok: true })
        const remove = new Set(tokens)
        const before = state.pendingOpens.length
        state.pendingOpens = state.pendingOpens.filter((entry) => !remove.has(entry.token))
        if (state.pendingOpens.length !== before) saveState()
        return json(res, 200, { ok: true })
      },
    })
    routeDisposers.push(ack)

    const presenceRoute = web.register({
      kind: 'exact',
      path: `${BASE_PATH}/presence`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        if (!authorizedClient(req, new URL(req.url ?? '/', 'http://127.0.0.1'))) {
          return json(res, 401, { ok: false, error: 'unauthorized' })
        }
        let body
        try {
          body = JSON.parse(await readBody(req, 4 * 1024))
        } catch {
          return json(res, 400, { ok: false, error: 'invalid-json' })
        }
        const focused = body?.focused === true
        const visible = body?.visible === true
        presence = { focused, visible, at: Date.now() }
        return json(res, 200, { ok: true })
      },
    })
    routeDisposers.push(presenceRoute)

    const statusRoute = web.register({
      kind: 'exact',
      path: `${BASE_PATH}/status`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method' })
        if (!authorizedClient(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' })
        return json(res, 200, {
          aumid: AUMID,
          registration,
          setting,
          lastDelivery,
          pendingOpens: state.pendingOpens.length,
          presence,
        })
      },
    })
    routeDisposers.push(statusRoute)

    ctx.on('webserver/index-inject', (rows) => {
      rows.push({
        kind: 'global',
        name: '__DSH_DESKTOP_NOTIFY__',
        value: { path: BASE_PATH, key: routeKey, aumid: AUMID },
      })
    })
  }

  async function deployRuntime() {
    await mkdir(RUNTIME_DIR, { recursive: true })
    const pairs = [
      [SOURCE_HELPER, helperPath],
      [SOURCE_SHOW_SCRIPT, showScriptPath],
    ]
    for (const [source, target] of pairs) {
      if (!existsSync(source)) continue
      try {
        const sourceInfo = await stat(source)
        const targetInfo = await stat(target).catch(() => undefined)
        if (targetInfo && targetInfo.size === sourceInfo.size && targetInfo.mtimeMs >= sourceInfo.mtimeMs) continue
        const temporary = `${target}.${process.pid}.tmp`
        await copyFile(source, temporary)
        await rename(temporary, target)
      } catch (error) {
        logWarn(`runtime deploy failed for ${basename(target)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!existsSync(iconPath) && existsSync(SOURCE_ICON)) {
      try {
        await copyFile(SOURCE_ICON, iconPath)
      } catch {
        // The app icon is preferred; this is only a development fallback.
      }
    }
  }

  async function ensureRegistration() {
    if (!existsSync(helperPath)) {
      return { ok: false, error: `activation helper missing: ${helperPath}` }
    }
    const result = await runProcess(helperPath, [
      '--register', AUMID, iconPath, APP_PATH, SHORTCUT_PATH,
    ], 30000)
    const parsed = lastJsonLine(result.stdout)
    if (result.code === 0 && parsed?.ok === true) return { ok: true, clsid: parsed.clsid }
    return {
      ok: false,
      error: parsed?.error || result.stderr.trim() || `activation helper exited with ${result.code}`,
    }
  }

  async function writeDiagnostics() {
    try {
      await atomicWrite(join(DATA_DIR, 'diagnostics.json'), JSON.stringify({
        at: new Date().toISOString(),
        appPath: APP_PATH,
        iconPath,
        helper: helperPath,
        showScript: showScriptPath,
        shortcut: SHORTCUT_PATH,
        helperExists: existsSync(helperPath),
        iconExists: existsSync(iconPath),
        shortcutExists: existsSync(SHORTCUT_PATH),
        registration,
        setting,
        lastDelivery,
      }, null, 2))
    } catch {
      // diagnostics are best effort
    }
  }

  async function probeSetting() {
    const result = await runPowerShell(['-Payload', join(DATA_DIR, 'probe.json'), '-Probe'], 20000)
    if (result.setting) setting = result.setting
    return result
  }

  function shouldNotify() {
    if (options.notifyWhenFocused === true) return true
    if (presence.at === 0 || Date.now() - presence.at > 10_000) return true
    return !(presence.focused && presence.visible)
  }

  function findTurn(session) {
    let events
    try {
      events = session.snapshotEvents()
    } catch {
      return undefined
    }
    if (!Array.isArray(events) || events.length === 0) return undefined
    const recent = events.slice(-TURN_SCAN_LIMIT)

    let endIndex = -1
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      if (recent[index]?.type === 'turn/end') {
        endIndex = index
        break
      }
    }
    if (endIndex < 0) return undefined

    const end = recent[endIndex]
    const turn = Number(end?.data?.turn)
    const reason = end?.data?.reason?.kind
    if (!Number.isFinite(turn)) return undefined
    if (reason !== 'completed' && reason !== 'max-tokens') return undefined

    // A new turn already started: the completion is stale.
    for (let index = endIndex + 1; index < recent.length; index += 1) {
      if (recent[index]?.type === 'turn/start') return undefined
    }

    let text = ''
    for (let index = endIndex - 1; index >= 0; index -= 1) {
      const event = recent[index]
      if (!event) continue
      if (event.type === 'turn/start') break
      if (event.type !== 'assistant/message') continue
      if (Number(event?.data?.turn) !== turn) continue
      const content = event?.data?.message?.content
      if (!Array.isArray(content)) continue
      text = content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text.trim().length > 0) break
    }

    return { turn, reason, text }
  }

  function sessionTitle(session) {
    try {
      const title = ctx.get('sessionTitle')?.get(session)?.title
      if (typeof title === 'string' && title.trim().length > 0) return title.trim()
    } catch {
      // optional service
    }
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return basename(cwd)
    return '任务完成'
  }

  async function notifySession(sessionId) {
    if (closed) return
    const session = ctx.sessions.get(sessionId)
    if (!session) return
    const header = session.header
    if (header?.origin === 'subagent' || header?.parentSession !== undefined) return

    const turn = findTurn(session)
    if (!turn) return

    const key = `${sessionId}:${turn.turn}`
    if (handledTurns.has(key)) return
    handledTurns.add(key)
    if (handledTurns.size > 2000) {
      const first = handledTurns.values().next().value
      if (first !== undefined) handledTurns.delete(first)
    }

    if (!shouldNotify()) return

    const title = clamp(sessionTitle(session), 80)
    const summary = clamp(plainText(turn.text) || '任务已完成。', options.summaryChars)
    const token = randomBytes(24).toString('base64url')

    state.tokens.set(token, { sessionId, at: Date.now() })
    saveState()

    const shown = await showToast(token, title, summary)
    if (!shown) {
      state.tokens.delete(token)
      saveState()
    }
  }

  async function showToast(token, title, summary) {
    await ready
    if (closed) return false
    if (!registration.ok) {
      lastDelivery = { at: Date.now(), ok: false, setting, error: registration.error ?? 'registration-failed' }
      logWarn(`toast not shown: registration failed: ${registration.error ?? 'unknown'}`)
      return false
    }

    const payloadPath = join(DATA_DIR, `toast-${token}.json`)
    const payload = {
      token,
      title,
      summary,
      placeholder: '输入回复…',
      replyLabel: '回复',
      iconPath: existsSync(iconPath) ? iconPath : '',
      sound: soundEffect,
      silent: soundEffect === 'none',
    }

    try {
      await writeFile(payloadPath, JSON.stringify(payload), 'utf8')
      const result = await runPowerShell(['-Payload', payloadPath], 30000)
      if (result.setting) setting = result.setting
      lastDelivery = {
        at: Date.now(),
        ok: result.ok === true,
        setting,
        error: result.ok ? undefined : (result.error ?? `powershell exited with ${result.code}`),
      }
      await writeDiagnostics()
      if (!result.ok) {
        if (setting && setting !== 'Enabled' && setting !== 'Unknown' && Date.now() - lastDisabledLog > 60_000) {
          lastDisabledLog = Date.now()
          logWarn(`Windows notifications are ${setting}; enable them in Windows Settings > System > Notifications. The plugin will not report a toast as delivered.`)
        } else {
          logWarn(`toast not shown: ${result.error ?? 'unknown error'}`)
        }
      }
      return result.ok === true
    } catch (error) {
      lastDelivery = {
        at: Date.now(),
        ok: false,
        setting,
        error: error instanceof Error ? error.message : String(error),
      }
      logWarn(`toast payload failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      await rm(payloadPath, { force: true }).catch(() => {})
    }
  }

  function scheduleNotification(sessionId) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      notifySession(sessionId).catch((error) => {
        logWarn(`notification failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 400)
    rememberTimer(timer)
  }

  function setupEvents() {
    ctx.on('agent/status', (payload) => {
      const agent = payload?.agent
      const status = payload?.status
      if (!agent || typeof agent.id !== 'string') return
      if (status === 'running') {
        agentRunning.add(agent.id)
        return
      }
      if (status !== 'idle') return
      if (!agentRunning.delete(agent.id)) return
      scheduleNotification(agent.id)
    })

    ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id
      if (typeof id === 'string') agentRunning.delete(id)
    })
  }

  async function cleanupDataFiles() {
    try {
      const entries = await readdir(DATA_DIR)
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      for (const name of entries) {
        if (!name.startsWith('toast-') || !name.endsWith('.json')) continue
        const path = join(DATA_DIR, name)
        try {
          const info = await stat(path)
          if (info.mtimeMs < cutoff) await rm(path, { force: true })
        } catch {
          // ignore one unreadable leftover
        }
      }
    } catch {
      // data directory may not exist yet
    }
  }

  async function readSpool(path) {
    try {
      const values = new Map()
      const text = await readFile(path, 'utf8')
      for (const line of text.split(/\r?\n/u)) {
        const index = line.indexOf('=')
        if (index <= 0) continue
        values.set(line.slice(0, index), line.slice(index + 1))
      }
      const token = values.get('token') ?? ''
      const action = values.get('action') ?? ''
      if (token.length < 16 || token.length > 128) return undefined
      if (action !== 'open' && action !== 'reply') return undefined
      const encoded = values.get('text') ?? ''
      let reply = ''
      if (action === 'reply') {
        reply = Buffer.from(encoded, 'base64').toString('utf8').trim()
        if (reply.length === 0 || reply.length > 4000) return undefined
      }
      return { token, action, reply }
    } catch {
      return undefined
    }
  }

  async function processSpool() {
    if (closed || spoolBusy) return
    spoolBusy = true
    try {
      await mkdir(PENDING_DIR, { recursive: true })
      const names = await readdir(PENDING_DIR).catch(() => [])
      for (const name of names) {
        if (closed || !name.endsWith('.pending')) continue
        const source = join(PENDING_DIR, name)
        const claimed = `${source}.processing-${process.pid}`
        try {
          await rename(source, claimed)
        } catch {
          continue
        }
        const parsed = await readSpool(claimed)
        if (!parsed) {
          await rm(claimed, { force: true }).catch(() => {})
          continue
        }
        if (parsed.action === 'open') {
          const info = state.tokens.get(parsed.token)
          if (info) addPendingOpen(parsed.token, info.sessionId)
          await rm(claimed, { force: true }).catch(() => {})
          continue
        }
        const result = await deliverReply(parsed.token, parsed.reply)
        if (result.ok || result.duplicate) {
          await rm(claimed, { force: true }).catch(() => {})
        } else {
          // Keep the activation for the next Host start; it is not lost.
          await rename(claimed, source).catch(() => {})
        }
      }

      // A stale claimed file from a crashed Host is retryable.
      const claimedNames = await readdir(PENDING_DIR).catch(() => [])
      for (const name of claimedNames) {
        if (!name.includes('.processing-')) continue
        const path = join(PENDING_DIR, name)
        try {
          const info = await readFile(path)
          if (info.length > 0) await rename(path, path.replace(/\.processing-\d+$/u, '.pending'))
        } catch {
          // ignore
        }
      }
    } catch (error) {
      logWarn(`spool scan failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      spoolBusy = false
    }
  }

  async function initialize() {
    await mkdir(DATA_DIR, { recursive: true })
    await deployRuntime()
    await cleanupDataFiles()
    await loadState()
    try {
      await startBridge()
    } catch (error) {
      logWarn(`activation bridge unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }

    registration = await ensureRegistration()
    if (!registration.ok) {
      logWarn(`toast registration failed: ${registration.error ?? 'unknown'}`)
      finishReady(false)
    } else {
      const probe = await probeSetting()
      if (probe.setting) setting = probe.setting
      if (probe.setting && probe.setting !== 'Enabled' && probe.setting !== 'Unknown') {
        logWarn(`Windows notifications are ${probe.setting}; enable them in Windows Settings > System > Notifications.`)
      }
      logInfo(`registered ${AUMID}; notification setting: ${setting || 'unknown'}`)
      finishReady(true)
    }
    await writeDiagnostics()

    await processSpool()
    const retry = setTimeout(() => {
      timers.delete(retry)
      processSpool().catch(() => {})
    }, 5000)
    rememberTimer(retry)
  }

  async function stop() {
    if (closed) return
    closed = true
    clearTimers()
    for (const child of children) {
      try { child.kill() } catch { /* already gone */ }
    }
    for (const dispose of routeDisposers.splice(0)) {
      try { dispose() } catch { /* route may already be gone */ }
    }
    if (bridgeServer) {
      await new Promise((resolve) => {
        try { bridgeServer.close(() => resolve()) } catch { resolve() }
      })
      bridgeServer = undefined
    }
    await rm(BRIDGE_PATH, { force: true }).catch(() => {})
    await saveChain.catch(() => {})
    finishReady(false)
  }

  ctx.effect(() => {
    // Routes and the index-injection listener must exist before the Host
    // reports ready: Desktop captures collectIndexInjections() once.
    setupRoutes()
    setupEvents()
    initialize().catch((error) => {
      logWarn(`initialization failed: ${error instanceof Error ? error.message : String(error)}`)
      finishReady(false)
    })
    return stop
  }, 'windows-notify: lifecycle')
}
