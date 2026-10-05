import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  join,
  resolve,
} from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import {
  installScanner,
  scannerDirectory,
  scannerRelease,
} from './scanner-install.mts'
import { Scanner } from './scanner.mts'

async function waitFor(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await done()) return
    await setTimeout(25)
  }
  assert.fail('Timed out waiting for scanner state')
}

test('installer rejects corrupt or oversized downloads and removes unfinished executables', { skip: process.platform !== 'win32' }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'hsr-install-'))
  const previous = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = directory
  try {
    for (const extra of [0, 1]) {
      const download = context.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(scannerRelease.bytes + extra)))
      await assert.rejects(installScanner(), extra ? /exceeds the pinned size/ : /SHA-256/)
      assert.deepEqual(await readdir(join(scannerDirectory(), scannerRelease.version)), ['LICENSE.txt'])
      download.mock.restore()
    }
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed process cleanup is not reported as successful cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hsr-scanner-'))
  let launched = false
  const scanner = new Scanner({
    directory,
    install: async () => 'scanner.exe',
    launch: async (_executable, run) => {
      launched = true
      await waitFor(async () => stat(join(run, 'cancel')).then(() => true, () => false))
      throw new Error('Cleanup could not be confirmed')
    },
    importScan: async () => {
      assert.fail('Failed capture must not import')
    },
  })
  try {
    scanner.start(30)
    await waitFor(() => launched)
    await scanner.cancel()
    await waitFor(() => !scanner.busy)
    assert.equal((await scanner.status()).scan?.status, 'failed')
    assert.match((await scanner.status()).scan!.error!, /Cleanup/)
  } finally {
    await scanner.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('scanner imports only after capture, retains the output and serializes jobs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hsr-scanner-'))
  let release!: () => void
  const captured = new Promise<void>((resolve) => {
    release = resolve
  })
  let imports = 0
  const scanner = new Scanner({
    directory,
    install: async () => 'scanner.exe',
    launch: async (_executable, run) => {
      await writeFile(join(run, 'running'), '')
      await captured
      await writeFile(join(run, 'scan.json'), '{"relics":[]}')
      return 'captured'
    },
    importScan: async (json) => {
      assert.equal(json, '{"relics":[]}')
      imports++
      return { ok: true, data: { relics: 0 } }
    },
  })
  try {
    const started = scanner.start(120)
    assert.throws(() => scanner.start(120), /already active/)
    await waitFor(async () => (await scanner.status()).scan?.status === 'running')
    assert.equal(imports, 0)
    release()
    await waitFor(() => !scanner.busy)
    assert.equal((await scanner.status()).scan?.status, 'completed')
    assert.equal(imports, 1)
    assert.equal(await readFile(started.outputPath, 'utf8'), '{"relics":[]}')
  } finally {
    release()
    await scanner.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('cancel and EOF stop capture without importing even when capture completes concurrently', async () => {
  for (const close of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'hsr-scanner-'))
    let launched = false
    const scanner = new Scanner({
      directory,
      install: async () => 'scanner.exe',
      launch: async (_executable, run) => {
        launched = true
        await waitFor(async () => stat(join(run, 'cancel')).then(() => true, () => false))
        await writeFile(join(run, 'scan.json'), '{}')
        return 'captured'
      },
      importScan: async () => {
        assert.fail('Cancelled capture must not import')
      },
    })
    try {
      scanner.start(120)
      await waitFor(() => launched)
      if (close) await scanner.close()
      else await scanner.cancel()
      await waitFor(() => !scanner.busy)
      assert.equal((await scanner.status()).scan?.status, 'cancelled')
      if (close) assert.throws(() => scanner.start(120), /closing/)
    } finally {
      await scanner.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('failed import retains scan and releases admission; scanner failure never imports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hsr-scanner-'))
  let failCapture = false
  let imports = 0
  const scanner = new Scanner({
    directory,
    install: async () => 'scanner.exe',
    launch: async (_executable, run) => {
      if (failCapture) throw new Error('Incomplete capture')
      await writeFile(join(run, 'scan.json'), '{}')
      return 'captured'
    },
    importScan: async () => {
      imports++
      return { ok: false, error: { code: 'BUSY', message: 'Search running' } }
    },
  })
  try {
    assert.throws(() => scanner.start(0), /between/)
    const first = scanner.start(30)
    await waitFor(() => !scanner.busy)
    assert.match((await scanner.status()).scan!.error!, /import failed: BUSY/)
    assert.equal(await readFile(first.outputPath, 'utf8'), '{}')
    failCapture = true
    scanner.start(30)
    await waitFor(() => !scanner.busy)
    assert.equal((await scanner.status()).scan?.error, 'Incomplete capture')
    assert.equal(imports, 1)
  } finally {
    await scanner.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('EOF aborts an in-flight installer and prevents capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hsr-scanner-'))
  let installing = false
  const scanner = new Scanner({
    directory,
    install: async (signal) => {
      installing = true
      await setTimeout(30000, undefined, { signal })
      return 'scanner.exe'
    },
    launch: async () => {
      assert.fail('Closed scanner must not launch')
    },
    importScan: async () => {
      assert.fail('Closed scanner must not import')
    },
  })
  try {
    scanner.start(120)
    await waitFor(() => installing)
    await scanner.close()
    await waitFor(() => !scanner.busy)
    assert.equal((await scanner.status()).scan?.status, 'cancelled')
  } finally {
    await scanner.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Windows runner requires complete capture, rejects wrong hash, and cancels its owned process', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hsr scanner\'s test-'))
  const exe = join(directory, 'fixture.exe')
  const source = join(directory, 'fixture.cs')
  const run = promisify(execFile)
  await writeFile(
    source,
    `using System; using System.IO; using System.Threading;
class Fixture { static void Main(string[] args) {
  Console.WriteLine("Capture started"); Console.Out.Flush();
  if (Environment.GetEnvironmentVariable("HSR_FIXTURE_MODE") == "wait") Thread.Sleep(30000);
  File.WriteAllText(args[args.Length - 1], "{}");
  if (Environment.GetEnvironmentVariable("HSR_FIXTURE_MODE") != "partial") Console.WriteLine("retrieved all relevant packets, stop listening");
} }`,
  )
  const quote = (s: string) => '\'' + s.replaceAll('\'', '\'\'') + '\''
  try {
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -Path ${quote(source)} -OutputAssembly ${quote(exe)} -OutputType ConsoleApplication`,
    ])
    const hash = createHash('sha256').update(await readFile(exe)).digest('hex')
    for (const mode of ['complete', 'partial', 'hash', 'wait']) {
      const job = join(directory, mode)
      await mkdir(job)
      const completion = run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve('scripts/scanner-run.ps1'),
        '-Elevated',
        '-JobDirectory',
        job,
        '-ExecutablePath',
        exe,
        '-ExpectedHash',
        mode === 'hash' ? 'bad' : hash,
        '-OwnerPid',
        String(process.pid),
        '-TimeoutSeconds',
        '30',
      ], { windowsHide: true, env: { ...process.env, HSR_FIXTURE_MODE: mode }, timeout: 15000 })
      if (mode === 'wait') {
        await waitFor(async () => stat(join(job, 'running')).then(() => true, () => false))
        await writeFile(join(job, 'cancel'), '')
      }
      await completion
      const result = JSON.parse(await readFile(join(job, 'result.json'), 'utf8'))
      assert.equal(result.status, mode === 'complete' ? 'captured' : mode === 'wait' ? 'cancelled' : 'failed', JSON.stringify(result))
      if (mode === 'partial') assert.match(result.error, /complete inventory/)
      if (mode === 'hash') assert.match(result.error, /SHA-256/)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
