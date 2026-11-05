/**
 * Host half of the Codex relay monitor.
 *
 * Watches two local, append-only sources and publishes one JSON snapshot:
 *  - the codex-overload-fix relay log, which sees every /responses attempt,
 *    so an overload retry or a dropped stream is visible the moment it happens;
 *  - the Codex desktop log tree, whose executor/app-server reconnect episodes
 *    say whether the app itself is re-establishing a connection.
 *
 * The Client half (client.js) polls `/codex-relay/status` and draws the window.
 */
import { promises as fsp, readFileSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer']

const WIDGET_DIR = dirname(fileURLToPath(import.meta.url))
const WIDGET_LAUNCHER = join(WIDGET_DIR, 'launch-widget.vbs')
const WIDGET_PID_FILE = join(tmpdir(), 'codex-relay-widget.pid')

const MAX_EVENTS = 80
const WINDOW_MS = 5 * 60 * 1000
const INITIAL_TAIL_BYTES = 256 * 1024
const RUNNING_TTL_MS = 180 * 1000
const RUNNING_GRACE_MS = 5 * 1000

function resolveOptions(config) {
  const home = homedir()
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  return {
    relayLog: config?.relayLog || join(home, '.codex-overload-fix', 'relay.log'),
    codexLogRoot: config?.codexLogRoot || join(localAppData, 'Codex', 'Logs'),
    relayHost: config?.relayHost || '127.0.0.1',
    relayPort: Number(config?.relayPort ?? 8787),
    pollMs: Math.max(500, Number(config?.pollMs ?? 1500)),
    codexScanMs: Math.max(2000, Number(config?.codexScanMs ?? 5000)),
  }
}

/** Local `YYYY-MM-DD HH:MM:SS` (what relay.py writes) to epoch ms. */
function parseLocalStamp(date, time) {
  const ms = Date.parse(`${date}T${time}`)
  return Number.isFinite(ms) ? ms : Date.now()
}

function createTail() {
  return { offset: 0, rest: '', seeded: false, missing: false }
}

/** Read whatever was appended since the last pass and hand every complete line to `onLine`. */
async function pump(path, tail, onLine) {
  let stat
  try {
    stat = await fsp.stat(path)
  } catch {
    tail.missing = true
    return
  }
  tail.missing = false

  if (!tail.seeded) {
    tail.seeded = true
    tail.offset = Math.max(0, stat.size - INITIAL_TAIL_BYTES)
  }
  if (stat.size < tail.offset) {
    tail.offset = 0
    tail.rest = ''
  }
  tail.size = stat.size
  if (stat.size <= tail.offset) return

  const length = stat.size - tail.offset
  const buffer = Buffer.alloc(length)
  const handle = await fsp.open(path, 'r')
  try {
    await handle.read(buffer, 0, length, tail.offset)
  } finally {
    await handle.close()
  }
  tail.offset = stat.size

  // relay.py writes text mode on Windows, so lines end with CRLF; `$` never
  // matches after a trailing \r because `.` refuses to consume it.
  const lines = (tail.rest + buffer.toString('utf8')).split(/\r?\n/)
  tail.rest = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (trimmed.trim() !== '') onLine(trimmed)
  }
}

