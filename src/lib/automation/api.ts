import {
  allocateBatch,
  batchResults,
  cancelBatch,
  getBatch,
  saveBatchResult,
  startBatch,
} from 'lib/automation/batches'
import {
  checkBuilds,
  deleteBuild,
  equipBuilds,
  listBuilds,
  saveBuild,
} from 'lib/automation/builds'
import {
  getResources,
  listCharacters,
  listLightCones,
} from 'lib/automation/catalog'
import {
  AutomationError,
  type AutomationResponse,
  type CommandName,
  commandSchemas,
  describeCommands,
} from 'lib/automation/contracts'
import {
  compareInventory,
  inventoryRevision,
  parseSave,
} from 'lib/automation/inventory'
import {
  cancelJob,
  getJob,
  getResults,
  requireIdle,
  saveResult,
  startJob,
} from 'lib/automation/jobs'
import { resolveRequest } from 'lib/automation/request'
import { importScan } from 'lib/automation/scans'
import {
  compare,
  simulate,
} from 'lib/automation/simulation'
import { loadSaveData } from 'lib/services/persistenceService'
import { SaveState } from 'lib/state/saveState'
import { getCharacters } from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import type { HsrOptimizerSaveFormat } from 'types/store'
import { ZodError } from 'zod'

export { describeCommands }

export function executeCommand(name: string, input: unknown = {}): AutomationResponse {
  try {
    if (!Object.hasOwn(commandSchemas, name)) throw new AutomationError('UNKNOWN_COMMAND', 'Unknown command: ' + name)
    return { ok: true, data: dispatch(name as CommandName, input) }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof AutomationError ? error.code : error instanceof ZodError || error instanceof SyntaxError ? 'INVALID_INPUT' : 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function dispatch(name: CommandName, input: unknown): unknown {
  switch (name) {
    case 'list_characters':
      return listCharacters(commandSchemas[name].parse(input).includeUnimported)
    case 'list_relics': {
      const args = commandSchemas[name].parse(input)
      const results = []
      let total = 0
      for (const relic of getRelics()) {
        if (args.equippedBy && relic.equippedBy !== args.equippedBy || args.part && relic.part !== args.part) continue
        if (total >= args.offset && results.length < args.limit) {
          results.push({
            id: relic.id,
            part: relic.part,
            set: relic.set,
            grade: relic.grade,
            enhance: relic.enhance,
            main: relic.main,
            substats: relic.substats,
            previewSubstats: relic.previewSubstats,
            equippedBy: relic.equippedBy,
          })
        }
        total++
      }
      return { inventoryRevision: inventoryRevision(), total, offset: args.offset, relics: structuredClone(results) }
    }
    case 'list_light_cones': {
      const args = commandSchemas[name].parse(input)
      return listLightCones(args.offset, args.limit, args.path, args.ownedOnly)
    }
    case 'get_resources': {
      const args = commandSchemas[name].parse(input)
      return getResources(args.offset, args.limit)
    }
    case 'get_request':
      return { inventoryRevision: inventoryRevision(), settings: resolveRequest(commandSchemas[name].parse(input)).state }
    case 'simulate_build': {
      requireIdle()
      return simulate(commandSchemas[name].parse(input))
    }
    case 'compare_builds': {
      requireIdle()
      const args = commandSchemas[name].parse(input)
      return compare(args.baseline, args.candidates)
    }
    case 'start_optimization':
      return startJob(commandSchemas[name].parse(input))
    case 'get_job':
      return getJob(commandSchemas[name].parse(input).jobId)
    case 'get_results': {
      const args = commandSchemas[name].parse(input)
      return getResults(args.jobId, args.offset, args.limit)
    }
    case 'cancel_job':
      return cancelJob(commandSchemas[name].parse(input).jobId)
    case 'save_result': {
      const args = commandSchemas[name].parse(input)
      return saveResult(args.jobId, args.index, args.name)
    }
    case 'list_builds': {
      const args = commandSchemas[name].parse(input)
      return listBuilds(args.characterId, args.offset, args.limit)
    }
    case 'save_build': {
      requireIdle()
      return saveBuild(commandSchemas[name].parse(input))
    }
    case 'delete_build': {
      requireIdle()
      const args = commandSchemas[name].parse(input)
      return deleteBuild(args.characterId, args.name)
    }
    case 'check_builds':
      return checkBuilds(commandSchemas[name].parse(input).assignments)
    case 'equip_builds': {
      requireIdle()
      return equipBuilds(commandSchemas[name].parse(input))
    }
    case 'import_save': {
      requireIdle()
      const save = parseSave(commandSchemas[name].parse(input).json)
      const previous = SaveState.save()
      try {
        loadSaveData(save, false)
        SaveState.permitEmptySave()
        SaveState.save()
      } catch (error) {
        if (previous) loadSaveData(JSON.parse(previous) as HsrOptimizerSaveFormat, false)
        throw error
      }
      return { inventoryRevision: inventoryRevision(), characters: getCharacters().length, relics: getRelics().length }
    }
    case 'import_scan': {
      requireIdle()
      return importScan(commandSchemas[name].parse(input).json)
    }
    case 'compare_inventory': {
      const args = commandSchemas[name].parse(input)
      return compareInventory(args.json, args.offset, args.limit)
    }
    case 'export_save': {
      commandSchemas[name].parse(input)
      return SaveState.save()
    }
    case 'start_batch':
      return startBatch(commandSchemas[name].parse(input))
    case 'get_batch':
      return getBatch(commandSchemas[name].parse(input).batchId)
    case 'get_batch_results': {
      const args = commandSchemas[name].parse(input)
      return batchResults(args.batchId, args.requestIndex, args.offset, args.limit)
    }
    case 'cancel_batch':
      return cancelBatch(commandSchemas[name].parse(input).batchId)
    case 'save_batch_result': {
      const args = commandSchemas[name].parse(input)
      return saveBatchResult(args.batchId, args.requestIndex, args.index, args.name)
    }
    case 'allocate_batch':
      return allocateBatch(commandSchemas[name].parse(input))
  }
}
