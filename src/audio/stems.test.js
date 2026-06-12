/**
 * trackIdForFile unit tests (pure reverse-alias lookup — resolveStemUrl's
 * fetch probing is exercised manually).
 */

import { describe, it, expect } from 'vitest'
import { trackIdForFile } from './stems.js'

describe('trackIdForFile', () => {
  it('maps canonical filenames to their track id', () => {
    expect(trackIdForFile('drums.m4a')).toBe('drums')
    expect(trackIdForFile('click.wav')).toBe('click')
  })

  it('maps legacy alias filenames to the canonical id', () => {
    expect(trackIdForFile('drum.m4a')).toBe('drums')
    expect(trackIdForFile('percussion.wav')).toBe('perc')
    expect(trackIdForFile('2nd keys.m4a')).toBe('synth')
    expect(trackIdForFile('vocals.m4a')).toBe('vox')
    expect(trackIdForFile('talkback.wav')).toBe('md')
  })

  it('is case-insensitive', () => {
    expect(trackIdForFile('Drums.M4A')).toBe('drums')
  })

  it('returns null for unrecognized filenames', () => {
    expect(trackIdForFile('mixdown.m4a')).toBeNull()
    expect(trackIdForFile('readme.txt')).toBeNull()
  })
})
