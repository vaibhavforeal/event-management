'use client'

import { useEffect } from 'react'

/**
 * Registers the scanner's offline shell. Progressive enhancement only: every
 * failure path is a silent no-op, because everything except an offline page
 * RELOAD works without a service worker. updateViaCache 'none' + the no-cache
 * header in next.config.ts mean a deployed fix is picked up on next load.
 */
export function SwRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker
      .register('/sw.js', { type: 'module', updateViaCache: 'none' })
      .catch(() => {})
  }, [])
  return null
}
