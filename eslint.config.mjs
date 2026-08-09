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
  // and tickets are deliberately not writable by `authenticated` — but it needs
  // it in exactly one place, so that "did we check authorisation here?" has one
  // file as its answer rather than a grep.
  {
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    ignores: ["lib/bookings/service.ts", "lib/supabase/admin.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "@/lib/supabase/admin",
          message:
            "Only lib/bookings/service.ts may use the service role. Use @/lib/supabase/server, or add the write to that module.",
        }],
      }],
    },
  },
]);

export default eslintConfig;
