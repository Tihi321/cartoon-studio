import path from 'node:path'
import { z } from 'zod'
import { readMd, writeMd } from '../store/atomic'

/** The installer's folder of Blender 5.2 under the system's program folder (the seed `config/blender.md` writes it out). Empty when the system names none. */
export const DEFAULT_BLENDER_PATH = process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Blender Foundation', 'Blender 5.2', 'blender.exe').split(path.sep).join('/') : ''

const frameSettings = (width: number, height: number, samples: number) => z.object({ width: z.number().int().positive().default(width), height: z.number().int().positive().default(height), samples: z.number().int().positive().default(samples) })

/** `config/blender.md` (decision 12 of HUB-30). */
export const blenderConfigSchema = z.object({
  path: z.string().default(DEFAULT_BLENDER_PATH),
  /** Accepted major.minor; any patch. */
  version: z.string().regex(/^\d+\.\d+$/, 'major.minor, for example "5.2"').default('5.2'),
  allowUntestedVersion: z.boolean().default(false),
  chunkFrames: z.number().int().positive().default(240),
  preview: frameSettings(960, 540, 4).default({ width: 960, height: 540, samples: 4 }),
  final: frameSettings(1920, 1080, 16).default({ width: 1920, height: 1080, samples: 16 })
})
export type BlenderConfig = z.infer<typeof blenderConfigSchema>

const file = (dataDir: string) => path.join(dataDir, 'config', 'blender.md')

/** `config/blender.md`; a missing or broken file gives the defaults. `CTS_BLENDER` overrides the path. */
export async function loadBlenderConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<BlenderConfig> {
  let data: Record<string, unknown> = {}
  try {
    data = (await readMd(file(dataDir))).data
  } catch {
    /* defaults */
  }
  const parsed = blenderConfigSchema.safeParse(data)
  const c = parsed.success ? parsed.data : blenderConfigSchema.parse({})
  return env.CTS_BLENDER ? { ...c, path: env.CTS_BLENDER } : c
}

/** Changes fields of `config/blender.md` (keeps the other fields and the text under the front matter; creates the file from the defaults). */
export async function saveBlenderConfig(dataDir: string, patch: Partial<BlenderConfig>): Promise<BlenderConfig> {
  let doc: { data: Record<string, unknown>; body: string } = { data: { kind: 'blender' }, body: '' }
  try {
    doc = await readMd(file(dataDir))
  } catch {
    /* new file */
  }
  const next = blenderConfigSchema.parse({ ...doc.data, ...patch })
  await writeMd(file(dataDir), { ...doc.data, kind: 'blender', ...next }, doc.body)
  return next
}
