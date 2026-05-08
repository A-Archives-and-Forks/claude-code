/**
 * Tests for schedule/index.ts — command metadata only.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

let cmd: {
  load?: () => Promise<{ call: unknown }>
  isEnabled?: () => boolean
  name?: string
  type?: string
  aliases?: string[]
  description?: string
  bridgeSafe?: boolean
  availability?: string[]
}

beforeAll(async () => {
  const mod = await import('../index.js')
  cmd = mod.default as typeof cmd
})

describe('scheduleCommand metadata', () => {
  test('name is "schedule"', () => {
    expect(cmd.name).toBe('schedule')
  })

  test('type is local-jsx', () => {
    expect(cmd.type).toBe('local-jsx')
  })

  test('isEnabled returns true', () => {
    expect(cmd.isEnabled?.()).toBe(true)
  })

  test('aliases include cron and triggers', () => {
    expect(cmd.aliases).toContain('cron')
    expect(cmd.aliases).toContain('triggers')
  })

  test('bridgeSafe is false', () => {
    expect(cmd.bridgeSafe).toBe(false)
  })

  test('availability includes claude-ai', () => {
    expect(cmd.availability).toContain('claude-ai')
  })

  test('description mentions schedule or trigger', () => {
    expect(cmd.description?.toLowerCase()).toMatch(/schedule|cron|trigger/)
  })

  test('load() exists and is a function', () => {
    expect(typeof cmd.load).toBe('function')
  })

  test('load() resolves to object with call function', async () => {
    const loaded = await cmd.load!()
    expect(typeof (loaded as { call?: unknown }).call).toBe('function')
  })
})
