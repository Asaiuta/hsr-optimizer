import { GpuBufferLease } from 'lib/gpu/webgpuBufferPool'
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest'

function fixture() {
  const lost = Promise.withResolvers<GPUDeviceLostInfo>()
  const device = {
    lost: lost.promise,
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({
      size: descriptor.size,
      usage: descriptor.usage,
      mapState: descriptor.mappedAtCreation ? 'mapped' : 'unmapped',
      destroy: vi.fn(),
    })),
  } as unknown as GPUDevice
  return { device, lost, lease: () => new GpuBufferLease(device) }
}

describe('device buffer leases', () => {
  it('reuses exact descriptors exclusively, keeping checked-out buffers private', () => {
    const { device, lease } = fixture()
    const a = lease(), b = lease()
    const descriptor = { size: 64, usage: 4 }
    const first = a.createBuffer(descriptor), second = b.createBuffer(descriptor)
    expect(first).not.toBe(second)
    a.release(true)
    const c = lease()
    expect(c.createBuffer({ size: 128, usage: 4 })).not.toBe(first)
    expect(c.createBuffer({ size: 64, usage: 8 })).not.toBe(first)
    expect(c.createBuffer(descriptor)).toBe(first)
    expect(device.createBuffer).toHaveBeenCalledTimes(4)
    a.release(true)
    expect(lease().createBuffer(descriptor)).not.toBe(first)
    b.release()
    c.release()
  })

  it('destroys failed, mapped and pending buffers instead of recycling them', () => {
    const { lease } = fixture()
    for (const mapState of ['unmapped', 'mapped', 'pending'] as const) {
      const a = lease(), buffer = a.createBuffer({ size: 16, usage: 4 })
      Object.assign(buffer, { mapState })
      a.release(mapState !== 'unmapped')
      expect(buffer.destroy).toHaveBeenCalledTimes(1)
    }
  })

  it('bounds retained bytes and buffer count, evicting oldest entries', () => {
    const { lease } = fixture()
    const a = lease()
    const first = a.createBuffer({ size: 12 * 1024 * 1024, usage: 4 })
    const second = a.createBuffer({ size: 12 * 1024 * 1024, usage: 4 })
    const oversized = a.createBuffer({ size: 17 * 1024 * 1024, usage: 4 })
    a.release(true)
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(second.destroy).not.toHaveBeenCalled()
    expect(oversized.destroy).toHaveBeenCalledOnce()
    const b = lease()
    const small = Array.from({ length: 65 }, () => b.createBuffer({ size: 4, usage: 4 }))
    b.release(true)
    expect(second.destroy).toHaveBeenCalledOnce()
    expect(small[0].destroy).toHaveBeenCalledOnce()
    expect(small[1].destroy).not.toHaveBeenCalled()
  })

  it('destroys idle and checked-out buffers on loss and rejects old-device allocation', async () => {
    const { lost, lease } = fixture()
    const a = lease(), b = lease()
    const idle = a.createBuffer({ size: 4, usage: 4 }), active = b.createBuffer({ size: 8, usage: 4 })
    a.release(true)
    lost.resolve({ reason: 'destroyed', message: '' } as GPUDeviceLostInfo)
    await lost.promise
    expect(idle.destroy).toHaveBeenCalledOnce()
    b.release(true)
    expect(active.destroy).toHaveBeenCalledOnce()
    expect(() => lease().createBuffer({ size: 4, usage: 4 })).toThrow('unavailable')
  })

  it('keeps devices and diagnostic leases isolated', () => {
    const { device, lease } = fixture()
    const a = lease(), buffer = a.createBuffer({ size: 4, usage: 4 })
    a.release(true)
    const diagnostic = new GpuBufferLease(device, false)
    const other = diagnostic.createBuffer({ size: 4, usage: 4 })
    expect(other).not.toBe(buffer)
    diagnostic.release(true)
    expect(other.destroy).toHaveBeenCalledOnce()
    expect(fixture().lease().createBuffer({ size: 4, usage: 4 })).not.toBe(buffer)
    expect(lease().createBuffer({ size: 4, usage: 4 })).toBe(buffer)
  })
})
