/**
 * SHA-256 as lowercase hex, on Web Crypto so the identical code runs in Node
 * (buildDoorPack hashing codes server-side) and the browser (the scanner
 * hashing a scanned code to look it up). The door pack stores HASHES of ticket
 * codes, never the codes: a copied IndexedDB leaks names and counts — which
 * the host can see anyway — but not the bearer codes that admit people.
 */

const encoder = new TextEncoder()

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
