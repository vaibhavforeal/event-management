import Link from 'next/link'

/**
 * Rendered for an unknown slug and for a draft alike — getPublishedEventBySlug
 * returns null for both, so this page must not hint that the second kind exists.
 * "The link may be wrong, or the host may have taken it down" covers every case
 * without confirming that a slug is real.
 *
 * Colours are inherited. This page used to pin them inline, back when
 * globals.css flipped the body colours under `prefers-color-scheme: dark`;
 * globals.css is light-only now and the body is the same paper these pins
 * duplicated.
 *
 * min-h-screen is vestigial for the same reason — the body behind this main is
 * the same surface — and stays so that a distinct background here cannot
 * quietly end mid-viewport.
 */
export default function EventNotFound() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center gap-4 px-5 py-24 text-center">
      <p className="text-accent flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase">
        <span aria-hidden className="bg-accent inline-block h-px w-5" />
        Not found
      </p>
      <h1 className="text-xl font-semibold">This event is not available</h1>
      <p className="text-muted">
        The link may be wrong, or the host may have taken it down.
      </p>
      <Link
        href="/"
        className="bg-ember text-white rounded-full px-5 py-3 text-[15px] font-semibold hover:bg-ember-deep focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        See what else is on
      </Link>
    </main>
  )
}
