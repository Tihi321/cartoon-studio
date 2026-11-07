import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileUrlToPath, parseRange } from '../src/main/files'

const data = path.resolve('some-data')
const url = (rel: string) => `cartoonstudio-file://data/${rel}`

describe('the file protocol of the app', () => {
  it('serves media and images under series/<slug>/ only, and refuses the rest', () => {
    expect(fileUrlToPath(data, url('series/pilot/clips/intro.mp4'))).toMatchObject({ type: 'video/mp4', root: data })
    expect(fileUrlToPath(data, url('series/pilot/cast/mia/parts/head.svg?v=2'))?.type).toBe('image/svg+xml')
    expect(fileUrlToPath(data, url('series/pilot/episodes/ep00/voice/hr/l01.wav'))?.type).toBe('audio/wav')
    expect(fileUrlToPath(data, url('config/providers.md'))).toBeNull()
    expect(fileUrlToPath(data, url('series/pilot/../../config/budget.md'))).toBeNull()
    expect(fileUrlToPath(data, url('series/pilot/notes.txt'))).toBeNull()
    expect(fileUrlToPath(data, url('series/Pilot/clips/intro.mp4'))).toBeNull()
    expect(fileUrlToPath(data, 'https://example.com/series/pilot/clips/intro.mp4')).toBeNull()
    expect(fileUrlToPath(data, 'nonsense')).toBeNull()
  })

  it('parseRange reads a single byte range and flags one outside the file', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=9-2', 100)).toBe('invalid')
  })
})
