#!/usr/bin/env node
/**
 * Frees the dev port if a previous `next dev` was orphaned.
 *
 * Killing the shell that launched `npm run dev` does not always kill the
 * underlying `next dev` process, which keeps listening. The next start then
 * fails with EADDRINUSE, or — worse — Next quietly falls back to another port,
 * which breaks OTP delivery because the Supabase Auth container calls back to a
 * fixed URL.
 *
 * Deliberately narrow: it only ever touches a process listening on the port
 * passed in, which is ours by convention (3100, see package.json).
 *
 * Uses execFileSync with argument arrays rather than a shell string, so nothing
 * parsed out of netstat/lsof output can be interpreted as a shell command.
 */

import { execFileSync } from 'node:child_process'

const portArg = process.argv[2] ?? '3100'

if (!/^\d{1,5}$/.test(portArg) || Number(portArg) < 1 || Number(portArg) > 65535) {
  console.error(`free-port: "${portArg}" is not a valid port`)
  process.exit(1)
}

const port = portArg

function run(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return '' // these tools exit non-zero when nothing matches
  }
}

function listenerPids() {
  const raw =
    process.platform === 'win32'
      ? run('netstat', ['-ano', '-p', 'tcp'])
          .split('\n')
          .filter(
            (line) => line.includes('LISTENING') && new RegExp(`[:.]${port}\\s`).test(line),
          )
          .map((line) => line.trim().split(/\s+/).pop())
      : run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).split('\n')

  // Only ever act on something that is unambiguously a PID.
  return [...new Set(raw.filter((pid) => /^\d+$/.test(pid ?? '') && pid !== '0'))]
}

for (const pid of listenerPids()) {
  run(...(process.platform === 'win32'
    ? ['taskkill', ['/PID', pid, '/F']]
    : ['kill', ['-9', pid]]))
  console.log(`freed port ${port} (stopped orphaned process ${pid})`)
}
