import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { bodyKindSchema, isVehicle, nameSchema, vehicleTypeSchema } from '../../shared/contracts'
import type { BodyKind, Character3d, MoveStyle, VehicleType } from '../../shared/contracts'
import { findBlenderScripts } from './runner'

/**
 * The acting library manifest (`blender/cts_blender/acting/library.json`): the single source for action names. Lint (E_ACTION_UNKNOWN,
 * E_ACTION_BODY, W_GESTURE_OVER_LINE), the writer prompt and the timeline read it here; the Python registry must list the same names (test B2).
 *
 * HUB-31: every action names the `bodies` that can do it (`creature`, `vehicle` or both); `vehicleTypes` narrows a vehicle action to a car or a
 * train. An action shared by both bodies keeps one name; its `parts` are the union of what each body moves, and an actor keys only the controls
 * it has. In `parts`, `wheel_*` means every wheel control, `antenna*` every antenna link, `lamp_glow` the glow of the lamp eyes and `camera` the camera.
 */

export const ACTION_KINDS = ['gesture', 'locomotion', 'react', 'camera'] as const

/** The face states a script `emotion` may name for a 3D character: the keys of `EMOTIONS` in `blender/cts_blender/assemble.py` (the assembler shows an unknown one as neutral and warns). */
export const EMOTIONS_3D: readonly string[] = ['neutral', 'happy', 'excited', 'surprised', 'sad', 'worried', 'angry', 'sleepy', 'proud']

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
  auto: z.boolean().optional(),
  /** HUB-31: the body kinds that can do it. Camera actions list both. */
  bodies: z.array(bodyKindSchema).min(1),
  /** HUB-31: a vehicle action only a car or only a train does (absent: every vehicle). Says nothing about creatures. */
  vehicleTypes: z.array(vehicleTypeSchema).min(1).optional()
})
export type ActingAction = z.infer<typeof actionSchema>

/** The body of a cast member as the acting library sees it. */
export interface ActorBody {
  kind: BodyKind
  vehicleType?: VehicleType
}

export const bodyOf = (spec: Character3d): ActorBody => (isVehicle(spec) ? { kind: 'vehicle', vehicleType: spec.vehicle.type } : { kind: 'creature' })

/** Why this body cannot do the action (E_ACTION_BODY), or null when it can. */
export function bodyCannot(action: ActingAction, body: ActorBody): string | null {
  if (!action.bodies.includes(body.kind)) return `"${action.name}" is an action of a ${action.bodies.join(' or ')}, not of a ${body.kind}`
  if (body.kind === 'vehicle' && action.vehicleTypes && body.vehicleType && !action.vehicleTypes.includes(body.vehicleType))
    return `"${action.name}" is an action of a ${action.vehicleTypes.join(' or ')}, not of a ${body.vehicleType}`
  return null
}

/** The library action a `move` beat runs: its `style` (`tiptoe` is a slow `walk`), else the body's default (a car drives, a train chugs, a creature walks or hops). */
export function moveAction(style: MoveStyle | undefined, spec: Character3d | null): string {
  if (style) return style === 'tiptoe' ? 'walk' : style
  if (spec && isVehicle(spec)) return spec.vehicle.type === 'train' ? 'chug' : 'drive'
  const walk = spec && 'walk' in spec.motion ? spec.motion.walk.style : 'walk'
  return walk === 'hop' ? 'hop' : 'walk'
}

export const actingLibrarySchema = z.strictObject({
  schema: z.literal('cts.acting-library/1'),
  note: z.string().optional(),
  actions: z.array(actionSchema).min(1)
})

export interface ActingLibrary {
  actions: ActingAction[]
  byName: Map<string, ActingAction>
  /** Names a script `gesture` beat or a line's `gesture` may use: gestures and reactions that are not automatic (of any body; see `bodyCannot`). */
  scriptable: Set<string>
}

/** The scriptable names one body can do (for the writer prompt of a series with that body). */
export const scriptableFor = (lib: ActingLibrary, body: ActorBody): string[] => [...lib.scriptable].filter((n) => !bodyCannot(lib.byName.get(n)!, body))

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
