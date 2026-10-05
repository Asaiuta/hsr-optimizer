import type { getWebgpuDevice as getDevice } from 'lib/gpu/webgpuDevice'
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest'

vi.mock('lib/interactions/notifications', () => ({ webgpuNotSupportedNotification: vi.fn() }))
vi.mock('lib/state/saveState', () => ({ SaveState: { delayedSave: vi.fn() } }))
vi.mock('lib/stores/app/appStore', () => ({ useGlobalStore: { getState: () => ({ setSavedSessionKey: vi.fn() }) } }))

let getWebgpuDevice: typeof getDevice
const lost = () => Promise.withResolvers<GPUDeviceLostInfo>()
function device() {
  const loss = lost()
  return { value: { lost: loss.promise } as GPUDevice, loss }
}
const adapter = { requestDevice: vi.fn() }
const requestAdapter = vi.fn()

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubGlobal('navigator', { gpu: { requestAdapter } })
  requestAdapter.mockResolvedValue(adapter)
  getWebgpuDevice = (await import('./webgpuDevice')).getWebgpuDevice
})
afterEach(() => vi.unstubAllGlobals())

it('shares in-flight acquisition and then reuses the same live device', async () => {
  const pending = Promise.withResolvers<GPUDevice>()
  const first = device()
  adapter.requestDevice.mockReturnValue(pending.promise)
  const a = getWebgpuDevice(), b = getWebgpuDevice()
  pending.resolve(first.value)
  expect(await a).toBe(first.value)
  expect(await b).toBe(first.value)
  expect(await getWebgpuDevice()).toBe(first.value)
  expect(requestAdapter).toHaveBeenCalledTimes(1)
  expect(adapter.requestDevice).toHaveBeenCalledTimes(1)
})

it('retries after an unavailable adapter or rejected device request', async () => {
  requestAdapter.mockResolvedValueOnce(null)
  expect(await getWebgpuDevice()).toBeUndefined()
  adapter.requestDevice.mockRejectedValueOnce(new Error('Device unavailable'))
  expect(await getWebgpuDevice()).toBeUndefined()
  const next = device()
  adapter.requestDevice.mockResolvedValue(next.value)
  expect(await getWebgpuDevice()).toBe(next.value)
  expect(requestAdapter).toHaveBeenCalledTimes(3)
})

it('reacquires after loss and shares the replacement request', async () => {
  const first = device(), replacement = device()
  adapter.requestDevice.mockResolvedValueOnce(first.value).mockResolvedValueOnce(replacement.value)
  expect(await getWebgpuDevice()).toBe(first.value)
  first.loss.resolve({ reason: 'destroyed', message: 'test' } as GPUDeviceLostInfo)
  await first.loss.promise
  const [a, b] = await Promise.all([getWebgpuDevice(), getWebgpuDevice()])
  expect(a).toBe(replacement.value)
  expect(b).toBe(replacement.value)
  expect(adapter.requestDevice).toHaveBeenCalledTimes(2)
})

it('keeps diagnostic devices separate and their loss cannot invalidate the shared device', async () => {
  const shared = device(), diagnostic = device()
  adapter.requestDevice.mockResolvedValueOnce(shared.value).mockResolvedValueOnce(diagnostic.value)
  expect(await getWebgpuDevice()).toBe(shared.value)
  expect(await getWebgpuDevice(undefined, { reuse: false })).toBe(diagnostic.value)
  diagnostic.loss.resolve({ reason: 'destroyed', message: 'test' } as GPUDeviceLostInfo)
  await diagnostic.loss.promise
  expect(await getWebgpuDevice()).toBe(shared.value)
  expect(adapter.requestDevice).toHaveBeenCalledTimes(2)
})

it('preserves per-caller failure notification without duplicate acquisition', async () => {
  requestAdapter.mockResolvedValue(null)
  const { webgpuNotSupportedNotification } = await import('lib/interactions/notifications')
  await Promise.all([getWebgpuDevice(false), getWebgpuDevice(true)])
  expect(requestAdapter).toHaveBeenCalledTimes(1)
  expect(webgpuNotSupportedNotification).toHaveBeenCalledTimes(1)
})
