// Check that a built guest binary is something Windows 98 will actually load.
//
//   node scripts/audit-pe.mjs emulator/daemon/bin/daemon.exe [...]
//
// Two things go wrong when you cross-compile for Windows 98 with a modern toolchain, and
// both are invisible until it fails to start on the real thing:
//
//   1. The PE subsystem version. Anything above 4.0 is rejected by the 9x loader.
//   2. An import that does not exist in that era's DLLs — usually dragged in by the C
//      runtime, which is why this build links none.
//
// The allowlist below is not an authority on what Windows 98 exports. It is the set of
// calls we have deliberately chosen and checked, so that *any new import* fails the build
// and gets looked at by a human rather than discovered in the VM.

import { readFileSync } from 'node:fs'

// Every symbol here is one we call on purpose, and all of them shipped with Windows 95.
const ALLOWED = {
  'KERNEL32.dll': new Set([
    // files and pipes
    'CreateFileA',
    'ReadFile',
    'WriteFile',
    'CloseHandle',
    'CreatePipe',
    'PeekNamedPipe',
    'GetFileAttributesA',
    'DeleteFileA',
    'CreateDirectoryA',
    // processes
    'CreateProcessA',
    'GetExitCodeProcess',
    'TerminateProcess',
    'WaitForSingleObject',
    'GetCurrentProcess',
    'DuplicateHandle',
    'ExitProcess',
    // the serial port
    'GetCommState',
    'SetCommState',
    'SetCommTimeouts',
    'ClearCommError',
    'SetupComm',
    'PurgeComm',
    // process enumeration: ToolHelp32 is the 9x way, psapi is NT-only
    'CreateToolhelp32Snapshot',
    'Process32First',
    'Process32Next',
    // odds and ends
    'GetTickCount',
    'Sleep',
    'GetLastError',
    'GetEnvironmentVariableA',
    'OutputDebugStringA',
    'GetStdHandle',
    'GetCurrentDirectoryA',
  ]),
  'USER32.dll': new Set([
    'GetForegroundWindow',
    'GetDesktopWindow',
    'GetWindowTextA',
    'GetWindowThreadProcessId',
  ]),
}

const u16 = (b, o) => b.readUInt16LE(o)
const u32 = (b, o) => b.readUInt32LE(o)

function parsePe(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE (no MZ)')
  const pe = u32(buf, 0x3c)
  if (buf.readUInt32LE(pe) !== 0x00004550)
    throw new Error('not a PE (no PE\\0\\0)')

  const coff = pe + 4
  const sections = u16(buf, coff + 2)
  const optSize = u16(buf, coff + 16)
  const opt = coff + 20
  const magic = u16(buf, opt)
  if (magic !== 0x10b)
    throw new Error(`expected PE32, got magic 0x${magic.toString(16)}`)

  const subsystem = u16(buf, opt + 68)
  const major = u16(buf, opt + 48)
  const minor = u16(buf, opt + 50)
  const dirs = opt + 92 // NumberOfRvaAndSizes, then the directories
  const importRva = u32(buf, dirs + 4 + 8 * 1)

  // Section table, for turning an RVA into a file offset.
  const secs = []
  for (let i = 0; i < sections; i++) {
    const s = opt + optSize + i * 40
    secs.push({
      name: buf.toString('ascii', s, s + 8).replace(/\0+$/, ''),
      va: u32(buf, s + 12),
      size: u32(buf, s + 16),
      ptr: u32(buf, s + 20),
    })
  }
  const at = (rva) => {
    for (const s of secs)
      if (rva >= s.va && rva < s.va + Math.max(s.size, 1))
        return s.ptr + (rva - s.va)
    throw new Error(`rva 0x${rva.toString(16)} is in no section`)
  }
  const str = (off) => {
    let end = off
    while (buf[end] !== 0) end++
    return buf.toString('ascii', off, end)
  }

  // Walk the import descriptors.
  const imports = []
  if (importRva) {
    for (let d = at(importRva); ; d += 20) {
      const originalThunk = u32(buf, d)
      const nameRva = u32(buf, d + 12)
      const firstThunk = u32(buf, d + 16)
      if (!originalThunk && !nameRva && !firstThunk) break
      const dll = str(at(nameRva))
      const thunks = originalThunk || firstThunk
      for (let t = at(thunks); ; t += 4) {
        const entry = u32(buf, t)
        if (!entry) break
        if (entry & 0x80000000)
          imports.push({ dll, symbol: `#${entry & 0xffff}` })
        else imports.push({ dll, symbol: str(at(entry) + 2) })
      }
    }
  }
  return { subsystem, major, minor, imports }
}

let failed = false
for (const path of process.argv.slice(2)) {
  const pe = parsePe(readFileSync(path))
  const problems = []

  // 2 is the GUI subsystem: a console one would flash a DOS box when Windows starts it.
  if (pe.subsystem !== 2)
    problems.push(`subsystem ${pe.subsystem}, expected 2 (GUI)`)
  if (pe.major !== 4 || pe.minor !== 0)
    problems.push(`subsystem version ${pe.major}.${pe.minor}, expected 4.0`)

  for (const { dll, symbol } of pe.imports) {
    const allowed = ALLOWED[dll]
    if (!allowed) problems.push(`imports from ${dll}, which we do not allow`)
    else if (!allowed.has(symbol))
      problems.push(`imports ${dll}!${symbol}, which is not on the allowlist`)
  }

  const dlls = [...new Set(pe.imports.map((i) => i.dll))].join(', ')
  if (problems.length) {
    failed = true
    console.error(`FAIL ${path}`)
    for (const p of problems) console.error(`  ${p}`)
    console.error(
      '  If the import is genuinely fine on Windows 98, add it to ALLOWED in this script.'
    )
  } else {
    console.log(
      `ok   ${path}: subsystem ${pe.major}.${pe.minor} GUI, ${pe.imports.length} imports from ${dlls}`
    )
  }
}
process.exit(failed ? 1 : 0)
