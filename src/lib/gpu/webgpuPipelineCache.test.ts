import { getComputePipeline } from 'lib/gpu/webgpuPipelineCache'
import {
  expect,
  it,
  vi,
} from 'vitest'

function fixture() {
  const lost = Promise.withResolvers<GPUDeviceLostInfo>()
  const compile = vi.fn(async () => ({} as GPUComputePipeline))
  const module = vi.fn(() => ({} as GPUShaderModule))
  const device = { lost: lost.promise, createComputePipelineAsync: compile, createShaderModule: module } as unknown as GPUDevice
  return { device, lost, compile, module }
}

it('shares pending and completed compilation for exact source on the same device', async () => {
  const { device, compile, module } = fixture()
  const a = getComputePipeline(device, 'shader A'), b = getComputePipeline(device, 'shader A')
  expect(a).toBe(b)
  expect(await a).toBe(await getComputePipeline(device, 'shader A'))
  expect(compile).toHaveBeenCalledTimes(1)
  expect(module).toHaveBeenCalledWith({ code: 'shader A' })
  expect(compile).toHaveBeenCalledWith({ layout: 'auto', compute: { module: expect.anything(), entryPoint: 'main' } })
})

it('does not reuse a pipeline across shader differences or different devices', async () => {
  const a = fixture(), b = fixture()
  const original = await getComputePipeline(a.device, 'shader A')
  expect(await getComputePipeline(a.device, 'shader B')).not.toBe(original)
  expect(await getComputePipeline(b.device, 'shader A')).not.toBe(original)
  expect(a.compile).toHaveBeenCalledTimes(2)
  expect(b.compile).toHaveBeenCalledTimes(1)
})

it('removes failed compilation so the same shader can retry', async () => {
  const { device, compile } = fixture()
  compile.mockRejectedValueOnce(new Error('Compile failed'))
  await expect(getComputePipeline(device, 'A')).rejects.toThrow('Compile failed')
  await expect(getComputePipeline(device, 'A')).resolves.toBeDefined()
  expect(compile).toHaveBeenCalledTimes(2)
})

it('bounds each device cache and retains recently used shaders', async () => {
  const { device, compile } = fixture()
  const first = await getComputePipeline(device, '0')
  for (let i = 1; i < 8; i++) await getComputePipeline(device, String(i))
  expect(await getComputePipeline(device, '0')).toBe(first)
  await getComputePipeline(device, '8')
  expect(await getComputePipeline(device, '0')).toBe(first)
  await getComputePipeline(device, '1')
  expect(compile).toHaveBeenCalledTimes(10)
})

it('an evicted pending failure cannot remove a newer entry for the same shader', async () => {
  const { device, compile } = fixture()
  const pending = Promise.withResolvers<GPUComputePipeline>()
  compile.mockReturnValueOnce(pending.promise)
  const old = getComputePipeline(device, '0')
  const rejected = expect(old).rejects.toThrow('Old failure')
  for (let i = 1; i <= 8; i++) await getComputePipeline(device, String(i))
  const replacement = await getComputePipeline(device, '0')
  pending.reject(new Error('Old failure'))
  await rejected
  expect(await getComputePipeline(device, '0')).toBe(replacement)
  expect(compile).toHaveBeenCalledTimes(10)
})

it('invalidates cached pipelines on device loss', async () => {
  const { device, lost, compile } = fixture()
  await getComputePipeline(device, 'A')
  lost.resolve({ reason: 'destroyed', message: 'test' } as GPUDeviceLostInfo)
  await lost.promise
  await expect(getComputePipeline(device, 'A')).rejects.toThrow('device is lost')
  expect(compile).toHaveBeenCalledTimes(1)
})
