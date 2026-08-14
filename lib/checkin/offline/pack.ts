/**
 * The door pack: one event's roster, cached in IndexedDB while the venue still
 * has signal, so the scanner can hand out verdicts in a basement. Client-safe
 * and pure — the server builds one in lib/checkin/service.ts (buildDoorPack),
 * the scanner reads one through lib/checkin/offline/store.ts.
 */

export interface PackTicket {
  /** sha256Hex(tickets.code) — raw bearer codes never sit on disk. */
  codeHash: string
  /** bookings.attendee_name — same source the check-in RPCs return. */
  attendeeName: string | null
  reference: string
  bookingId: string
  /** Null = not in when the pack was generated. Pack truth, not live truth. */
  checkedInAt: string | null
  ticketsTotal: number
  ticketsIn: number
}

export interface DoorPack {
  eventId: string
  /** Server clock at build time. The scanner shows this as the roster's age. */
  generatedAt: string
  tickets: PackTicket[]
}

export function packIndex(pack: DoorPack): Map<string, PackTicket> {
  return new Map(pack.tickets.map((t) => [t.codeHash, t]))
}
