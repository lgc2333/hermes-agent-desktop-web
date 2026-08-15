/**
 * Deno thin proxy (M2). Placeholder for now — the single-handler design in
 * PLAN.md §6: static SPA + passphrase gate + transparent forward to the
 * X-Hermes-Target gateway (REST + WS relay). Zero deps, TS source straight
 * from Deno.
 */
if (import.meta.main) {
  console.error('apps/proxy: not implemented yet (M2). See PLAN.md §6.')
  Deno.exit(1)
}
