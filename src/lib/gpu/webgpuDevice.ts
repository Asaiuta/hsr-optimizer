import { COMPUTE_ENGINE_CPU } from 'lib/constants/constants'
import { SavedSessionKeys } from 'lib/constants/constantsSession'
import { webgpuNotSupportedNotification } from 'lib/interactions/notifications'
import { SaveState } from 'lib/state/saveState'
import { useGlobalStore } from 'lib/stores/app/appStore'

// Firefox and some GPUs require storage address space — uniform array<f32> violates the 16-byte stride
// requirement unless the 'uniform_buffer_standard_layout' feature is supported.
export function uniformCompatible(): boolean {
  return navigator.gpu?.wgslLanguageFeatures?.has('uniform_buffer_standard_layout') ?? false
}

let sharedDevice: Promise<GPUDevice> | undefined

async function requestDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('WebGPU adapter not available')
  return adapter.requestDevice({ requiredLimits: {} })
}

export async function getWebgpuDevice(notify?: boolean, options: { reuse?: boolean } = {}) {
  try {
    // Diagnostic tests keep a dedicated device so their work cannot enter an optimizer error scope.
    if (options.reuse === false) return await requestDevice()
    if (!sharedDevice) {
      const pending = requestDevice()
      sharedDevice = pending
      const invalidate = () => {
        if (sharedDevice === pending) sharedDevice = undefined
      }
      void pending.then((device) => {
        void device.lost.then(invalidate)
      }, invalidate)
    }
    return await sharedDevice
  } catch (e) {
    if (notify) {
      console.error('Webgpu not supported', e)
      webgpuNotSupportedNotification()
    }
  }
}

export async function verifyWebgpuSupport(warn: boolean) {
  try {
    const device = await getWebgpuDevice(warn)
    if (!device) {
      // GPU unavailable at startup — no chance of recovery, so persist CPU so it survives reloads
      useGlobalStore.getState().setSavedSessionKey(SavedSessionKeys.computeEngine, COMPUTE_ENGINE_CPU)
      SaveState.delayedSave()
    }
    return device
  } catch (e) {
    console.log(e)
    return null
  }
}
