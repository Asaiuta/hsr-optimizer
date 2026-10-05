import type * as ApiModule from 'lib/automation/api'
import type {
  AutomationResponse,
  describeCommands,
} from 'lib/automation/contracts'
import {
  summarizeAutomationValue,
  type AutomationMirrorEvent,
} from 'lib/automation/mirror'

export type AutomationApi = {
  version: 1,
  describe: () => Promise<ReturnType<typeof describeCommands>>,
  call: (name: string, input?: unknown) => Promise<AutomationResponse>,
}

declare global {
  interface Window {
    hsrAutomation: AutomationApi
    /** Optional hook injected by the MCP bridge; emits mirror events for the in-app live viewer. */
    __hsrAutomationMirror?: (event: AutomationMirrorEvent) => void
  }
}

/** One lazy module. No sockets, workers, polling or schema construction until first use. */
export function installAutomation() {
  let module: Promise<typeof ApiModule> | undefined
  const load = () => module ??= import('./api')

  // Mirroring must never break or slow down a call; the hook is absent outside the MCP browser.
  const emit = (event: AutomationMirrorEvent) => {
    try {
      window.__hsrAutomationMirror?.(event)
    } catch {
      // Ignore hook failures.
    }
  }
  const mirrorCall = async (name: string, input: unknown, run: () => Promise<AutomationResponse>): Promise<AutomationResponse> => {
    const started = Date.now()
    let response: AutomationResponse | undefined
    try {
      response = await run()
      return response
    } finally {
      if (response) {
        emit({
          ts: started,
          name,
          ok: response.ok,
          errorCode: response.ok ? undefined : response.error.code,
          errorMessage: response.ok ? undefined : summarizeAutomationValue(response.error.message) as string | undefined,
          durationMs: Date.now() - started,
          input: summarizeAutomationValue(input),
          data: response.ok ? summarizeAutomationValue(response.data) : undefined,
        })
      } else {
        emit({
          ts: started,
          name,
          ok: false,
          errorCode: 'BRIDGE_ERROR',
          durationMs: Date.now() - started,
          input: summarizeAutomationValue(input),
        })
      }
    }
  }
  const mirrorDescribe = async () => {
    const started = Date.now()
    try {
      const commands = await (await load()).describeCommands()
      emit({
        ts: started,
        name: 'describe',
        ok: true,
        durationMs: Date.now() - started,
        input: {},
        data: summarizeAutomationValue(commands),
      })
      return commands
    } catch (error) {
      emit({
        ts: started,
        name: 'describe',
        ok: false,
        errorCode: 'BRIDGE_ERROR',
        durationMs: Date.now() - started,
        input: {},
      })
      throw error
    }
  }

  window.hsrAutomation = Object.freeze({
    version: 1,
    describe: mirrorDescribe,
    call: (name: string, input: unknown = {}) => mirrorCall(name, input, async () => (await load()).executeCommand(name, input)),
  })
}
