import i18next from 'i18next'
import {
  COMPUTE_ENGINE_CPU,
  Constants,
  type Parts,
} from 'lib/constants/constants'
import { SavedSessionKeys } from 'lib/constants/constantsSession'
import { getWebgpuDevice } from 'lib/gpu/webgpuDevice'
import { gpuOptimize } from 'lib/gpu/webgpuOptimizer'
import { type RelicsByPart } from 'lib/gpu/webgpuTypes'
import { Message } from 'lib/interactions/message'
import { webgpuCrashNotification } from 'lib/interactions/notifications'
import { createBatchCursor } from 'lib/optimization/batchCursor'
import { type OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import { generateContext } from 'lib/optimization/context/calculateContext'
import { createCpuResultRows } from 'lib/optimization/cpuResultRows'
import { formatOptimizerDisplayData } from 'lib/optimization/optimizerDisplayData'
import {
  applySemiJoinReduction,
  computeValidPermutationCount,
  generateOrnamentSetSolutions,
  generateRelicSetSolutions,
} from 'lib/optimization/relicSetSolver'
import {
  createResultTieOrder,
  OptimizerResultQueue,
} from 'lib/optimization/resultTieOrder'
import { bitpackBooleanArray } from 'lib/optimization/setSolutionBitset'
import { SortOption } from 'lib/optimization/sortOptions'
import {
  type PartCountsBySet,
  RelicFilters,
  zeroCountsBySet,
} from 'lib/relics/relicFilters'
import {
  OrnamentSetToIndex,
  RelicSetToIndex,
  type SetsOrnaments,
  type SetsRelics,
} from 'lib/sets/setConfigRegistry'
import { logRegisters } from 'lib/simulations/registerLogger'
import { simulateBuild } from 'lib/simulations/simulateBuild'
import {
  type SimulationRelic,
  type SimulationRelicArrayByPart,
  type SimulationRelicByPart,
} from 'lib/simulations/statSimulationTypes'
import { useGlobalStore } from 'lib/stores/app/appStore'
import { getCharacterById } from 'lib/stores/character/characterStore'
import { setSortColumn } from 'lib/stores/gridStore'
import { gridStore } from 'lib/stores/gridStore'
import {
  finishOptimizationRun,
  isOptimizationRunActive,
  ownsOptimizationRun,
  useOptimizerDisplayStore,
} from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import {
  activateZeroPermutationsSuggestionsModal,
  activateZeroResultSuggestionsModal,
} from 'lib/tabs/tabOptimizer/OptimizerSuggestionsModal'
import { OptimizerTabController } from 'lib/tabs/tabOptimizer/optimizerTabController'
import { sleep } from 'lib/utils/frontendUtils'
import { clone } from 'lib/utils/objectUtils'
import type {
  OptimizerWorkerInput,
  OptimizerWorkerResult,
} from 'lib/worker/optimizerWorker'
import { prepareOptimizerWorkerRelics } from 'lib/worker/optimizerWorkerRelics'
import {
  WorkerCancelledError,
  workerPool,
} from 'lib/worker/workerPool'
import { WorkerType } from 'lib/worker/workerUtils'
import {
  type Form,
  type OptimizerForm,
} from 'types/form'
import type { OptimizerContext } from 'types/optimizer'

function countRelicsBySet(relicsByPart: RelicsByPart): PartCountsBySet {
  const out = zeroCountsBySet()
  for (const r of relicsByPart.Head) out.Head[RelicSetToIndex[r.set as SetsRelics]]++
  for (const r of relicsByPart.Hands) out.Hands[RelicSetToIndex[r.set as SetsRelics]]++
  for (const r of relicsByPart.Body) out.Body[RelicSetToIndex[r.set as SetsRelics]]++
  for (const r of relicsByPart.Feet) out.Feet[RelicSetToIndex[r.set as SetsRelics]]++
  for (const r of relicsByPart.PlanarSphere) out.PlanarSphere[OrnamentSetToIndex[r.set as SetsOrnaments]]++
  for (const r of relicsByPart.LinkRope) out.LinkRope[OrnamentSetToIndex[r.set as SetsOrnaments]]++
  return out
}

export function calculateCurrentlyEquippedRow(request: OptimizerForm) {
  let relics = getRelics()
  relics = relics.filter((x) => x.equippedBy == request.characterId)
  relics = clone(relics)
  RelicFilters.calculateWeightScore(request, relics)
  relics = RelicFilters.applyMainStatsFilter(request, relics)
  const relicsByPart = RelicFilters.splitRelicsByPart(relics) as RelicsByPart | SimulationRelicByPart
  RelicFilters.condenseRelicSubstatsForOptimizer(relicsByPart as RelicsByPart)
  Object.keys(relicsByPart).map((key) =>
    (relicsByPart as SimulationRelicByPart)[key as Parts] = (relicsByPart as RelicsByPart)[key as Parts][0] as SimulationRelic
  )

  const context = generateContext(request)
  const { x } = simulateBuild(relicsByPart as SimulationRelicByPart, context, null)

  if (request.keepCurrentRelics) {
    logRegisters(x, context, 'Simulate Build')
  }

  const optimizerDisplayData = formatOptimizerDisplayData(x, useOptimizerDisplayStore.getState().context)
  OptimizerTabController.setTopRow(optimizerDisplayData, true)
  useOptimizerDisplayStore.getState().setOptimizerSelectedRowData(optimizerDisplayData)

  const character = getCharacterById(request.characterId)
  if (character) {
    useOptimizerDisplayStore.getState().setOptimizerBuild(character.equipped)
  }
}

export const Optimizer = {
  cancel: () => {
    const { optimizationId, optimizationInProgress } = useOptimizerDisplayStore.getState()
    if (!optimizationInProgress || !optimizationId) return
    finishOptimizationRun(optimizationId, { status: 'cancelled' })
    workerPool.cancelQueue(WorkerType.OPTIMIZER)
  },

  getFilteredRelicCounts: (request: Form) => RelicFilters.getFilteredRelicCounts(request),

  getFilteredRelics: (request: Form) => {
    let relics = getRelics()

    relics = RelicFilters.applyEquippedFilter(request, relics)
    relics = RelicFilters.applyEnhanceFilter(request, relics)
    relics = RelicFilters.applyGradeFilter(request, relics)
    relics = RelicFilters.applyRankFilter(request, relics)
    relics = RelicFilters.applyExcludeFilter(request, relics)

    // Pre-split filters
    const preFilteredRelicsByPart = RelicFilters.splitRelicsByPart(relics)

    relics = RelicFilters.applyMainFilter(request, relics)
    relics = clone(relics) // Past this point we modify relics, clone it first
    RelicFilters.mergePreviewSubstats(request, relics)
    relics = RelicFilters.applyMainStatsFilter(request, relics)
    relics = RelicFilters.applySetFilter(request, relics)

    // Post-split filters
    RelicFilters.calculateWeightScore(request, relics)
    let relicsByPart = RelicFilters.splitRelicsByPart(relics)

    relicsByPart = RelicFilters.applyCurrentFilter(request, relicsByPart)
    relicsByPart = RelicFilters.applyTopFilter(request, relicsByPart)

    return [relicsByPart, preFilteredRelicsByPart]
  },

  optimize: async function(request: Form) {
    const t = i18next.getFixedT(null, 'optimizerTab', 'ValidationMessages')

    const runId = request.optimizationId
    const ownsRun = () => ownsOptimizationRun(runId)

    // A newer run may take ownership before this deferred call starts.
    if (!isOptimizationRunActive(runId)) return

    // Cancel any in-progress optimization before starting a new one
    if (useOptimizerDisplayStore.getState().optimizationInProgress) {
      workerPool.cancelQueue(WorkerType.OPTIMIZER)
    }

    let [relics] = this.getFilteredRelics(request)
    RelicFilters.condenseRelicSubstatsForOptimizer(relics)

    const relicSetSolutions = generateRelicSetSolutions(request)
    const ornamentSetSolutions = generateOrnamentSetSolutions(request)

    // Semi-join reduction: eliminate relics whose set can't participate in any valid tuple
    const hasRelicFilter = (request.relicSets?.length ?? 0) > 0
    const hasOrnamentFilter = (request.ornamentSets?.length ?? 0) > 0
    if (hasRelicFilter || hasOrnamentFilter) {
      relics = applySemiJoinReduction(relics, relicSetSolutions, ornamentSetSolutions)
    }

    const sizes = {
      hSize: relics.Head.length,
      gSize: relics.Hands.length,
      bSize: relics.Body.length,
      fSize: relics.Feet.length,
      pSize: relics.PlanarSphere.length,
      lSize: relics.LinkRope.length,
    }

    const permutations = sizes.hSize * sizes.gSize * sizes.bSize * sizes.fSize * sizes.pSize * sizes.lSize
    OptimizerTabController.setMetadata(sizes, relics)

    // Valid permutations accounting for set constraints (may be less than naive slot-product)
    const relicsBySet = countRelicsBySet(relics)
    const validPermutations = computeValidPermutationCount(relicsBySet, relicSetSolutions, ornamentSetSolutions)
    const progressScale = permutations > 0 ? validPermutations / permutations : 0
    useOptimizerDisplayStore.getState().setPermutations(validPermutations)
    useOptimizerDisplayStore.getState().setPermutationsNaive(permutations)

    console.log(`Optimization permutations: ${permutations} (valid: ${validPermutations}), blocksize: ${Constants.THREAD_BUFFER_LENGTH}`)
    if (permutations == 0 || validPermutations == 0) {
      activateZeroPermutationsSuggestionsModal(request)
      OptimizerTabController.setRows([])
      OptimizerTabController.resetDataSource()
      finishOptimizationRun(runId, { status: 'completed' })
      return
    }

    OptimizerTabController.scrollToGrid()
    gridStore.optimizerGridApi()?.setGridOption('loading', true)

    const context = generateContext(request)

    useOptimizerDisplayStore.getState().setContext(context)

    let searched = 0
    let results = []

    const sortOption = SortOption[request.resultSort!]
    const showMemo = request.memoDisplay === 'memo'
      && context.defaultActions[context.defaultActions.length - 1].config.entitiesArray.some((entity) => entity.memosprite)
    const gridSortColumn = (request.statDisplay == 'combat'
      ? (showMemo ? sortOption.memoCombatGridColumn : sortOption.combatGridColumn)
      : (showMemo ? sortOption.memoBasicGridColumn : sortOption.basicGridColumn)) as keyof OptimizerDisplayData
    const resultsLimit = request.resultsLimit ?? 1024
    const tieOrder = createResultTieOrder(relics)
    const queueResults = new OptimizerResultQueue(resultsLimit, tieOrder)

    // Incrementally increase the optimization run sizes instead of having a fixed size, so it doesn't lag for 2 seconds on Start
    const computeEngine = useGlobalStore.getState().savedSession[SavedSessionKeys.computeEngine]

    if (computeEngine != COMPUTE_ENGINE_CPU) {
      try {
        // Yield the loading state without a fixed startup delay. Prepare the equipped row
        // before dispatch so a fast search cannot be followed by a late selection update.
        await sleep(0)
        if (!isOptimizationRunActive(runId)) return
        calculateCurrentlyEquippedRow(request)

        const device = await getWebgpuDevice(true)
        if (!isOptimizationRunActive(runId)) return
        if (device == null) {
          Message.error(t('Error.GPUNotAvailable'), 15)
          // GPU path won't run and CPU path already skipped — stop optimization
          finishOptimizationRun(runId, { status: 'failed', error: 'GPU acceleration is unavailable' })
        } else {
          await gpuOptimize({
            device,
            context: context,
            request: request,
            relics: relics,
            permutations: permutations,
            validPermutations: validPermutations,
            computeEngine: computeEngine,
            relicSetSolutions: relicSetSolutions,
            ornamentSetSolutions: ornamentSetSolutions,
          })
        }
      } catch (error) {
        console.error('WebGPU optimization failed:', error)
        if (!isOptimizationRunActive(runId)) return
        finishOptimizationRun(runId, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
        webgpuCrashNotification()
      }
    }

    if (computeEngine == COMPUTE_ENGINE_CPU) {
      setTimeout(() => {
        if (!ownsRun()) return
        calculateCurrentlyEquippedRow(request)
      }, 200)

      const batches = createBatchCursor(permutations, Constants.THREAD_BUFFER_LENGTH)
      const clonedContext = clone(context)
      const workerRelics = prepareOptimizerWorkerRelics(relics)
      const packedRelicSets = Uint32Array.from(bitpackBooleanArray(relicSetSolutions))
      const packedOrnamentSets = Uint32Array.from(bitpackBooleanArray(ornamentSetSolutions))
      let inProgress = 0

      useOptimizerDisplayStore.getState().setOptimizerStartTime(Date.now())
      useOptimizerDisplayStore.getState().setOptimizerRunningEngine(COMPUTE_ENGINE_CPU)

      function finalize() {
        if (!isOptimizationRunActive(runId)) return
        results = createCpuResultRows(queueResults.toResults().map((r) => r.index), relics as SimulationRelicArrayByPart, context)
        results.sort((a, b) => (b[gridSortColumn] as number) - (a[gridSortColumn] as number) || tieOrder.compareIndices(a.id, b.id))
        OptimizerTabController.setRows(results)
        setSortColumn(gridSortColumn)
        gridStore.optimizerGridApi()?.updateGridOptions({
          datasource: OptimizerTabController.getDataSource({ colId: gridSortColumn, sort: 'desc' }),
        })
        finishOptimizationRun(runId, { status: 'completed' })
      }

      function dispatchNextRun() {
        if (!isOptimizationRunActive(runId)) return
        const run = batches.next()
        if (!run) return
        inProgress++

        const taskInput = {
          context: clonedContext,
          request: request,
          relics: workerRelics,
          WIDTH: run.runSize,
          skip: run.skip,
          permutations: permutations,
          relicSetSolutions: packedRelicSets,
          ornamentSetSolutions: packedOrnamentSets,
          workerType: WorkerType.OPTIMIZER,
        } satisfies OptimizerWorkerInput

        workerPool.runTask<typeof taskInput, OptimizerWorkerResult>(taskInput, {
          maxRetries: 10,
          prepareInput: (input) => {
            // Rising min-filter floor: computed at dispatch time, not creation time.
            // As results accumulate from completed workers, later-dispatched tasks
            // get tighter thresholds and skip more permutations.
            input.request.resultMinFilter = queueResults.size() >= resultsLimit
              ? queueResults.topPriority()
              : Number.NEGATIVE_INFINITY
          },
        }).then((result) => {
          searched += run.runSize
          inProgress--

          if (!isOptimizationRunActive(runId)) return

          const candidates = result.candidates
          for (let i = 0; i < candidates.length; i += 2) {
            queueResults.fixedSizePush(candidates[i], candidates[i + 1])
          }

          // Rescale searched count into valid-permutation space for progress display
          useOptimizerDisplayStore.setState({
            permutationsResults: queueResults.size(),
            permutationsSearched: Math.min(validPermutations, Math.round(searched * progressScale)),
            optimizerProgress: searched / permutations,
            optimizerEndTime: Date.now(),
          })

          if (inProgress === 0 && !batches.hasNext()) {
            finalize()
            console.log('Done', results.length)
            if (!results.length && !inProgress) activateZeroResultSuggestionsModal(request)
            return
          }

          dispatchNextRun()
        }).catch((error) => {
          // Guard against cancellation — cancelQueue() and terminate() reject with
          // WorkerCancelledError. Don't decrement inProgress or create buffers for these.
          if (!isOptimizationRunActive(runId)) return
          if (error instanceof WorkerCancelledError) {
            finishOptimizationRun(runId, { status: 'cancelled' })
            return
          }
          console.warn('Optimizer worker error:', error)
          inProgress--
          // An exhausted worker retry means an incomplete search, never a successful optimum.
          finishOptimizationRun(runId, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
          workerPool.cancelQueue(WorkerType.OPTIMIZER)
        })
      }

      // Seed pool with initial tasks — one per available worker
      const initialBatch = workerPool.getPoolSize()
      for (let i = 0; i < initialBatch; i++) {
        dispatchNextRun()
      }
    }
  },
}
