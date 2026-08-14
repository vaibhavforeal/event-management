/**
 * One-off icon generator: a paper "H" wordmark on verdigris, the palette from
 * app/globals.css. Placeholder by design — real branding is a person task in
 * docs/runbooks/play-store-twa.md. Run with sharp WITHOUT adding it to the
 * project (createRequire resolves it from the npx install):
 *
 *   npm exec --yes --package=sharp -- node scripts/make-icons.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

// text-anchor/dominant-baseline centre the glyph; the maskable variant shrinks
// it into the 80% safe zone so launcher masks cannot clip it.
const mark = (fontSize) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <rect width="512" height="512" fill="#0f5e52"/>
    <text x="50%" y="50%" dy="0.06em" font-family="Georgia, serif" font-weight="bold"
          font-size="${fontSize}" fill="#fbfaf7"
          text-anchor="middle" dominant-baseline="middle">H</text>
  </svg>`

const jobs = [
  { file: 'public/icon-192.png', size: 192, svg: mark(300) },
  { file: 'public/icon-512.png', size: 512, svg: mark(300) },
  { file: 'public/icon-512-maskable.png', size: 512, svg: mark(240) },
  { file: 'app/apple-icon.png', size: 180, svg: mark(300) },
]

for (const job of jobs) {
  await sharp(Buffer.from(job.svg)).resize(job.size, job.size).png().toFile(job.file)
  console.log(`wrote ${job.file}`)
}
