// Layout and entry point are fixed below; the remaining pipeline identity is the device and exact WGSL.
const MAX_PIPELINES_PER_DEVICE = 8
const caches = new WeakMap<GPUDevice, Map<string, Promise<GPUComputePipeline>>>()
const lostDevices = new WeakSet<GPUDevice>()

export function getComputePipeline(device: GPUDevice, wgsl: string): Promise<GPUComputePipeline> {
  if (lostDevices.has(device)) return Promise.reject(new Error('WebGPU device is lost'))
  let cache = caches.get(device)
  if (!cache) {
    cache = new Map()
    caches.set(device, cache)
    const ownedCache = cache
    void device.lost.then(() => {
      lostDevices.add(device)
      ownedCache.clear()
      caches.delete(device)
    })
  }
  const hit = cache.get(wgsl)
  if (hit) {
    cache.delete(wgsl)
    cache.set(wgsl, hit)
    return hit
  }
  // Share in-flight compilation too. Rejected entries must not poison subsequent requests.
  const pending = compilePipeline(device, wgsl)
  cache.set(wgsl, pending)
  if (cache.size > MAX_PIPELINES_PER_DEVICE) cache.delete(cache.keys().next().value!)
  const ownedCache = cache
  void pending.catch(() => {
    if (ownedCache.get(wgsl) === pending) ownedCache.delete(wgsl)
  })
  return pending
}

async function compilePipeline(device: GPUDevice, wgsl: string): Promise<GPUComputePipeline> {
  return device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: wgsl }), entryPoint: 'main' },
  })
}
