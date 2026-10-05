import { commandSchemas } from 'lib/automation/contracts'
import { parseSave } from 'lib/automation/core/save'
import {
  compare,
  simulate,
} from 'lib/automation/core/simulation'
import { RelicAugmenter } from 'lib/relics/relicAugmenter'
import { Metadata } from 'lib/state/metadataInitializer'
import { useScoringStore } from 'lib/stores/scoring/scoringStore'
import {
  readFile,
  stat,
} from 'node:fs/promises'

async function readJsonFile(path: string) {
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('Input exceeds 32 MiB')
  return readFile(path, 'utf8')
}

try {
  const [command, savePath, requestPath, ...extra] = process.argv.slice(2)
  if (!['simulate_build', 'compare_builds'].includes(command) || !savePath || !requestPath || extra.length) {
    throw new Error('Usage: node output/headless/automation-headless.mjs <simulate_build|compare_builds> <save.json> <request.json>')
  }
  const started = performance.now()
  Metadata.initialize()
  const save = parseSave(await readJsonFile(savePath))
  useScoringStore.getState().setScoringMetadataOverrides(save.scoringMetadataOverrides ?? {})
  const relics = Object.fromEntries(save.relics.map((relic) => {
    const augmented = RelicAugmenter.augment(relic)
    if (!augmented) throw new Error(`Cannot initialize relic ${relic.id}`)
    return [augmented.id, augmented]
  }))
  const request: unknown = JSON.parse(await readJsonFile(requestPath))
  const data = command === 'simulate_build'
    ? simulate(commandSchemas.simulate_build.parse(request), save.characters, relics)
    : (() => {
      const input = commandSchemas.compare_builds.parse(request)
      return compare(input.baseline, input.candidates, save.characters, relics)
    })()
  process.stdout.write(JSON.stringify({ ok: true, data }) + '\n')
  process.stderr.write(
    JSON.stringify({ runtime: 'node', executionMs: performance.now() - started, processUptimeMs: process.uptime() * 1000, rssBytes: process.memoryUsage().rss })
      + '\n',
  )
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } }) + '\n')
  process.exitCode = 1
}
