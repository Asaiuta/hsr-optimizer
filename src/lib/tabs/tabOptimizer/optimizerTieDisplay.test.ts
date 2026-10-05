// @vitest-environment jsdom
import type { IGetRowsParams } from 'ag-grid-community'
import type { RelicsByPart } from 'lib/gpu/webgpuTypes'
import type { OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import { RESULT_PARTS } from 'lib/optimization/resultTieOrder'
import { gridStore } from 'lib/stores/gridStore'
import {
  expect,
  it,
  vi,
} from 'vitest'
import { OptimizerTabController } from './optimizerTabController'

it('retains GPU selection scores on target-column resort and clears them with new rows', () => {
  vi.spyOn(gridStore, 'optimizerGridApi').mockReturnValue({ setGridOption() {}, getPinnedTopRow() {} } as never)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  try {
    const relics = Object.fromEntries(RESULT_PARTS.map((part) => [part, [{ id: `${part}-a` }]])) as RelicsByPart
    relics.Head = [{ id: 'b' }, { id: 'a' }] as RelicsByPart['Head']
    OptimizerTabController.setMetadata({ hSize: 2, gSize: 1, bSize: 1, fSize: 1, pSize: 1, lSize: 1 }, relics)
    const rows = [{ id: 0, SPD: 1 + 2 ** -25, HP: 10 }, { id: 1, SPD: 1, HP: 9 }] as OptimizerDisplayData[]
    OptimizerTabController.setRows(rows, { column: 'SPD', scores: new Map([[0, 1], [1, 1]]) })
    const data = OptimizerTabController.getDataSource({ colId: '', sort: null })
    const sort = (colId: string) =>
      data.getRows({ sortModel: [{ colId, sort: 'desc' }], startRow: 0, endRow: 2, successCallback() {} } as unknown as IGetRowsParams)
    sort('SPD')
    expect(OptimizerTabController.getRows().map((r) => r.id)).toEqual([1, 0])
    sort('HP')
    expect(OptimizerTabController.getRows().map((r) => r.id)).toEqual([0, 1])
    sort('SPD')
    expect(OptimizerTabController.getRows().map((r) => r.id)).toEqual([1, 0])
    OptimizerTabController.setRows([...rows])
    sort('HP')
    sort('SPD')
    expect(OptimizerTabController.getRows().map((r) => r.id)).toEqual([0, 1])
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
