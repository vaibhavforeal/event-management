import Link from 'next/link'

/**
 * Rendered when a reference resolves to nothing — a mistyped code far more
 * often than a missing booking. A reference is eight characters a host reads
 * aloud at a door and someone types back by hand, so arriving here is the
 * expected path rather than an edge case, and Next's default 404 (which is what
 * rendered before this file existed) is a dead end on a page whose visitor
 * almost certainly has a real booking one character away.
 *
 * getBookingByReference returns null both for a reference that does not exist
 * and for one that exists but belongs to somebody else, and page.tsx sends both
 * here alike — deliberately, per its own comment. So this copy must not tell
 * them apart: "we cannot find that booking" is true either way, while anything
 * shaped like "that booking is not yours" would confirm to a stranger that the
 * code they guessed is real.
 *
 * Colours are inherited rather than pinned, unlike app/e/[slug]/not-found.tsx.
 * That page pins because the page it stands in for pins; this one matches its
 * own sibling app/bookings/[reference]/page.tsx, which leaves the body colours
 * from globals.css alone. Both booking pages want the same app-wide dark-mode
 * pass, and they should still want it together after this file lands.
 */
export default function BookingNotFound() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center gap-4 px-5 py-24 text-center">
      <p className="font-mono text-[13px] tracking-wide text-neutral-500">Not found</p>

      <h1 className="text-2xl font-semibold">We cannot find that booking</h1>

      <p className="text-neutral-500">
        Check the reference for a typo — it is eight characters — or open it from your list of
        bookings instead.
      </p>

      <Link href="/bookings" className="mt-2 underline">
        All your bookings
      </Link>
    </main>
  )
}
