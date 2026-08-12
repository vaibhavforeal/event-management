import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Scratch files the Supabase CLI writes while the local stack runs. It
    // includes a minified Deno bootstrap that is not ours to lint.
    "supabase/.temp/**",
    // Generated from the database schema by `npm run db:types`.
    "lib/supabase/types.ts",
  ]),
  // The service role bypasses RLS entirely. Phase 2 needs it, because bookings
  // and tickets are deliberately not writable by `authenticated`, and Phase 3
  // adds payments — but it is needed in exactly four files, the bookings,
  // check-in, payments and notifications services, so that "did we check
  // authorisation here?" has a named list as its answer rather than a grep.
  //
  // Notifications joined the list in Phase 4 for two reasons. message_log has
  // no RLS policy at all — it is service-role only, exactly like fee_rules and
  // provider_webhook_events — so no session-scoped client can write the outbox.
  // And the sweep reads across every attendee and host on an event, which is
  // not a scope any signed-in caller has. The module is reached only from a
  // cron route, so it has no Caller and exposes nothing that takes an id from
  // a request; that is what makes the absence of an authorisation check safe
  // rather than merely absent.
  //
  // Spelled as `patterns` and not `paths` because `paths` compares the
  // specifier string exactly, and this repo writes relative imports as well as
  // aliased ones. A rule naming only "@/lib/supabase/admin" is a claim about
  // one file enforced against one spelling: `../supabase/admin` from anywhere
  // under lib/, and `./admin` from inside lib/supabase/ — which is where
  // server.ts lives, on every request path — would both have linted clean.
  // Both spellings were confirmed to error by probe, not assumed to.
  //
  // proxy.ts is in scope because it runs on every request. scripts/** is
  // deliberately left out: a script is run by hand from a developer's shell,
  // with no session behind it and nobody's authorisation to check, which is
  // one of the uses admin.ts documents itself for.
  {
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "proxy.ts"],
    ignores: ["lib/bookings/service.ts", "lib/checkin/service.ts", "lib/payments/service.ts", "lib/notifications/service.ts", "lib/supabase/admin.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/supabase/admin", "./admin"],
          message:
            "Only lib/bookings/service.ts, lib/checkin/service.ts, lib/payments/service.ts and lib/notifications/service.ts may use the service role. Use @/lib/supabase/server, or add the write to one of those modules.",
        }],
      }],
    },
  },
]);

export default eslintConfig;
