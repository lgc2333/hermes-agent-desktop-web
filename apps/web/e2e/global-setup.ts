import { startSharedStack, teardownAll } from './helpers/topology'

/**
 * Vitest global setup (node env): start the shared proxy + Vite dev server
 * and return a teardown that stops everything. Returning teardown from the
 * setup function (rather than a separate globalTeardown file) keeps the same
 * module instance in scope so `teardownAll` sees the live child handles.
 */
export default async function globalSetup(): Promise<() => Promise<void> | void> {
  await startSharedStack()
  return () => teardownAll()
}
