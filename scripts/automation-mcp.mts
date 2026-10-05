import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { chromium } from '@playwright/test'
import {
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AutomationResponse } from '../src/lib/automation/contracts.ts'
import type { AutomationApi } from '../src/lib/automation/install.ts'
import type {
  AutomationMirrorBroadcast,
  AutomationMirrorEvent,
} from '../src/lib/automation/mirror.ts'
import { summarizeAutomationValue } from '../src/lib/automation/mirror.ts'
import { createScanner } from './scanner.mts'

const url = new URL(process.env.HSR_AUTOMATION_URL ?? 'http://127.0.0.1:4173/hsr-optimizer/')
if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('HSR_AUTOMATION_URL must be an HTTP(S) URL')
const mirrorPort = Number(process.env.HSR_MIRROR_PORT ?? 4176)

// AI activity relay: streams every automation call as SSE to any open optimizer
// page, and serves the session save as a snapshot. Exists only while this MCP
// session is running an automation browser.
let mirrorSeq = 0
const mirrorBacklog: AutomationMirrorBroadcast[] = []
const mirrorClients = new Set<ServerResponse>()
let mirrorServer: ReturnType<typeof createServer> | undefined
// Set while the relay serves a viewer-triggered /snapshot: those exports are the
// user's own action, not an AI operation, and must not enter the feed.
let snapshotExportActive = false

function mirrorAllowedOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  const allowed = new Set([url.origin])
  // Accept the 127.0.0.1 / localhost spelling the bridge is not configured with.
  const twin = new URL(url.origin)
  twin.hostname = twin.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1'
  allowed.add(twin.origin)
  return allowed.has(origin) ? origin : undefined
}

function mirrorCorsHeaders(origin: string | undefined) {
  return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
}

function mirrorBroadcast(event: AutomationMirrorEvent) {
  if (snapshotExportActive && event.name === 'export_save') return
  const broadcast: AutomationMirrorBroadcast = { seq: ++mirrorSeq, ...event }
  mirrorBacklog.push(broadcast)
  if (mirrorBacklog.length > 200) mirrorBacklog.shift()
  const payload = `data: ${JSON.stringify(broadcast)}\n\n`
  for (const client of mirrorClients) client.write(payload)
}

function mirrorToolEvent(started: number, name: string, input: unknown, result: AutomationResponse) {
  mirrorBroadcast({
    ts: started,
    name,
    ok: result.ok,
    errorCode: result.ok ? undefined : result.error.code,
    errorMessage: result.ok ? undefined : summarizeAutomationValue(result.error.message) as string | undefined,
    durationMs: Date.now() - started,
    input: summarizeAutomationValue(input),
    data: result.ok ? summarizeAutomationValue(result.data) : undefined,
  })
}

function startMirror() {
  if (mirrorServer) return
  const heartbeat = setInterval(() => {
    for (const client of mirrorClients) client.write(': heartbeat\n\n')
  }, 25000)
  const server = createServer((req, res) => {
    const origin = mirrorAllowedOrigin(req.headers.origin)
    try {
      if (req.method === 'GET' && req.url === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...mirrorCorsHeaders(origin),
        })
        res.write('retry: 3000\n\n')
        for (const event of mirrorBacklog) res.write(`data: ${JSON.stringify(event)}\n\n`)
        mirrorClients.add(res)
        req.on('close', () => mirrorClients.delete(res))
        return
      }
      if (req.method === 'GET' && req.url === '/snapshot') {
        if (!origin) {
          res.writeHead(403).end()
          return
        }
        if (!session) {
          res.writeHead(503, { 'Content-Type': 'application/json', ...mirrorCorsHeaders(origin) })
          res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'No automation session is running' } }))
          return
        }
        // Serialize snapshot exports so concurrent viewer requests cannot interleave.
        // Viewer-triggered exports are the user's own action, not AI operations:
        // suppress their mirror events for the duration.
        snapshotQueue = snapshotQueue.then(async () => {
          snapshotExportActive = true
          try {
            const reply = await call('export_save', {})
            if (reply.ok && typeof reply.data === 'string') {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...mirrorCorsHeaders(origin) })
              res.end(reply.data)
            } else {
              res.writeHead(502, { 'Content-Type': 'application/json', ...mirrorCorsHeaders(origin) })
              res.end(JSON.stringify(reply.ok ? { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Optimizer did not produce a save' } } : reply))
            }
          } finally {
            snapshotExportActive = false
          }
        }).catch((error: unknown) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json', ...mirrorCorsHeaders(origin) })
            res.end(JSON.stringify({ ok: false, error: { code: 'BRIDGE_ERROR', message: error instanceof Error ? error.message : String(error) } }))
          } else {
            res.destroy()
          }
        })
        return
      }
      res.writeHead(404).end()
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error))
      else res.destroy()
    }
  })
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`AI activity relay unavailable on port ${mirrorPort}:`, error.message)
    clearInterval(heartbeat)
  })
  server.listen(mirrorPort, '127.0.0.1', () => {
    console.error(`AI activity relay listening on http://127.0.0.1:${mirrorPort} (/events, /snapshot)`)
  })
  mirrorServer = server
}

