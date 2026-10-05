import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import {
  expect,
  test,
} from '@playwright/test'
import { spawn } from 'node:child_process'
import {
  readFile,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { scan } from './fixtures'

test('MCP discovers tools, imports and exports files, and refuses overwrites', async () => {
  const testInfo = test.info()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['scripts/automation-mcp.mts'],
    cwd: resolve('.'),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      HSR_AUTOMATION_URL: 'http://127.0.0.1:4174/hsr-optimizer/',
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'automation-verification', version: '1.0.0' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('hsr_start_optimization')
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['hsr_install_scanner', 'hsr_get_scanner', 'hsr_start_scan', 'hsr_cancel_scan']),
    )
    const scanner = await client.callTool({ name: 'hsr_get_scanner', arguments: {} })
    expect(scanner.isError, JSON.stringify(scanner)).toBe(false)
    expect(scanner.content).toEqual([expect.objectContaining({ text: expect.stringContaining('"scan":null') })])
    expect((await client.callTool({ name: 'hsr_start_scan', arguments: { timeoutSeconds: 0 } })).isError).toBe(true)
    expect((await client.callTool({ name: 'hsr_get_scanner', arguments: { executable: 'arbitrary.exe' } })).isError).toBe(true)
    const source = JSON.parse(await readFile('src/data/sample-save.json', 'utf8'))
    const character = source.characters.find((entry: { id: string }) => entry.id === '1212b1')
    const ids = new Set(Object.values(character.equipped))
    const input = testInfo.outputPath('input.json')
    await writeFile(input, JSON.stringify({ characters: [character], relics: source.relics.filter((entry: { id: string }) => ids.has(entry.id)) }))
    const imported = await client.callTool({ name: 'hsr_import_save_file', arguments: { path: input } })
    expect(imported.isError, JSON.stringify(imported)).toBe(false)
    const output = testInfo.outputPath('output.json')
    const exported = await client.callTool({ name: 'hsr_export_save_file', arguments: { path: output } })
    expect(exported.isError, JSON.stringify(exported)).toBe(false)
    const saved = JSON.parse(await readFile(output, 'utf8'))
    expect(saved.characters).toHaveLength(1)
    expect(saved.relics).toHaveLength(6)
    expect((await client.callTool({ name: 'hsr_export_save_file', arguments: { path: output } })).isError).toBe(true)
    const unchanged = await client.callTool({ name: 'hsr_compare_inventory_file', arguments: { path: output, limit: 1 } })
    expect(unchanged.isError).toBe(false)
    const scanFile = testInfo.outputPath('scan.json')
    await writeFile(scanFile, JSON.stringify(scan))
    const scanned = await client.callTool({ name: 'hsr_import_scan_file', arguments: { path: scanFile } })
    expect(scanned.isError, JSON.stringify(scanned)).toBe(false)
    const resources = await client.callTool({ name: 'hsr_get_resources', arguments: {} })
    expect(resources.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('stellar_jade') })])
    const scanOutput = testInfo.outputPath('scanned.json')
    expect((await client.callTool({ name: 'hsr_export_save_file', arguments: { path: scanOutput } })).isError).toBe(false)
    expect(JSON.parse(await readFile(scanOutput, 'utf8')).scannerInventory.materials[0].count).toBe(12)
  } finally {
    await client.close()
  }
  expect(transport.pid).toBeNull()
})

test('MCP exits normally after stdin EOF with a browser open', async () => {
  const child = spawn(process.execPath, ['scripts/automation-mcp.mts'], {
    cwd: resolve('.'),
    env: { ...process.env, HSR_AUTOMATION_URL: 'http://127.0.0.1:4174/hsr-optimizer/' },
    stdio: 'pipe',
  })
  const lines = createInterface({ input: child.stdout })
  const responses = new Map<number, any>()
  let errors = ''
  child.stderr.on('data', (chunk) => {
    errors += String(chunk)
  })
  lines.on('line', (line) => {
    const response = JSON.parse(line)
    if (response.id) responses.set(response.id, response)
  })
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'eof-verification', version: '1.0.0' } },
      }) + '\n',
    )
    await expect.poll(() => responses.has(1)).toBe(true)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
    await expect.poll(() => responses.has(2), { timeout: 30000 }).toBe(true)
    expect(responses.get(2).result.tools.map((tool: { name: string }) => tool.name)).toContain('hsr_import_scan_file')
    child.stdin.end()
    await expect.poll(() => child.exitCode, { timeout: 10000 }).not.toBeNull()
    expect(child.exitCode, errors).toBe(0)
  } finally {
    lines.close()
    if (child.exitCode === null) child.kill()
  }
})
