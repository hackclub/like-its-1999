// window.like99: the console for inspecting and driving this machine
//
// anything that writes into the guest or onto the wire is dev-only; import.meta.env.DEV is
// inlined by Vite so the whole block is dead-code-eliminated from a production build
// rather than merely hidden
//
// everything here returns something JSON-serialisable: these get called through CDP
// evaluate_script, which drops functions, Maps and class instances silently

import { openLiveFs } from './vmfs/filebrowser.js'
import {
  encode,
  createDecoder,
  decodeFields,
  fieldText,
  TYPES,
  TYPE_NAMES,
} from './daemon/frame.js'
import { sha256hex } from './savefile.js'

export async function until(what, fn, timeout = 10000, every = 50) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeout)
      throw new Error(`timed out after ${timeout}ms waiting for ${what}`)
    await new Promise((r) => setTimeout(r, every))
  }
}

export function installDebug({
  emulator,
  link,
  world,
  params,
  instanceId,
  save,
}) {
  // alive, wedged and asleep look identical from outside:
  //   running + parked in HLT      healthy and idle
  //   running + never idle         the Force Reboot wedge (ring-0 spin)
  //   svga off, geometry intact    windows blanked the display after inactivity
  const machine = async () => {
    const cpu = emulator.v86.cpu
    const vga = cpu.devices.vga
    const uart = cpu.devices.uart0
    const samples = []
    for (let i = 0; i < 4; i++) {
      samples.push({
        eip: cpu.instruction_pointer[0] >>> 0,
        hlt: !!cpu.in_hlt[0],
      })
      await new Promise((r) => setTimeout(r, 120))
    }
    const idle = samples.some((s) => s.hlt)
    const moving = new Set(samples.map((s) => s.eip)).size > 1
    return {
      running: emulator.is_running(),
      // half a second of samples is enough to recognise a healthy idle machine and not
      // enough to convict a busy one: a cold boot can spend a while in a tight startup
      // loop that looks exactly like the wedge, hence the hedge
      verdict: idle
        ? 'idle in HLT (healthy)'
        : moving
          ? 'busy executing'
          : 'no idle and no progress in 0.5s — sample again before calling it a wedge',
      display: {
        svgaEnabled: !!vga?.svga_enabled,
        geometry: [vga?.svga_width, vga?.svga_height],
        // geometry intact with SVGA off is windows powering the display down, not damage
        blanked: !vga?.svga_enabled && !!vga?.svga_width,
      },
      // DTR goes high while a program holds the port, which is how you tell a running
      // agent from a dead one when it has gone quiet
      port: {
        heldByAProgram: !!(uart?.modem_control & 1),
        interruptsEnabled: !!uart?.ier,
        baudDivisor: uart?.baud_rate,
        queuedToGuest: uart?.input?.length ?? 0,
      },
    }
  }

  // a live win98 desktop reads as ~98% non-black with thousands of colours and a band of
  // #c0c0c0 along the bottom
  const screen = async () => {
    const img = emulator.screen_make_screenshot()
    if (!img) return { available: false }
    if (img.decode) await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    if (!c.width || !c.height) return { available: false }
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    const colours = new Set()
    let lit = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 24) lit++
      if (colours.size < 4096)
        colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
    }
    const bottom = ctx.getImageData(
      0,
      Math.max(0, c.height - 6),
      c.width,
      1
    ).data
    let grey = 0
    for (let i = 0; i < bottom.length; i += 4)
      if (
        Math.abs(bottom[i] - 192) < 20 &&
        Math.abs(bottom[i + 1] - 192) < 20 &&
        Math.abs(bottom[i + 2] - 192) < 20
      )
        grey++
    const litPct = Math.round((100 * lit) / (data.length / 4))
    const taskbarPct = Math.round((100 * grey) / c.width)
    return {
      available: true,
      size: [c.width, c.height],
      litPct,
      colours: colours.size >= 4096 ? '4096+' : colours.size,
      taskbarPct,
      looksLikeDesktop: litPct > 50 && taskbarPct > 40,
    }
  }

  // flattened because the live object holds a Map and would serialise to nothing
  const agent = () => {
    const a = link.agent
    return {
      state: a.state,
      role: a.role,
      version: a.ver,
      runningHash: a.hash,
      wantHash: a.wantHash,
      wantBytes: a.wantBytes?.length ?? null,
      caps: a.caps,
      pushedHash: a.pushedHash,
      transfer: a.transfer ? { ...a.transfer } : null,
      pendingCalls: [...a.pending.values()].map((c) => c.fn),
      msSinceHeard: a.lastHeard === null ? null : Date.now() - a.lastHeard,
      statuses: a.statuses.slice(-12),
    }
  }

  const tracking = () => ({ state: link.state, ...link.summary() })

  // newest last; kinds filters, since a long session is mostly activity spans and the
  // interesting lines are the window changes and agent marks
  const log = (kinds) => {
    const lines = link.log.lines
    return kinds ? lines.filter((l) => kinds.includes(l.ev)) : lines
  }

  // read from the live disk buffers, so it includes guest writes no save has captured yet
  const fs = {
    async ls(path = '/', disk = 'hda') {
      const f = await openLiveFs(emulator, disk)
      const entries = await f.readdir(path)
      return entries.map((e) => ({
        name: e.name,
        dir: !!e.isDir,
        size: e.size,
        mtime: e.mtime,
      }))
    },
    async read(path, disk = 'hda', { text = true } = {}) {
      const f = await openLiveFs(emulator, disk)
      const bytes = await f.readFile(path)
      return text ? new TextDecoder().decode(bytes) : [...bytes]
    },
  }

  const base = {
    world,
    params,
    instanceId,
    save,
    machine,
    screen,
    agent,
    tracking,
    log,
    fs,
    until,
  }
  if (!import.meta.env.DEV) return base

  // both halves of every conversation on the wire, decoded
  const capture = ({ limit = 500 } = {}) => {
    const dec = createDecoder()
    const frames = []
    const started = Date.now()
    emulator.add_listener('serial0-output-byte', (b) => {
      for (const f of dec.push(Uint8Array.of(b))) {
        const fields = decodeFields(f.payload)
        if (frames.length >= limit) frames.shift()
        frames.push({
          ms: Date.now() - started,
          type: TYPE_NAMES[f.type] ?? `0x${f.type.toString(16)}`,
          // summarised: a pushed binary would otherwise bury the log
          fields: fields
            ? fields.map((x) =>
                x.length > 64 ? `<${x.length} bytes>` : fieldText(x)
              )
            : 'unparseable',
        })
      }
    })
    return {
      frames,
      of: (type) => frames.filter((f) => f.type === type),
      wait: (pred, ms = 8000) =>
        until('a matching frame', () => frames.find(pred), ms),
    }
  }

  const wire = {
    capture,
    // types are named or numeric: wire.send('PING', [like99.dev.link.agent.epoch, '1'])
    send: (type, fields) =>
      emulator.serial_send_bytes(
        0,
        encode(typeof type === 'string' ? TYPES[type] : type, fields)
      ),
  }

  const execFull = async (cmd) => {
    const [code = '0', output = ''] = await link.call('exec', [String(cmd)])
    return { code: Number(code), output: output.replace(/\r\n/g, '\n') }
  }

  // the capability list is a hardcoded string, so it cannot tell you a capability silently
  // does nothing on real windows in a way no host test reproduces (the child opening a
  // port the parent already held; a working directory on the CD that stopped COMMAND.COM
  // launching). this exercises each one for real, and the dev build runs it on every
  // connect
  const selftest = async () => {
    const checks = {}
    const run = async (name, fn) => {
      try {
        checks[name] = { ok: true, ...(await fn()) }
      } catch (e) {
        checks[name] = { ok: false, error: e.message }
      }
    }
    await run('health', async () => {
      const [ver, uptime, exe, diag] = await link.call('health')
      return { ver, uptime: Number(uptime), exe, diag }
    })
    // an empty foreground is a legitimate answer: windows genuinely has no foreground
    // window when the launching folder closes, so only a failure to answer is a failure
    await run('getForeground', async () => {
      const [exe, title] = await link.call('getForeground')
      return { exe, title }
    })
    await run('exec', async () => {
      const { output } = await execFull('ver')
      if (!/windows/i.test(output))
        throw new Error(`'ver' printed something unexpected: ${output.trim()}`)
      return { output: output.trim() }
    })
    const failed = Object.entries(checks).filter(([, c]) => !c.ok)
    return { ok: failed.length === 0, checks }
  }

  // re-armed whenever the connection drops, so a reconnect after a Force Reboot or a fresh
  // push is checked again rather than trusted because an earlier child passed
  let checking = false
  let checkedFor = null
  setInterval(async () => {
    if (link.state !== 'ready') {
      checkedFor = null
      return
    }
    if (checking || checkedFor === link.agent.hash) return
    checking = true
    try {
      const result = await selftest()
      checkedFor = link.agent.hash
      if (result.ok)
        console.debug('guest agent self-test passed', result.checks)
      else console.warn('guest agent self-test FAILED', result.checks)
    } finally {
      checking = false
    }
  }, 2000)

  // goes through the real agent rather than reimplementing the transfer: a second pusher
  // racing the agent's own would interleave chunks and fail
  const pushChild = async (
    url = '/emulator/daemon/bin/child.bin',
    timeout = 60000
  ) => {
    const resp = await fetch(`${url}?v=${Date.now()}`)
    if (!resp.ok) throw new Error(`fetch failed (${resp.status})`)
    const bytes = new Uint8Array(await resp.arrayBuffer())
    const hash = (await sha256hex(bytes)).slice(0, 32)
    const started = Date.now()
    link.setWanted({ hash, bytes })
    await until(
      'the child to be running',
      () => link.agent.hash === hash && link.state === 'ready',
      timeout
    )
    return { hash, bytes: bytes.length, ms: Date.now() - started }
  }

  const mountIso = async (url) => {
    const head = await fetch(url, { method: 'HEAD' })
    const size = Number(head.headers.get('content-length'))
    if (!size) throw new Error(`no content-length for ${url}`)
    emulator.eject_cdrom()
    await emulator.set_cdrom({ url, size, async: true })
    return { url, size }
  }

  // the guest does the copying, off a CD, because the host cannot write to the guest's
  // filesystem: vmfs/fat.js reads FAT, and writing it would mean a cluster allocator, both
  // FAT copies, VFAT long names and a race with windows' own disk cache
  //
  // windows runs any executable it finds in the StartUp folder, so there is no .lnk to
  // author and no WIN.INI to edit. the child goes in beside it under its hash, which makes
  // the first announce after a boot a cache hit that transfers nothing
  //
  // build the disc first: node scripts/daemon-iso.mjs. do not reload the page afterwards
  // until the snapshot is taken; a reload restores state.bin.zst and a fresh block cache,
  // and the copied files live only in the overlay
  const installDaemon = async ({ iso = '/tmp-daemon.iso' } = {}) => {
    const hash = link.agent.wantHash
    if (!hash) throw new Error('the host has no child build to install')
    const disc = await mountIso(iso)
    await until('the disc to be readable', async () => {
      const { code } = await execFull('dir E:\\DAEMON.EXE')
      return code === 0
    })

    // the StartUp folder needs both of its names and neither accepts the other's:
    // COMMAND.COM wants the 8.3 alias, which dir /ad prints beside the long name, and
    // fat.js resolves the long one because that is what the VFAT directory entry says
    const startup = await until('the StartUp folder', async () => {
      const { output } = await execFull('dir C:\\WINDOWS /ad')
      const alias = output.match(/^(\S+)\s+<DIR>.*\bStart Menu\s*$/m)?.[1]
      if (!alias) return null
      const short = `C:\\WINDOWS\\${alias}\\PROGRAMS\\STARTUP`
      const { code } = await execFull(`dir ${short}`)
      return code === 0
        ? { short, long: '/WINDOWS/Start Menu/Programs/StartUp' }
        : null
    })

    await execFull('md C:\\1999')
    await execFull('md C:\\1999\\CACHE')

    // copy, then prove it by size, because COMMAND.COM's copy prints "Sharing violation
    // ... 0 file(s) copied" and still exits 0, and windows locks a running executable so
    // re-installing over a daemon that is already running silently leaves the old bytes in
    // place (cold boot to replace it). sizes come from the guest on both sides (dir for
    // the disc, fs.ls for the disk)
    const discSize = async (name) => {
      const { output } = await execFull(`dir E:\\${name}`)
      const n = output.match(/^\S+\s+\S+\s+([\d,]+)\s/m)?.[1]
      if (!n) throw new Error(`cannot read the size of ${name} on the disc`)
      return Number(n.replace(/,/g, ''))
    }
    const copy = async (from, toDir, toName, longDir) => {
      const want = await discSize(from)
      const { output } = await execFull(`copy E:\\${from} ${toDir}\\${toName}`)
      // fs.ls reads the overlay, and a file still in windows' write cache is not there yet
      const got = await until(
        `${toName} to reach the disk`,
        async () =>
          (await fs.ls(longDir)).find(
            (e) => e.name.toUpperCase() === toName.toUpperCase()
          )?.size,
        15000
      ).catch(() => null)
      if (got !== want)
        throw new Error(
          `${toName} did not install (${got ?? 'missing'} bytes on disk, ${want} on the ` +
            `disc). COMMAND.COM said: ${output.trim() || 'nothing'}`
        )
      return want
    }

    const bytes = {
      daemon: await copy(
        'DAEMON.EXE',
        startup.short,
        'DAEMON.EXE',
        startup.long
      ),
      child: await copy(
        'CHILD.BIN',
        'C:\\1999\\CACHE',
        `${hash}.EXE`,
        '/1999/CACHE'
      ),
    }

    // every other cached build goes: this machine is on its way into a snapshot everyone
    // starts from. a currently running child cannot be deleted, which is fine, it is the
    // one we just installed
    const stale = (await fs.ls('/1999/CACHE'))
      .map((e) => e.name)
      .filter((n) => n.toUpperCase() !== `${hash.toUpperCase()}.EXE`)
    for (const name of stale) await execFull(`del C:\\1999\\CACHE\\${name}`)
    return {
      disc,
      bytes,
      startup: startup.short,
      cachedChild: `${hash}.EXE`,
      removed: stale,
      cache: (await fs.ls('/1999/CACHE')).map((e) => e.name),
    }
  }

  return {
    ...base,
    dev: {
      // exec('ver') -> "Windows 98 [Version 4.10.2222]". line endings are normalised
      // because CRLF renders as literal \r\n through a JSON round trip. a non-zero exit is
      // not an error here, since plenty of useful commands print to stdout and exit
      // non-zero; use execFull when the code matters. rejects only when the guest could
      // not run the command at all
      //
      // the client-side gate is fine: it reaches only the caller's own emulator in their
      // own tab, and exec runs in the child, so the worst case is a respawn
      exec: async (cmd) => (await execFull(cmd)).output,
      execFull,
      foreground: () => link.call('getForeground'),
      health: () => link.call('health'),
      selftest,
      wire,
      pushChild,
      installDaemon,
      // the eject matters: win98 detects media by polling TEST UNIT READY, and what it
      // reacts to is the UNIT ATTENTION that cdrom-atapi-fix.js synthesises from v86's
      // medium-changed flag on a not-ready to ready transition. calling set_cdrom() on a
      // drive the guest already believes is empty leaves it believing that, and the guest
      // answers "E:\ is not accessible, the device is not ready". same sequence
      // cdrom-ui.js uses
      mountIso,
      // how a new state.bin.zst gets made: zstd -19 dev-state.bin -o state.bin.zst. the
      // save path wraps the same bytes in a .99sv container, which the image build cannot
      // use
      async dumpState(name = 'dev-state.bin') {
        const bytes = new Uint8Array(await emulator.save_state())
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([bytes]))
        a.download = name
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 10000)
        return { name, bytes: bytes.length }
      },
      link,
      emulator,
    },
  }
}