let snapshotQueue: Promise<void> = Promise.resolve()

// One browser per MCP session, created on first tool use. No background service or polling.
let session: ReturnType<typeof connect> | undefined
let closing = false
let scanner: ReturnType<typeof createScanner> | undefined
const scannerTools = ['hsr_install_scanner', 'hsr_get_scanner', 'hsr_start_scan', 'hsr_cancel_scan']
const scanReadTools = new Set([
  'hsr_list_characters',
  'hsr_list_relics',
  'hsr_list_light_cones',
  'hsr_get_resources',
  'hsr_get_request',
  'hsr_list_builds',
  'hsr_check_builds',
  'hsr_get_job',
  'hsr_get_results',
  'hsr_get_batch',
  'hsr_get_batch_results',
  'hsr_export_save_file',
  'hsr_compare_inventory_file',
  'hsr_cancel_job',
  'hsr_cancel_batch',
])
async function connect() {
  // Set HSR_BROWSER_HEADLESS=false to watch the automation browser working on screen.
  const headless = process.env.HSR_BROWSER_HEADLESS !== 'false'
  const browser = await chromium.launch({ channel: process.env.HSR_BROWSER_CHANNEL ?? 'msedge', headless })
  try {
    const page = await browser.newPage()
    await page.exposeBinding('__hsrAutomationMirror', (_source, event: AutomationMirrorEvent) => mirrorBroadcast(event))
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean((window as Window & { hsrAutomation?: AutomationApi }).hsrAutomation))
    startMirror()
    return { browser, page }
  } catch (error) {
    await browser.close()
    throw error
  }
}

async function getPage() {
  if (closing) throw new Error('MCP session is closing')
  session ??= connect().catch((error) => {
    session = undefined
    throw error
  })
  return (await session).page
}

async function call(name: string, input: unknown, scannerImport = false): Promise<AutomationResponse> {
  const page = await getPage()
  // Recheck after asynchronous file/page operations: a scan may have started meanwhile.
  const readTool = name === 'export_save' || name === 'compare_inventory' || scanReadTools.has('hsr_' + name)
  if (scanner?.busy && !scannerImport && !readTool) {
    return { ok: false, error: { code: 'BUSY', message: 'A scanner job is active' } }
  }
  return page.evaluate(({ name, input }) => (window as Window & { hsrAutomation: AutomationApi }).hsrAutomation.call(name, input), { name, input })
}

