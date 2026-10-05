import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AutomationResponse } from '../src/lib/automation/contracts.ts'
import {
  installScanner,
  scannerDirectory,
  scannerRelease,
} from './scanner-install.mts'

type Scan = {
  id: string,
  status: 'starting' | 'running' | 'cancelling' | 'importing' | 'completed' | 'failed' | 'cancelled',
  outputPath: string,
  error?: string,
  imported?: unknown,
}

type ScannerDependencies = {
  directory: string,
  install: (signal: AbortSignal) => Promise<string>,
  launch: typeof launchScanner,
  importScan: (json: string) => Promise<AutomationResponse>,
}

export async function launchScanner(executable: string, directory: string, timeoutSeconds: number) {
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fileURLToPath(new URL('./scanner-run.ps1', import.meta.url)),
    '-JobDirectory',
    directory,
    '-ExecutablePath',
    executable,
    '-ExpectedHash',
    scannerRelease.sha256,
    '-OwnerPid',
    String(process.pid),
    '-TimeoutSeconds',
    String(timeoutSeconds),
  ], { windowsHide: true, stdio: 'ignore' })
  child.unref()
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Scanner launcher exited with code ${code}`)))
  })
  const result: unknown = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
  if (!result || typeof result !== 'object' || !('status' in result)) throw new Error('Invalid scanner result')
  if (result.status === 'cancelled') return 'cancelled' as const
  if (result.status !== 'captured') throw new Error('error' in result && typeof result.error === 'string' ? result.error : 'Capture failed')
  return 'captured' as const
}

/** One owned capture per MCP session; no polling or browser-side scanner dependency. */
export class Scanner {
  private scan: Scan | undefined
  private work: Promise<void> | undefined
  private installing: Promise<string> | undefined
  private closed = false
  private abort = new AbortController()

  private readonly dependencies: ScannerDependencies

  constructor(dependencies: ScannerDependencies) {
    this.dependencies = dependencies
  }

  get busy() {
    return this.work !== undefined
  }

  async install() {
    if (this.closed) throw new Error('Scanner session is closing')
    this.installing ??= this.dependencies.install(this.abort.signal).finally(() => {
      this.installing = undefined
    })
    return { executable: await this.installing, ...scannerRelease }
  }

  async status() {
    if (this.scan?.status === 'starting') {
      try {
        await stat(join(this.dependencies.directory, 'runs', this.scan.id, 'running'))
        if (this.scan.status === 'starting') this.scan.status = 'running'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return { version: scannerRelease.version, installing: this.installing !== undefined, scan: this.scan ? { ...this.scan } : null }
  }

  start(timeoutSeconds: number) {
    if (this.closed) throw new Error('Scanner session is closing')
    if (this.busy) throw new Error('A scanner job is already active')
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 600) {
      throw new Error('timeoutSeconds must be an integer between 30 and 600')
    }
    const id = randomUUID()
    const directory = join(this.dependencies.directory, 'runs', id)
    const scan: Scan = { id, status: 'starting', outputPath: join(directory, 'scan.json') }
    this.scan = scan
    this.work = this.run(scan, directory, timeoutSeconds).finally(() => {
      this.work = undefined
    })
    return {
      ...scan,
      instructions: 'Approve Windows UAC, wait for running, then enter the game from the Click to Start screen. Import runs automatically after capture.',
    }
  }

  private async run(scan: Scan, directory: string, timeoutSeconds: number) {
    const cancelled = () => scan.status === 'cancelling'
    let launched = false
    try {
      await mkdir(directory, { recursive: true })
      const { executable } = await this.install()
      if (cancelled()) {
        scan.status = 'cancelled'
        return
      }
      launched = true
      const captured = await this.dependencies.launch(executable, directory, timeoutSeconds)
      if (captured === 'cancelled' || cancelled()) {
        scan.status = 'cancelled'
        return
      }
      if ((await stat(scan.outputPath)).size > 32 * 1024 * 1024) throw new Error('Scanner output exceeds 32 MiB')
      const json = await readFile(scan.outputPath, 'utf8')
      if (cancelled()) {
        scan.status = 'cancelled'
        return
      }
      scan.status = 'importing'
      const response = await this.dependencies.importScan(json)
      if (!response.ok) throw new Error(`Capture saved, but import failed: ${response.error.code}: ${response.error.message}`)
      scan.imported = response.data
      scan.status = 'completed'
    } catch (error) {
      scan.status = cancelled() && !launched ? 'cancelled' : 'failed'
      if (scan.status === 'failed') scan.error = error instanceof Error ? error.message : String(error)
    }
  }

  async cancel() {
    const scan = this.scan
    if (scan && this.busy) {
      if (scan.status === 'importing') throw new Error('Capture is complete and import has already started')
      scan.status = 'cancelling'
      const directory = join(this.dependencies.directory, 'runs', scan.id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'cancel'), '')
    }
    return this.status()
  }

  async close() {
    this.closed = true
    this.abort.abort()
    if (this.scan?.status !== 'importing') await this.cancel()
    // Do not wait for an unanswered UAC dialog; the elevated helper observes the cancellation file and owner lifetime.
  }
}

export function createScanner(importScan: (json: string) => Promise<AutomationResponse>) {
  return new Scanner({ directory: scannerDirectory(), install: installScanner, launch: launchScanner, importScan })
}
