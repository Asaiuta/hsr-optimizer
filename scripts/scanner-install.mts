import {
  createHash,
  randomUUID,
} from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import {
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  Readable,
  Transform,
} from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const scannerRelease = {
  version: 'v0.19.0',
  url: 'https://github.com/IceDynamix/reliquary-archiver/releases/download/v0.19.0/reliquary-archiver-pktmon-x64.exe',
  sha256: '4c687b0cc042d641fe3d2e513e3380544055f46ebb4092cc2a6dcb9072835c0a',
  bytes: 12294144,
} as const

export function scannerDirectory() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !process.env.LOCALAPPDATA) {
    throw new Error('The bundled scanner requires Windows x64 and LOCALAPPDATA')
  }
  const directory = join(process.env.LOCALAPPDATA, 'hsr-optimizer', 'scanner')
  mkdirSync(directory, { recursive: true })
  // Resolve Windows packaged-app redirection before passing paths to an elevated process.
  return realpathSync.native(directory)
}

export async function verifyScanner(path: string) {
  if ((await stat(path)).size !== scannerRelease.bytes) throw new Error('Scanner size does not match the pinned release')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== scannerRelease.sha256) throw new Error('Scanner SHA-256 does not match the pinned release')
}

export async function installScanner(signal?: AbortSignal) {
  const directory = join(scannerDirectory(), scannerRelease.version)
  const executable = join(directory, 'reliquary-archiver.exe')
  await mkdir(directory, { recursive: true })
  await copyFile(new URL('./reliquary-LICENSE.txt', import.meta.url), join(directory, 'LICENSE.txt'))
  try {
    await verifyScanner(executable)
    return executable
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(directory, randomUUID() + '.download')
  try {
    const response = await fetch(scannerRelease.url, { signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]) })
    if (!response.ok || !response.body) throw new Error(`Scanner download failed: HTTP ${response.status}`)
    let bytes = 0
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          callback(bytes > scannerRelease.bytes ? new Error('Scanner download exceeds the pinned size') : null, chunk)
        },
      }),
      createWriteStream(temporary, { flags: 'wx' }),
    )
    await verifyScanner(temporary)
    await rename(temporary, executable)
    await writeFile(join(directory, 'source.json'), JSON.stringify(scannerRelease, null, 2))
    return executable
  } finally {
    await rm(temporary, { force: true })
  }
}
