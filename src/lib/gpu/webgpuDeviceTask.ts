const tails = new WeakMap<GPUDevice, Promise<void>>()

/** Keep error scopes and cleanup owned by one task, including cancelled work still on the device. */
export async function runGpuDeviceTask<T>(device: GPUDevice, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(device)
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  tails.set(device, tail)
  try {
    await previous
    device.pushErrorScope('out-of-memory')
    device.pushErrorScope('internal')
    device.pushErrorScope('validation')
    let result: T
    let errors: (GPUError | null)[]
    try {
      result = await task()
    } finally {
      // Pop all scopes before awaiting, so a rejected pop cannot leave the stack unbalanced.
      errors = await Promise.all([device.popErrorScope(), device.popErrorScope(), device.popErrorScope()])
    }
    const error = errors.find((entry) => entry !== null)
    if (error) throw new Error(error.message)
    return result
  } finally {
    release()
    if (tails.get(device) === tail) tails.delete(device)
  }
}
