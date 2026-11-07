import type { Engine } from './engine'
import { registerVoice } from './voice/tools'
import { registerPipeline } from './pipeline/handlers'

/**
 * The engine modules: functions that get the engine when it is constructed and register what they own, before `start()`:
 *
 *   export function registerVoice(engine: Engine): void {
 *     engine.queue.register('voice', async (ctx) => { ... })        // a job handler: `queue.register(task, handler)`
 *   }
 *
 * To add one: import it here and put it in `ENGINE_MODULES` (one line each). The service (`engine.cts`) gives a module the generator clients
 * (`cts.comfy()`, `cts.studios()`), the job store and the model registry; its tools go in `mcp/modules.ts`.
 */
export type EngineModule = (engine: Engine) => void

export const ENGINE_MODULES: EngineModule[] = [registerVoice, registerPipeline]
