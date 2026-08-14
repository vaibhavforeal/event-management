# Runbook — Happenly to the Play Store (TWA)

Everything code-side landed in Phase 7 (spec:
`docs/specs/2026-08-14-phase-7-pwa-offline-checkin-design.md`). What remains
needs things only a person holds: money, accounts, and the production domain.
Do these in order.

1. **Play Console account** — one-time developer registration (~US$25 /
   ~₹2,100) at https://play.google.com/console. Identity verification can take
   days; start first.
2. **Production domain** — decide it, point it at the Vercel project, confirm
   `https://<domain>/manifest.webmanifest` serves. Then replace the
   `happenly.example.com` placeholders in `twa/twa-manifest.json` (host,
   iconUrl, maskableIconUrl) and commit.
3. **Real branding (optional but recommended before listing)** — replace the
   generated placeholder icons (`scripts/make-icons.mjs` output: the paper-H
   on verdigris) and produce the Play listing art (512×512 icon, 1024×500
   feature graphic, phone screenshots).
4. **Bubblewrap build** — needs Node and a JDK (Bubblewrap fetches its own):
   `npx @bubblewrap/cli init --manifest https://<domain>/manifest.webmanifest --directory twa-build`
   (answer prompts from `twa/twa-manifest.json`), then
   `npx @bubblewrap/cli build`. It mints `android.keystore` if absent —
   **back it up; losing it means a new Play listing.**
5. **Fingerprint → env** — `keytool -list -v -keystore android.keystore -alias happenly`
   → copy the SHA-256 line (colon-separated). In Vercel set
   `TWA_PACKAGE_NAME=com.happenly.app` and `TWA_CERT_SHA256=<that value>`,
   redeploy, then confirm `https://<domain>/.well-known/assetlinks.json`
   serves the statement (it 404s until both are set).
6. **Upload** — Play Console → create app → internal testing track → upload
   the `.aab` from step 4. Install on a real phone: no browser chrome means
   asset links verified; chrome visible means step 5's fingerprint or domain
   is wrong.
7. **When Play signing re-signs the app** — if you enroll in Play App Signing,
   Play's certificate REPLACES yours on delivered builds: add Play's SHA-256
   (Console → Setup → App signing) to `TWA_CERT_SHA256` (the route serves one;
   extend it to a comma-split list if both are ever needed at once).
