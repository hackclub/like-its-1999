// node --test emulator/daemon/native.test.mjs
//
// the real C parent driven by the real host code; the parent's serial port is
// stdin/stdout on posix, so the whole conversation runs over a pipe with no vm involved
//
// needs the host binaries: scripts/build-daemon.sh host

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { createLink } from './link.js'

const here = new URL('.', import.meta.url).pathname
const PARENT = join(here, 'build/daemon')
const CHILD = join(here, 'build/child')
const have = existsSync(PARENT) && existsSync(CHILD)

// supervision timeouts compressed so the hang path is testable in a second rather than
// half a minute; nothing sets these in production
const FAST = {
  DAEMON_ALIVE_STALE_MS: '600',
  DAEMON_ALIVE_EVERY_MS: '100',
  DAEMON_SPAWN_GRACE_MS: '200',
  DAEMON_BACKOFF_MS: '100',
  DAEMON_SUPERVISE_MS: '100',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// poll for a condition, so tests never depend on a fixed sleep being long enough
async function until(what, fn, timeout = 8000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout)
      throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

// an emulator-shaped object over a child process, so link.js drives the real binary the
// way it drives v86: bytes out through serial_send_bytes, bytes in one at a time
function attach(proc) {
  const listeners = new Map()
  proc.stdout.on('data', (buf) => {
    for (const byte of buf)
      for (const fn of listeners.get('serial0-output-byte') || []) fn(byte)
  })
  return {
    add_listener: (name, fn) =>
      listeners.set(name, [...(listeners.get(name) || []), fn]),
    // input counters register here in the real thing; nothing sends them in this test
    bus: { pair: { register: () => {} } },
    serial_send_bytes: (_port, bytes) => proc.stdin.write(Buffer.from(bytes)),
  }
}

let dir
let procs = []

function startParent(env = {}) {
  const proc = spawn(PARENT, [], {
    env: { ...process.env, DAEMON_DIR: dir, ...FAST, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  proc.stderr.resume() // p_log output; ignored unless a test is being debugged
  // several tests push frames at a parent and then let it die; without this, node turns
  // the EPIPE into an uncaught exception after the test has already passed
  proc.stdin.on('error', () => {})
  procs.push(proc)
  return proc
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-native-'))
})

after(() => {
  for (const p of procs) p.kill('SIGKILL')
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const childBytes = async () => new Uint8Array(await readFile(CHILD))

async function ready(t, { hash = 'testhash1', push = true } = {}) {
  const proc = startParent()
  const bytes = push ? await childBytes() : null
  const link = createLink({
    emulator: attach(proc),
    epoch: `e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    instanceId: 'i1',
    wantHash: hash,
    wantBytes: bytes,
  })
  t.after(() => {
    link.stop()
    proc.kill('SIGKILL')
  })
  return { proc, link }
}

test(
  'the parent identifies itself, then runs a child we push',
  { skip: !have && 'run scripts/build-daemon.sh host' },
  async (t) => {
    const { link } = await ready(t)

    await until('parent to answer', () => link.agent.role !== null)
    await until('a running child', () => link.state === 'ready')
    assert.equal(link.agent.hash, 'testhash1')
    assert.ok(link.agent.caps.includes('win'), 'caps came back')

    const cached = readdirSync(join(dir, 'CACHE'))
    assert.deepEqual(cached, ['testhash1.EXE'])
  }
)

test(
  'a pushed binary is byte-identical on the other side',
  { skip: !have && 'build first' },
  async (t) => {
    await ready(t, { hash: 'exacthash' })
    await until('the file to be written', () =>
      existsSync(join(dir, 'CACHE/exacthash.EXE'))
    )
    const written = new Uint8Array(
      await readFile(join(dir, 'CACHE/exacthash.EXE'))
    )
    assert.deepEqual(
      written,
      await childBytes(),
      'chunked transfer lost nothing'
    )
  }
)

test(
  'calls round trip through the real child',
  { skip: !have && 'build first' },
  async (t) => {
    const { link } = await ready(t, { hash: 'callhash' })
    await until('ready', () => link.state === 'ready')

    const health = await link.call('health')
    assert.equal(health[0], '0.1', 'version')
    assert.ok(Number(health[1]) >= 0, 'uptime is a number')

    const [code, out] = await link.call('exec', ['echo hello-from-the-guest'])
    assert.equal(code, '0')
    assert.match(out, /hello-from-the-guest/)

    await assert.rejects(() => link.call('nosuchthing'), /no such function/)
  }
)

test(
  'a foreground change arrives as an event and lands in the log',
  { skip: !have && 'build first' },
  async (t) => {
    const { link } = await ready(t, { hash: 'winhash' })
    await until('ready', () => link.state === 'ready')

    // the posix child reads its "foreground window" from a file, so a test can move it
    writeFileSync(
      join(dir, 'FOREGROUND'),
      'EDITPLUS.EXE\nindex.html - EditPlus\n'
    )
    // the connection primes itself with a getForeground the moment a child appears, so
    // an earlier line may record that there was no foreground window at all
    const wins = () => link.log.lines.filter((l) => l.ev === 'win')
    const line = await until(
      'a win event for EditPlus',
      () => wins().find((l) => l.exe === 'EDITPLUS.EXE'),
      15000
    )
    assert.equal(line.win, 'index.html - EditPlus')

    writeFileSync(join(dir, 'FOREGROUND'), 'PSP.EXE\nPaint Shop Pro\n')
    await until(
      'the second window',
      () => wins().some((l) => l.exe === 'PSP.EXE'),
      15000
    )
    const count = wins().length
    await sleep(1200)
    assert.equal(
      wins().length,
      count,
      'polling the same window does not spam the log'
    )
  }
)

test(
  'a child that dies is noticed and replaced',
  { skip: !have && 'build first' },
  async (t) => {
    const { link } = await ready(t, { hash: 'diehash' })
    await until('ready', () => link.state === 'ready')

    // $PPID inside the child's shell is the child process itself
    await link.call('exec', ['kill -9 $PPID']).catch(() => {})

    await until('the death to be reported', () =>
      link.agent.statuses.some((s) => s.code === 'child-down')
    )
    // the parent re-identifies, the host pushes again, and it comes back by itself
    await until('recovery', () => link.state === 'ready', 15000)
  }
)

test(
  'a hung child is killed and restarted, which a process handle alone cannot catch',
  { skip: !have && 'build first' },
  async (t) => {
    const { link } = await ready(t, { hash: 'hanghash' })
    await until('ready', () => link.state === 'ready')

    // SIGSTOP leaves the process alive and its handle valid, but it stops touching ALIVE,
    // which is the failure the liveness file exists for
    const [, pidOut] = await link.call('exec', ['echo $PPID'])
    const childPid = Number(String(pidOut).trim())
    assert.ok(childPid > 0, 'found the child pid')
    process.kill(childPid, 'SIGSTOP')
    t.after(() => {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {}
    })

    await until(
      'the liveness timeout to fire',
      () => link.agent.statuses.some((s) => s.detail === 'liveness timeout'),
      15000
    )
    await until('a fresh child', () => link.state === 'ready', 15000)
  }
)

test(
  'a short payload is refused and the machine stays usable',
  { skip: !have && 'build first' },
  async (t) => {
    const proc = startParent()
    const link = createLink({
      emulator: attach(proc),
      epoch: 'e-short',
      instanceId: 'i1',
      wantHash: 'shorthash',
      wantBytes: null, // nothing to push: we will do it by hand, badly
    })
    t.after(() => {
      link.stop()
      proc.kill('SIGKILL')
    })
    await until('parent', () => link.agent.role === 'parent')

    // claim more bytes than we send, then end the transfer
    const { encode, TYPES } = await import('./frame.js')
    const send = (type, fields) =>
      proc.stdin.write(Buffer.from(encode(type, fields)))
    send(TYPES.PAYLOAD_BEGIN, ['e-short', 'shorthash', '9999'])
    send(TYPES.PAYLOAD_DATA, ['e-short', '0', new Uint8Array(10)])
    send(TYPES.PAYLOAD_END, ['e-short', 'shorthash'])

    await until('a refusal', () =>
      link.agent.statuses.some((s) => s.code === 'push-failed')
    )
    assert.equal(link.state, 'parent', 'and no child was started')
    assert.ok(
      !existsSync(join(dir, 'CACHE/shorthash.EXE')),
      'nothing was written'
    )

    send(TYPES.PING, ['e-short', '77'])
    await until(
      'the connection to still work',
      () => link.agent.lastHeard !== null
    )
  }
)

test(
  'stray payload frames and junk bytes are ignored',
  { skip: !have && 'build first' },
  async (t) => {
    const { proc, link } = await ready(t, { hash: 'junkhash' })
    await until('ready', () => link.state === 'ready')

    const { encode, TYPES } = await import('./frame.js')
    // garbage, a sync word that leads nowhere, and payload frames with no BEGIN
    proc.stdin.write(Buffer.from([0, 1, 2, 0x39, 0x39, 0xff, 0xff, 0xff, 0xff]))
    proc.stdin.write(
      Buffer.from(encode(TYPES.PAYLOAD_DATA, ['e', '0', new Uint8Array(4)]))
    )
    proc.stdin.write(Buffer.from(encode(TYPES.PAYLOAD_END, ['e', 'nope'])))

    await sleep(300)
    assert.equal(link.state, 'ready', 'still connected')
    const health = await link.call('health')
    assert.equal(health[0], '0.1', 'and still answering')
  }
)

test(
  'a build already in the cache starts without anything crossing the wire',
  { skip: !have && 'build first' },
  async (t) => {
    // a restarted parent has forgotten its cache, so the wanted hash on the announce is
    // what tells it what to look for
    const { link: first } = await ready(t, { hash: 'cachedbuild' })
    await until('the first parent to run it', () => first.state === 'ready')
    first.stop()

    // a second parent over the same directory, this time with no bytes on offer
    const proc = startParent()
    const emu = attach(proc)
    const send = emu.serial_send_bytes
    let sent = 0
    emu.serial_send_bytes = (port, bytes) => {
      sent += bytes.length
      return send(port, bytes)
    }
    const link = createLink({
      emulator: emu,
      epoch: 'e-cached',
      instanceId: 'i1',
      wantHash: 'cachedbuild',
      wantBytes: null,
    })
    t.after(() => {
      link.stop()
      proc.kill('SIGKILL')
    })

    await until('the cached child to come up', () => link.state === 'ready')
    assert.equal(link.agent.hash, 'cachedbuild')
    assert.ok(sent < 512, `nothing substantial was sent (${sent} bytes)`)
  }
)

test(
  'a hash that could name a path is refused',
  { skip: !have && 'build first' },
  async (t) => {
    const { proc, link } = await ready(t, { hash: 'pathhash' })
    await until('ready', () => link.state === 'ready')

    const { encode, TYPES } = await import('./frame.js')
    proc.stdin.write(
      Buffer.from(
        encode(TYPES.PAYLOAD_BEGIN, [link.agent.epoch, '..\\evil', '4'])
      )
    )
    await until('the refusal', () =>
      link.agent.statuses.some((s) => s.detail === 'bad hash')
    )
    assert.equal(link.state, 'ready', 'still connected')
    assert.deepEqual(
      readdirSync(join(dir, 'CACHE')).filter((f) => f.includes('evil')),
      []
    )
  }
)

test(
  'pushing the build that is already running leaves the child alone',
  { skip: !have && 'build first' },
  async (t) => {
    const { proc, link } = await ready(t, { hash: 'samehash' })
    await until('ready', () => link.state === 'ready')
    const [, uptime] = await link.call('health')

    // framed by hand: the host refuses to re-push a hash it believes is running, but after
    // a `child-down` it clears that belief while the parent may already be respawning from
    // its cache
    const { encode, TYPES } = await import('./frame.js')
    const e = link.agent.epoch
    const junk = Uint8Array.of(1, 2, 3, 4)
    proc.stdin.write(
      Buffer.concat([
        Buffer.from(encode(TYPES.PAYLOAD_BEGIN, [e, 'samehash', '4'])),
        Buffer.from(encode(TYPES.PAYLOAD_DATA, [e, '0', junk])),
        Buffer.from(encode(TYPES.PAYLOAD_END, [e, 'samehash'])),
      ])
    )

    await until('the parent to say so', () =>
      link.agent.statuses.some((s) => s.code === 'push-ignored')
    )
    assert.equal(link.state, 'ready')
    const [, later] = await link.call('health')
    assert.ok(
      Number(later) >= Number(uptime),
      'the same child is still running, not a fresh one'
    )
  }
)

test(
  'RESET and ANNOUNCE arriving in one read both get handled',
  { skip: !have && 'build first' },
  async (t) => {
    // the host sends these back to back on its first tick, so they routinely land in a
    // single read; the fake guest cannot catch this, since it decodes both frames before
    // handling either
    const proc = startParent()
    const { encode, TYPES, createDecoder, decodeFields, fieldText } =
      await import('./frame.js')
    const idents = []
    const dec = createDecoder()
    proc.stdout.on('data', (buf) => {
      for (const f of dec.push(new Uint8Array(buf)))
        if (f.type === TYPES.IDENT)
          idents.push(decodeFields(f.payload).map(fieldText))
    })
    t.after(() => proc.kill('SIGKILL'))

    proc.stdin.write(
      Buffer.concat([
        Buffer.from(encode(TYPES.RESET, [])),
        Buffer.from(encode(TYPES.ANNOUNCE, ['e-oneread', '1', ''])),
      ])
    )
    const ident = await until(
      'an ident from the combined read',
      () => idents[0],
      5000
    )
    assert.equal(
      ident[0],
      'e-oneread',
      'and it adopted the epoch from that announce'
    )
  }
)

test(
  'a child that will not start leaves the working one running',
  { skip: !have && 'build first' },
  async (t) => {
    // PROTOCOL.md promises a failed push keeps whatever child was already there, which
    // covers a transfer that arrives perfectly and then cannot be spawned
    const { link } = await ready(t, { hash: 'goodbuild' })
    await until('the good child', () => link.state === 'ready')
    const [, uptime] = await link.call('health')

    // a file that is not a program: the fork succeeds and the exec does not, which is
    // what the spawn confirmation exists to notice
    link.setWanted({ hash: 'badbuild', bytes: new Uint8Array(64).fill(0x41) })

    await until('the parent to report it', () =>
      link.agent.statuses.some((s) => s.detail === 'it would not start')
    )
    await until('a rollback to the working child', () =>
      link.agent.statuses.some((s) =>
        s.detail?.includes('kept the previous one')
      )
    )
    // the host is deliberately not "ready": it still wants the build it asked for and
    // will not settle for a different one
    await until(
      'the good child to be running again',
      () => link.agent.role === 'child' && link.agent.hash === 'goodbuild',
      15000
    )
    assert.ok(
      readdirSync(join(dir, 'CACHE')).includes('goodbuild.EXE'),
      'its binary was never deleted'
    )

    // asking for it again recovers from the cache, with nothing on the wire
    link.setWanted({ hash: 'goodbuild', bytes: await childBytes() })
    await until('ready', () => link.state === 'ready', 15000)
    const [ver] = await link.call('health')
    assert.equal(ver, '0.1', 'and it answers')
    // the surviving binary is never deleted, but it is restarted rather than kept running,
    // since swapping children stops the old one first, so `uptime` above only proves it
    // was alive to begin with
    assert.ok(Number(uptime) >= 0)
  }
)

test(
  'a child that stops reading its pipe cannot park the parent',
  { skip: !have && 'build first' },
  async (t) => {
    // a blocking write into a full pipe would leave the parent unable to read the port,
    // run supervision, or kill the child that filled it
    const { proc, link } = await ready(t, { hash: 'wedgehash' })
    await until('ready', () => link.state === 'ready')
    const [, pidOut] = await link.call('exec', ['echo $PPID'])
    const childPid = Number(String(pidOut).trim())
    assert.ok(childPid > 0)
    process.kill(childPid, 'SIGSTOP')
    t.after(() => {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {}
    })

    // enough calls to fill any pipe buffer; these are forwarded verbatim, so the parent
    // is writing into a reader that has stopped
    const { encode, TYPES } = await import('./frame.js')
    const one = Buffer.from(
      encode(TYPES.CALL, [link.agent.epoch, '9', 'health', 'x'.repeat(200)])
    )
    proc.stdin.write(Buffer.concat(Array.from({ length: 1200 }, () => one)))

    await until(
      'the parent to notice and drop the child',
      () => link.agent.statuses.some((s) => s.code === 'child-down'),
      15000
    )
    const before = link.agent.msSinceHeard
    await until(
      'the parent to still be answering',
      async () => {
        const r = await link.call('health').then(
          () => true,
          () => true
        )
        return r && link.agent.state !== 'idle'
      },
      10000
    )
    assert.ok(before !== null, 'we had heard from it')
    await until('a replacement child', () => link.state === 'ready', 20000)
  }
)
