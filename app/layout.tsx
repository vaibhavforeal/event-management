import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { SwRegister } from './sw-register'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

/**
 * The tab title on every page, and the fallback for a link pasted into WhatsApp
 * before Task 9's per-event OpenGraph tags exist.
 *
 * `template` rather than a bare string so a page that sets `title: 'Edit event'`
 * composes to "Edit event · Event Hoster" instead of replacing the product name
 * outright. Task 9 sets the public event page's title to the event's own title
 * and depends on this to brand the preview card. `default` is what renders when
 * a page sets no title of its own.
 */
export const metadata: Metadata = {
  title: {
    default: 'Happenly — curated offline experiences near you',
    template: '%s · Happenly',
  },
  description:
    'Supper clubs, board-game nights, workshops and pop-ups in tier-2 and tier-3 Indian cities. ' +
    'Hosts publish in under three minutes and get one link to forward on WhatsApp.',
}

/** The PWA's toolbar/status-bar color; pairs with the manifest's theme_color. */
export const viewport: Viewport = {
  themeColor: '#0f5e52',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/*
        Deliberately NOT a flex container.

        Every page here is a `<main className="mx-auto max-w-*">`. On a flex item
        an auto cross-axis margin wins over `align-items: stretch` — the margins
        absorb the free space instead — so main was sized shrink-to-fit and then
        pinned to its own max-width whatever the viewport was. That is one bug
        with two faces: on a 390px phone the page scrolled sideways, and at
        1280px /host/events/new sat at 488px rather than the 672px `max-w-2xl`
        asks for, because shrink-to-fit measures the form's content, not the
        space available.

        `items-stretch` does not fix it; auto margins take precedence over the
        alignment property by design (CSS Box Alignment 3, §5.2). Only dropping
        `flex` does, which is what this is. A block-level body makes main
        full-width by default and `mx-auto` goes back to meaning "centre me".
      */}
      <body className="min-h-full">
        <SwRegister />
        {children}
      </body>
    </html>
  )
}
