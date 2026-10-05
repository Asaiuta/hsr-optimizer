const MAX_RETAINED_BYTES = 16 * 1024 * 1024
const MAX_RETAINED_BUFFERS = 64

type BufferPool = { free: GPUBuffer[], bytes: number, lost: boolean }
const pools = new WeakMap<GPUDevice, BufferPool>()

function getPool(device: GPUDevice): BufferPool {
  let pool = pools.get(device)
  if (!pool) {
    pool = { free: [], bytes: 0, lost: false }
    pools.set(device, pool)
    const owned = pool
    void device.lost.then(() => {
      owned.lost = true
      for (const buffer of owned.free) buffer.destroy()
      owned.free.length = 0
      owned.bytes = 0
    })
  }
  return pool
}

/** An exclusive lease. Return buffers only after the task's GPU error scopes pass. */
export class GpuBufferLease {
  private readonly pool: BufferPool
  private readonly buffers: GPUBuffer[] = []
  private released = false

  constructor(private readonly device: GPUDevice, private readonly reuse: boolean = true) {
    this.pool = getPool(device)
  }

  createBuffer = (descriptor: GPUBufferDescriptor): GPUBuffer => {
    if (this.released || this.pool.lost) throw new Error('GPU buffer lease is unavailable')
    // Exact size/usage preserves shader array lengths and binding validation.
    const index = this.reuse && !descriptor.mappedAtCreation
      ? this.pool.free.findIndex((buffer) => buffer.size === descriptor.size && buffer.usage === descriptor.usage)
      : -1
    const buffer = index < 0 ? this.device.createBuffer(descriptor) : this.pool.free.splice(index, 1)[0]
    if (index >= 0) this.pool.bytes -= buffer.size
    this.buffers.push(buffer)
    return buffer
  }

  release(reusable = false): void {
    if (this.released) return
    this.released = true
    for (const buffer of this.buffers) {
      if (!reusable || !this.reuse || this.pool.lost || buffer.mapState !== 'unmapped' || buffer.size > MAX_RETAINED_BYTES) {
        buffer.destroy()
        continue
      }
      while (this.pool.bytes + buffer.size > MAX_RETAINED_BYTES || this.pool.free.length >= MAX_RETAINED_BUFFERS) {
        const oldest = this.pool.free.shift()!
        this.pool.bytes -= oldest.size
        oldest.destroy()
      }
      this.pool.free.push(buffer)
      this.pool.bytes += buffer.size
    }
    this.buffers.length = 0
  }
}
