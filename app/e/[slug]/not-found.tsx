import Link from 'next/link'

/**
 * Rendered for an unknown slug and for a draft alike — getPublishedEventBySlug
 * returns null for both, so this page must not hint that the second kind exists.
 * "The link may be wrong, or the host may have taken it down" covers every case
 * without confirming that a slug is real.
 *
 * Colours match app/e/[slug]/page.tsx and are pinned for the same reason: the
 * root stylesheet flips the body colours under `prefers-color-scheme: dark`,
 * which would otherwise leave this near-black text on a near-black page.
 *
 * min-h-screen so the paper surface reaches the bottom of the viewport. Without
 * it the page ends where the copy does and the white <body> shows through
 * underneath, which reads as a rendering fault rather than as a design.
 */
export default function EventNotFound() {
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center gap-4 px-5 py-24 text-center"
      style={{ backgroundColor: '#FBFAF7', color: '#14110F' }}
    >
      <p
        className="flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase"
        style={{ color: '#0F5E52' }}
      >
        <span aria-hidden className="inline-block h-px w-5" style={{ backgroundColor: '#0F5E52' }} />
        Not found
      </p>
      <h1 className="text-xl font-semibold">This event is not available</h1>
      <p style={{ color: '#5C574F' }}>
        The link may be wrong, or the host may have taken it down.
      </p>
      <Link
        href="/"
        className="rounded-lg px-4 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ backgroundColor: '#14110F', outlineColor: '#0F5E52' }}
      >
        See what else is on
      </Link>
    </main>
  )
}
