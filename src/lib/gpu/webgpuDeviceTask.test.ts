import { runGpuDeviceTask } from 'lib/gpu/webgpuDeviceTask'
import {
  expect,
  it,
  vi,
} from 'vitest'

function fixture() {
  const push = vi.fn(), pop = vi.fn(async (): Promise<GPUError | null> => null)
  return { device: { pushErrorScope: push, popErrorScope: pop } as unknown as GPUDevice, push, pop }
}

it('waits for the previous task and its scopes before allowing a new task onto the device', async () => {
  const { device, push, pop } = fixture()
  const operation = Promise.withResolvers<void>(), errorCheck = Promise.withResolvers<GPUError | null>()
  pop.mockReturnValueOnce(errorCheck.promise)
  const first = runGpuDeviceTask(device, () => operation.promise)
  const next = vi.fn(async () => 'next')
  const second = runGpuDeviceTask(device, next)
  await Promise.resolve()
  expect(push.mock.calls.flat()).toEqual(['out-of-memory', 'internal', 'validation'])
  operation.resolve()
  await Promise.resolve()
  expect(next).not.toHaveBeenCalled()
  errorCheck.resolve(null)
  await first
  expect(await second).toBe('next')
  expect(pop).toHaveBeenCalledTimes(6)
})

it('attributes a delayed GPU error to the old task and permits the next task', async () => {
  const { device, pop } = fixture()
  pop.mockResolvedValueOnce({ message: 'Old validation error' })
  const first = runGpuDeviceTask(device, async () => 1)
  const second = runGpuDeviceTask(device, async () => 2)
  await expect(first).rejects.toThrow('Old validation error')
  await expect(second).resolves.toBe(2)
})

it('releases scopes and admission after a thrown task', async () => {
  const { device, pop } = fixture()
  await expect(runGpuDeviceTask(device, async () => {
    throw new Error('Failed')
  })).rejects.toThrow('Failed')
  expect(pop).toHaveBeenCalledTimes(3)
  await expect(runGpuDeviceTask(device, async () => 2)).resolves.toBe(2)
})

it('pops all scopes and permits recovery even when a pop rejects', async () => {
  const { device, pop } = fixture()
  pop.mockRejectedValueOnce(new Error('Device lost'))
  await expect(runGpuDeviceTask(device, async () => 1)).rejects.toThrow('Device lost')
  expect(pop).toHaveBeenCalledTimes(3)
  await expect(runGpuDeviceTask(device, async () => 2)).resolves.toBe(2)
})

it('does not serialize independent devices', async () => {
  const a = fixture(), b = fixture(), pending = Promise.withResolvers<number>()
  const first = runGpuDeviceTask(a.device, () => pending.promise)
  expect(await runGpuDeviceTask(b.device, async () => 2)).toBe(2)
  pending.resolve(1)
  expect(await first).toBe(1)
})
