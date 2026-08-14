import { describe, expect, it } from 'vitest'
import manifest from './manifest'

describe('the web app manifest', () => {
  const m = manifest()

  it('carries the product name, whole, in both fields', () => {
    expect(m.name).toBe('Happenly')
    expect(m.short_name).toBe('Happenly')
  })

  it('starts at the city feed as a standalone app', () => {
    expect(m.start_url).toBe('/')
    expect(m.id).toBe('/')
    expect(m.display).toBe('standalone')
  })

  it('wears the one palette', () => {
    expect(m.background_color).toBe('#fbfaf7') // --color-paper
    expect(m.theme_color).toBe('#0f5e52') // --color-accent
  })

  it('ships 192, 512 and a maskable 512', () => {
    const bySize = (size: string) => m.icons!.filter((i) => i.sizes === size)
    expect(bySize('192x192')).toHaveLength(1)
    expect(bySize('512x512')).toHaveLength(2)
    expect(m.icons!.some((i) => i.purpose === 'maskable')).toBe(true)
  })

  it('has correct icon src paths', () => {
    const srcs = m.icons!.map((i) => i.src)
    expect(srcs).toContain('/icon-192.png')
    expect(srcs).toContain('/icon-512.png')
    expect(srcs).toContain('/icon-512-maskable.png')
  })
})
