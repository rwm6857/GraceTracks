/**
 * Song-version helper unit tests (pure functions only — the Supabase-backed
 * fetchers are exercised manually against RLS).
 *
 * Focus areas:
 *   1. versionFolder — legacy path vs versions/ subfolder composition
 *   2. buildVersionList — implicit Original entry + default fallthrough
 *   3. resolveActiveVersion — ?v= resolution incl. unknown-slug fallback
 *   4. versionUrl — bare URL for the default, ?v=original, ?v=<slug>
 */

import { describe, it, expect } from 'vitest'
import {
  versionFolder,
  buildVersionList,
  resolveActiveVersion,
  versionUrl,
  VERSION_RE,
} from './versions.js'

const rows = [
  { version_slug: 'agmc2026', label: 'AGMC2026', is_default: false },
  { version_slug: 'ga2024',   label: 'GA2024',   is_default: false },
]

describe('versionFolder', () => {
  it('returns the bare stem folder for Original (null version)', () => {
    expect(versionFolder('let_us_sing', null)).toBe('let_us_sing')
  })

  it('nests versions under versions/<slug>', () => {
    expect(versionFolder('let_us_sing', 'agmc2026')).toBe('let_us_sing/versions/agmc2026')
  })
})

describe('buildVersionList', () => {
  it('returns a lone default Original when there are no rows', () => {
    expect(buildVersionList([])).toEqual([
      { versionSlug: null, label: 'Original', isDefault: true },
    ])
  })

  it('keeps Original default when no row is flagged', () => {
    const list = buildVersionList(rows)
    expect(list).toHaveLength(3)
    expect(list[0]).toEqual({ versionSlug: null, label: 'Original', isDefault: true })
    expect(list.filter(v => v.isDefault)).toHaveLength(1)
  })

  it('hands default to a flagged row', () => {
    const list = buildVersionList([rows[0], { ...rows[1], is_default: true }])
    expect(list[0].isDefault).toBe(false)
    expect(list[2]).toEqual({ versionSlug: 'ga2024', label: 'GA2024', isDefault: true })
  })
})

describe('resolveActiveVersion', () => {
  const list = buildVersionList([rows[0], { ...rows[1], is_default: true }])

  it('resolves "original" to the Original entry even when not default', () => {
    expect(resolveActiveVersion(list, 'original').versionSlug).toBe(null)
  })

  it('resolves a known version slug', () => {
    expect(resolveActiveVersion(list, 'agmc2026').label).toBe('AGMC2026')
  })

  it('falls back to the default for absent or unknown requests', () => {
    expect(resolveActiveVersion(list, null).versionSlug).toBe('ga2024')
    expect(resolveActiveVersion(list, 'bogus').versionSlug).toBe('ga2024')
  })

  it('falls back to Original when nothing is flagged', () => {
    const noDefault = buildVersionList(rows)
    expect(resolveActiveVersion(noDefault, undefined).versionSlug).toBe(null)
  })
})

describe('versionUrl', () => {
  it('uses the bare URL for the default version', () => {
    expect(versionUrl('my-song', null, null)).toBe('/song/my-song')
    expect(versionUrl('my-song', 'hq', 'hq')).toBe('/song/my-song')
  })

  it('addresses non-default Original as ?v=original', () => {
    expect(versionUrl('my-song', null, 'hq')).toBe('/song/my-song?v=original')
  })

  it('addresses non-default versions as ?v=<slug>', () => {
    expect(versionUrl('my-song', 'agmc2026', null)).toBe('/song/my-song?v=agmc2026')
  })
})

describe('VERSION_RE', () => {
  it('accepts lowercase slugs and rejects everything else', () => {
    expect(VERSION_RE.test('agmc2026')).toBe(true)
    expect(VERSION_RE.test('ga_2024-hq')).toBe(true)
    expect(VERSION_RE.test('AGMC2026')).toBe(false)
    expect(VERSION_RE.test('bad/slug')).toBe(false)
    expect(VERSION_RE.test('')).toBe(false)
    expect(VERSION_RE.test('a'.repeat(65))).toBe(false)
  })
})
