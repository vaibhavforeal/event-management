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
]);

export default eslintConfig;
