#!/usr/bin/env node
/**
 * Web typecheck driver — runs the TS compiler in-process for apps/web.
 *
 * Why not the `tsc` CLI? TS 6.0 treats the baseUrl deprecation (TS5101) as a
 * config error and STOPS BEFORE checking any file, so `tsc --noEmit` was a
 * false green since M0. This driver builds the program through the compiler
 * API (which reports real diagnostics) and filters only that one config
 * deprecation.
 *
 * Why baseUrl stays: dropping it (or setting ignoreDeprecations) switches TS
 * into the new paths-relative-to-tsconfig mode, which on this Windows layout
 * duplicates module identities across the vendored renderer. The other M0
 * typecheck blocker — two @types/react instances (root hoisted + apps/web
 * pnpm symlink) — is fixed in tsconfig.json by pinning react/react-dom
 * through `paths` to the root @types .d.ts files.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(path.dirname(path.dirname(scriptDir)))
const webRoot = path.join(repoRoot, 'apps', 'web')
const configPath = path.join(webRoot, 'tsconfig.json')

const configFile = ts.readConfigFile(configPath, ts.sys.readFile)

if (configFile.error) {
  console.error(
    `[typecheck] failed to read tsconfig: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
  )
  process.exit(1)
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, webRoot)
const program = ts.createProgram(parsed.fileNames, parsed.options)
const diagnostics = ts.getPreEmitDiagnostics(program)

// TS5101: the pre-existing baseUrl deprecation (see the header comment).
const real = diagnostics.filter((d) => d.code !== 5101)

for (const diagnostic of real) {
  const where =
    diagnostic.file && diagnostic.start !== undefined
      ? `${diagnostic.file.fileName}(${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1},${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).character + 1})`
      : ''
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  console.error(`${where}: error TS${diagnostic.code}: ${message}`)
}

process.exit(real.length > 0 ? 1 : 0)