function probePort(host, port) {  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(400, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function readWidgetPid() {
  try {
    const pid = Number(readFileSync(WIDGET_PID_FILE, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Close the always-on-top widget this plugin started, if it is still running. */
function stopWidget() {
  const pid = readWidgetPid()
  if (pid !== null && isProcessAlive(pid)) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* the window may already be gone */
    }
  }
  try {
    rmSync(WIDGET_PID_FILE, { force: true })
  } catch {
    /* ignore */
  }
}

function startWidget() {
  if (process.platform !== 'win32') return
  stopWidget()
  try {
    const child = spawn('wscript.exe', [WIDGET_LAUNCHER], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch {
    /* a missing launcher must not take the host plugin down */
  }
}

export function apply(ctx, config) {  const options = resolveOptions(config)

  const state = {
    requests: new Map(),
    latestPort: null,
    events: [],
    relayUp: false,
    relayMissing: false,
    codexLastReconnect: null,
    codexLogDir: null,
    debug: {
      instanceId: Math.random().toString(36).slice(2, 8),
      startedAt: Date.now(),
      ticks: 0,
      codexTicks: 0,
      lastTickAt: 0,
      relayOffset: 0,
      relaySize: 0,
      lines: 0,
      lastError: null,
    },
  }

  const relayTail = createTail()
  const codexTails = new Map()

  function pushEvent(kind, text, at = Date.now()) {
    state.events.unshift({ at, kind, text })
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS
  }

  function handleRelayLine(line) {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \[(\d+)\] (.*)$/.exec(line)
    if (match === null) return
    const at = parseLocalStamp(match[1], match[2])
    const port = match[3]
    const body = match[4]

    if (body.startsWith('POST /responses')) {
      const detail = /\((?:(\d+)B)\)(.*)$/.exec(body)
      const bytes = detail?.[1] ? Number(detail[1]) : 0
      const model = /model=([^\s|]+)/.exec(detail?.[2] ?? '')?.[1]
      const record = {
        port,
        startedAt: at,
        lastAt: at,
        bytes,
        model: model ?? null,
        attempt: 0,
        status: 'running',
        reason: null,
        served: null,
      }
      state.requests.set(port, record)
      state.latestPort = port
      if (state.requests.size > 32) {
        const oldest = [...state.requests.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0]
        if (oldest !== undefined) state.requests.delete(oldest[0])
      }
      pushEvent('request', `开始请求 ${Math.round(bytes / 1024)} KB${model ? ` · ${model}` : ''}`, at)
      return
    }

    const active = state.requests.get(port)
    if (active === undefined) return

    const attempt = /^attempt (\d+): (.*)$/.exec(body)
    if (attempt !== null) {
      active.attempt = Number(attempt[1])
      active.lastAt = at
      const rest = attempt[2]
      const served = /\(served=([^)]+)\)/.exec(rest)?.[1]
      if (served) active.served = served
      if (rest.startsWith('ok, streaming')) {
        active.status = 'streaming'
        active.reason = null
        if (served && active.model && served !== active.model) {
          pushEvent('reroute', `服务端换了模型：${active.model} → ${served}`, at)
        } else if (active.attempt > 1) {
          pushEvent('recovered', `第 ${active.attempt} 次尝试成功${served ? `（${served}）` : ''}`, at)
        }
        return
      }
      if (rest.startsWith('retryable')) {
        const reason = /\((.*)\)$/.exec(rest)?.[1] ?? rest
        active.status = 'retrying'
        active.reason = reason
        if (/overload|at capacity|429|50[0234]/i.test(reason)) {
          pushEvent('overload', `过载重试 #${active.attempt}：${reason}`, at)
        } else {
          pushEvent('reconnect', `断流重连 #${active.attempt}：${reason}`, at)
        }
        return
      }
      if (rest.startsWith('upstream')) {
        active.status = 'done'
        return
      }
      return
    }

    const finished = /^stream finished in [\d.]+s$/.exec(body)
    if (finished !== null) {
      active.status = 'done'
      active.lastAt = at
      return
    }

    const gaveUp = /^giving up after (\d+) attempts/.exec(body)
    if (gaveUp !== null) {
      active.status = 'failed'
      active.lastAt = at
      pushEvent('gaveup', `重试 ${gaveUp[1]} 次后放弃`, at)
      return
    }
    const abandoned = /^abandoning retries after (\d+) attempts/.exec(body)
    if (abandoned !== null) {
      active.status = 'abandoned'
      active.lastAt = at
      pushEvent('gaveup', `客户端中止，已重试 ${abandoned[1]} 次`, at)
    }
  }

  function handleCodexLine(line) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d+)Z \w+ \[([^\]]+)\] (.*)$/.exec(line)
    if (match === null) return
    const at = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`)
    const tag = match[8]
    const body = match[9]
    if (!Number.isFinite(at)) return

    const isExecutorReconnect =
      tag === 'tpp-local-executor' && body.includes('event=episode_started') && body.includes('phase=reconnect')
    const isExecutorRecovered =
      tag === 'tpp-local-executor' && body.includes('event=episode_finished') && body.includes('outcome=recovered')
    const isAppServerReconnect =
      body.includes('app_server_connection.state_changed') && /reconnectAttempt=[1-9]\d*/.test(body)
    const isPubsubExhausted = body.includes('chatgpt_pubsub_reconnect_exhausted')

    if (isExecutorReconnect || isAppServerReconnect) {
      const source = isExecutorReconnect ? 'executor' : 'app-server'
      state.codexLastReconnect = { at, source }
      pushEvent('reconnect', `Codex ${source} 重连`, at)
      return
    }
    if (isExecutorRecovered) {
      pushEvent('recovered', 'Codex executor 已恢复', at)
      return
    }
    if (isPubsubExhausted) {
      pushEvent('reconnect', 'ChatGPT 通道重连已耗尽重试', at)
    }
  }

  function snapshot() {
    const now = Date.now()
    const recent = state.events.filter((event) => now - event.at <= WINDOW_MS)
    const count = (kind) => recent.filter((event) => event.kind === kind).length

    const all = [...state.requests.values()]
    const isLive = (request) => {
      if (now - request.lastAt > RUNNING_TTL_MS) return false
      if (request.status === 'failed' || request.status === 'abandoned') return false
      if (request.status === 'done') return now - request.lastAt <= RUNNING_GRACE_MS
      return true
    }
    const live = all.filter(isLive).sort((a, b) => b.lastAt - a.lastAt)
    const latest = state.latestPort === null ? undefined : state.requests.get(state.latestPort)
    // Prefer a live request; otherwise keep showing the newest one so the card
    // can still say which model the last task used.
    const active = live.length > 0 ? live[0] : latest
    const running = live.length > 0

    return {
      now,
      relay: {
        up: state.relayUp,
        logPath: options.relayLog,
        logMissing: state.relayMissing,
        logAgeMs: active === undefined ? null : now - active.lastAt,
      },
      active:
        active === undefined
          ? null
          : {
              startedAt: active.startedAt,
              ageMs: now - active.startedAt,
              bytes: active.bytes,
              model: active.model,
              served: active.served,
              attempt: active.attempt,
              status: active.status,
              reason: active.reason,
            },
      running,
      window: {
        overload: count('overload'),
        reconnect: count('reconnect'),
        recovered: count('recovered'),
        gaveUp: count('gaveup'),
        reroute: count('reroute'),
      },
      events: recent.slice(0, 8),
      codex: { lastReconnect: state.codexLastReconnect, logDir: state.codexLogDir },
      debug: { ...state.debug },
    }
  }

  const handler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(snapshot()))
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/codex-relay/status', handler }), 'codex-relay.route')

  async function scanCodexLogs() {
    const now = new Date()
    const dir = join(
      options.codexLogRoot,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    )
    state.codexLogDir = dir
    let names
    try {
      names = await fsp.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.log')) continue
      const path = join(dir, name)
      if (!codexTails.has(path)) codexTails.set(path, createTail())
      try {
        await pump(path, codexTails.get(path), handleCodexLine)
      } catch {
        /* a log being rewritten is not worth a failure */
      }
    }
    if (codexTails.size > 24) {
      const keep = new Set([...codexTails.keys()].slice(-8))
      for (const path of codexTails.keys()) if (!keep.has(path)) codexTails.delete(path)
    }
  }

  async function tick() {
    state.debug.ticks += 1
    state.debug.lastTickAt = Date.now()
    state.relayMissing = relayTail.missing
    try {
      await pump(options.relayLog, relayTail, (line) => {
        state.debug.lines += 1
        try {
          handleRelayLine(line)
        } catch (error) {
          state.debug.lastError = `parse: ${String((error && error.message) || error)}`
        }
      })
    } catch (error) {
      state.debug.lastError = `read: ${String((error && error.message) || error)}`
    }
    state.debug.relayOffset = relayTail.offset
    state.debug.relaySize = relayTail.size
    state.relayMissing = relayTail.missing
    state.relayUp = await probePort(options.relayHost, options.relayPort)
  }

  async function tickCodex() {
    state.debug.codexTicks += 1
    await scanCodexLogs()
  }

  ctx.effect(() => {
    let stopped = false
    const run = () => {
      if (stopped) return
      tick().catch(() => {})
    }
    const runCodex = () => {
      if (stopped) return
      tickCodex().catch(() => {})
    }
    run()
    runCodex()
    const timer = setInterval(run, options.pollMs)
    const codexTimer = setInterval(runCodex, options.codexScanMs)
    return () => {
      stopped = true
      clearInterval(timer)
      clearInterval(codexTimer)
    }
  }, 'codex-relay.poller')

  // The floating window lives outside the Harness window, so it is a separate
  // always-on-top process fed by the same `/codex-relay/status` endpoint.
  if (config?.widget !== false) {
    ctx.effect(() => {
      startWidget()
      return () => stopWidget()
    }, 'codex-relay.widget')
  }
}
