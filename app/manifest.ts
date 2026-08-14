import type { MetadataRoute } from 'next'

/**
 * Next 16's manifest file convention: this route serves /manifest.webmanifest
 * and layout metadata links it automatically. First place the product's public
 * name — Happenly — is committed to code (spec: chosen over "Happnly" because
 * names here travel by voice, and the spelled-like-it-sounds form is the one a
 * heard recommendation can type). start_url is the city feed: the store
 * presence is for attendees; hosts navigate to their scanner from there.
 * Colors are the one palette — paper behind the splash, verdigris on the bar.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Happenly',
    short_name: 'Happenly',
    description:
      'Supper clubs, board-game nights, workshops and pop-ups near you. Book in a tap; your ticket arrives on WhatsApp.',
    id: '/',
    start_url: '/',
    display: 'standalone',
    background_color: '#fbfaf7',
    theme_color: '#0f5e52',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