const server = new Server({ name: 'hsr-optimizer', version: '1.0.0' }, { capabilities: { tools: {} } })
const fileSchema: Tool['inputSchema'] = {
  type: 'object',
  properties: { path: { type: 'string', minLength: 1 } },
  required: ['path'],
  additionalProperties: false,
}
const fileCommands = new Map([
  ['hsr_import_save_file', 'import_save'],
  ['hsr_import_scan_file', 'import_scan'],
  ['hsr_compare_inventory_file', 'compare_inventory'],
])

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const page = await getPage()
  const commands = await page.evaluate(() => (window as Window & { hsrAutomation: AutomationApi }).hsrAutomation.describe())
  const tools: Tool[] = commands.filter((command) => ![...fileCommands.values(), 'export_save'].includes(command.name)).map((command) => ({
    ...command,
    name: `hsr_${command.name}`,
    inputSchema: command.inputSchema as Tool['inputSchema'],
  }))
  tools.push(
    ...scannerTools.map((name): Tool => ({
      name,
      description: {
        hsr_install_scanner: 'Install and SHA-256 verify the pinned Reliquary Archiver on Windows x64. Cached outside the repository.',
        hsr_get_scanner: 'Read the latest scanner job status. completed means capture and optimizer import both succeeded.',
        hsr_start_scan:
          'Install if needed, request Windows UAC, and capture game login inventory. Return immediately; poll hsr_get_scanner. Enter the game after capture starts. Automatically import a complete scan.',
        hsr_cancel_scan: 'Cancel the current capture. Does not import partial data. Cannot cancel an import already in progress.',
      }[name]!,
      inputSchema: {
        type: 'object',
        properties: name === 'hsr_start_scan' ? { timeoutSeconds: { type: 'integer', minimum: 30, maximum: 600, default: 120 } } : {},
        additionalProperties: false,
      },
    })),
    {
      name: 'hsr_import_save_file',
      description: 'Replace session inventory with an existing optimizer JSON save from a local file (up to 32 MiB).',
      inputSchema: fileSchema,
    },
    {
      name: 'hsr_export_save_file',
      description: 'Write the session optimizer save to a new local file. Never overwrites existing files.',
      inputSchema: fileSchema,
    },
    {
      name: 'hsr_import_scan_file',
      description: 'Import a local supported scanner JSON file (up to 32 MiB), including resources and owned light cones.',
      inputSchema: fileSchema,
    },
    {
      name: 'hsr_compare_inventory_file',
      description: 'Compare a previous local optimizer save with current inventory by stable IDs. Read-only paged changes.',
      inputSchema: {
        ...fileSchema,
        properties: { ...fileSchema.properties, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
    },
  )
  return { tools }
})

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const started = Date.now()
  try {
    let result: AutomationResponse
    const fileCommand = fileCommands.get(params.name)
    if (scannerTools.includes(params.name)) {
      const args = params.arguments ?? {}
      if (Object.keys(args).some((key) => params.name !== 'hsr_start_scan' || key !== 'timeoutSeconds')) throw new Error('Unsupported scanner arguments')
      scanner ??= createScanner((json) => call('import_scan', { json }, true))
      let data: unknown
      switch (params.name) {
        case 'hsr_install_scanner':
          data = await scanner.install()
          break
        case 'hsr_get_scanner':
          data = await scanner.status()
          break
        case 'hsr_cancel_scan':
          data = await scanner.cancel()
          break
        case 'hsr_start_scan':
          await getPage()
          if (args.timeoutSeconds !== undefined && typeof args.timeoutSeconds !== 'number') throw new Error('timeoutSeconds must be a number')
          data = scanner.start(args.timeoutSeconds ?? 120)
          break
      }
      result = { ok: true, data }
      mirrorToolEvent(started, params.name, args, result)
    } else if (scanner?.busy && !scanReadTools.has(params.name)) {
      result = { ok: false, error: { code: 'BUSY', message: 'Wait for or cancel the active scanner before changing inventory or starting another search' } }
      mirrorToolEvent(started, params.name, params.arguments ?? {}, result)
    } else if (fileCommand || params.name === 'hsr_export_save_file') {
      const args = params.arguments
      const allowed = fileCommand === 'compare_inventory' ? ['path', 'offset', 'limit'] : ['path']
      if (!args || typeof args.path !== 'string' || !args.path || Object.keys(args).some((key) => !allowed.includes(key))) {
        throw new Error('Provide a nonempty path and supported arguments')
      }
      if (fileCommand) {
        if ((await stat(args.path)).size > 32 * 1024 * 1024) throw new Error('Save file exceeds 32 MiB')
        const { path, ...options } = args
        result = await call(fileCommand, { ...options, json: await readFile(path as string, 'utf8') })
      } else {
        result = await call('export_save', {})
        if (result.ok) {
          if (typeof result.data !== 'string') throw new Error('Optimizer did not produce a save')
          await writeFile(args.path, result.data, { encoding: 'utf8', flag: 'wx' })
          result = { ok: true, data: { path: args.path } }
        }
      }
    } else {
      if (!params.name.startsWith('hsr_')) throw new Error('Unknown tool')
      result = await call(params.name.slice(4), params.arguments ?? {})
    }
    return { isError: !result.ok, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: false, error: { code: 'BRIDGE_ERROR', message: error instanceof Error ? error.message : String(error) } }),
      }],
    }
  }
})

async function close() {
  if (closing) return
  closing = true
  try {
    await scanner?.close()
    await (await session)?.browser.close()
    if (mirrorServer) {
      for (const client of mirrorClients) client.destroy()
      mirrorClients.clear()
      await new Promise<void>((resolve) => mirrorServer!.close(() => resolve()))
      mirrorServer = undefined
    }
  } finally {
    await server.close()
  }
}
function shutdown() {
  void close().catch((error: unknown) => {
    console.error('Failed to close MCP session:', error)
    process.exitCode = 1
  })
}
server.onclose = shutdown
process.stdin.once('end', shutdown)
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
await server.connect(new StdioServerTransport())
