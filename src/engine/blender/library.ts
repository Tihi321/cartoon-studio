import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { nameSchema } from '../../shared/contracts'
import { findBlenderScripts } from './runner'

/**
 * The acting library manifest (`blender/cts_blender/acting/library.json`): the single source for action names. Lint (E_ACTION_UNKNOWN,
 * W_GESTURE_OVER_LINE), the writer prompt and the timeline read it here; the Python registry must list the same names (test B2).
 */

export const ACTION_KINDS = ['gesture', 'locomotion', 'react', 'camera'] as const

const seconds = z.strictObject({ min: z.number().positive(), default: z.number().positive(), max: z.number().positive() })

export const actionSchema = z.strictObject({
  name: nameSchema,
  kind: z.enum(ACTION_KINDS),
  /** The controls (or `camera`) the action moves. */
  parts: z.array(z.string()).min(1),
  seconds: seconds.refine((s) => s.min <= s.default && s.default <= s.max, 'min <= default <= max'),
  /** May run while the actor speaks. */
  overLine: z.boolean(),
  /** The script beat must name a target (cast id, prop id or mark). */
  needsTarget: z.boolean(),
  params: z.record(z.string(), z.unknown()),
  /** Made by the assembler (idle, blink), not written in a script. */
  auto: z.boolean().optional()
})
export type ActingAction = z.infer<typeof actionSchema>

export const actingLibrarySchema = z.strictObject({
  schema: z.literal('cts.acting-library/1'),
  note: z.string().optional(),
  actions: z.array(actionSchema).min(1)
})

export interface ActingLibrary {
  actions: ActingAction[]
  byName: Map<string, ActingAction>
  /** Names a script `gesture` beat or a line's `gesture` may use: gestures and reactions that are not automatic. */
  scriptable: Set<string>
}

let cached: { file: string; lib: ActingLibrary } | undefined

/** Reads and checks the manifest. Throws when the file is missing or invalid (a packaging or checkout problem, not a user error). */
export function loadActingLibrary(scriptsDir = findBlenderScripts()): ActingLibrary {
  if (!scriptsDir) throw new Error('the blender folder (blender/cts_blender/acting/library.json) was not found; set CTS_BLENDER_SCRIPTS')
  const file = path.join(scriptsDir, 'cts_blender', 'acting', 'library.json')
  if (cached?.file === file) return cached.lib
  const parsed = actingLibrarySchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  const byName = new Map(parsed.actions.map((a) => [a.name, a]))
  if (byName.size !== parsed.actions.length) throw new Error(`${file}: an action name appears twice`)
  const lib: ActingLibrary = {
    actions: parsed.actions,
    byName,
    scriptable: new Set(parsed.actions.filter((a) => (a.kind === 'gesture' || a.kind === 'react') && !a.auto).map((a) => a.name))
  }
  cached = { file, lib }
  return lib
}
