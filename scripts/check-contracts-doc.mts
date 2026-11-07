// Parses every ```json block of docs/contracts.md with the schema its `schema` field names. Usage: yarn docs:check
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCHEMAS_BY_TAG } from '../src/shared/contracts'
import type { SchemaTag } from '../src/shared/contracts'

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'contracts.md')
const blocks = [...readFileSync(file, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!)
let bad = 0
const seen = new Set<string>()
for (const [i, text] of blocks.entries()) {
  try {
    const json = JSON.parse(text) as { schema?: string }
    const schema = SCHEMAS_BY_TAG[json.schema as SchemaTag]
    if (!schema) throw new Error(`unknown schema tag ${String(json.schema)}`)
    const r = schema.safeParse(json)
    if (!r.success) throw new Error(r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '))
    seen.add(json.schema!)
  } catch (e) {
    bad++
    console.error(`block ${i + 1}: ${(e as Error).message}`)
  }
}
const missing = Object.keys(SCHEMAS_BY_TAG).filter((t) => !seen.has(t))
if (missing.length) {
  bad++
  console.error(`no valid example for: ${missing.join(', ')}`)
}
console.log(`${blocks.length} examples, ${bad} problems`)
process.exit(bad ? 1 : 0)
