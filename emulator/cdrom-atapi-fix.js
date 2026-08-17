// runtime patches to v86's IDE emulation (v86 src/ide.js), applied to the
// IDEInterface prototype reached through the live cdrom device. they key off
// this.is_atapi, so the hard disks' IDE interfaces (same prototype) keep stock
// behavior. bugs 1-3 only hit URL-mounted (async) discs; file uploads mount as
// in-memory SyncBuffers and dodge them. bug 4 also hits the async hda/hdb images.
//
// bug 1: v86's TEST UNIT READY answers GOOD whenever a disc is present, and its
// medium_changed flag is only consumed by ATA GET MEDIA STATUS (0xDA), which Win98
// never issues. Win98 detects media changes by polling TEST UNIT READY (~every 4s)
// for a not-ready -> ready transition, and the mount flow ejects and re-inserts in
// the same tick, so no poll ever sees the empty drive. real ATAPI drives answer the
// first TEST UNIT READY after a media change with CHECK CONDITION / UNIT ATTENTION /
// "medium may have changed" (sense key 6, additional sense 0x28), which is what
// Win98 keys off; patch 1 adds that response.
//
// bug 2: for an async buffer, v86 answers a READ(10) by holding status = BSY until
// the XHR lands. Win98's PIO CD driver polls status twice, sees BSY, and issues
// DEVICE RESET. measured: BSY (0xD0 or 0x80) earns an instant reset, and a clean
// not-ready error earns ~30 retries within 250ms before CDFS reports failure up the
// stack, so on a slow network every variant ends with E:\ empty. patch 2 hides the
// wait: on a cache miss it forces the CPU into v86's HLT state (checked between
// single instructions, so the driver never polls at all), fetches the chunk, and
// re-dispatches the same packet (this.data still holds it) against the warm cache,
// which completes synchronously with the normal DRQ + IRQ. the driver issues the
// packet with interrupts disabled (observed flags=0x86), so nothing can wake the
// guest mid-command, but v86's main loop treats an in_hlt=1 + IF=0 machine as dead.
// hence three guards: a watchdog releases the CPU if the fetch doesn't land, halting
// is then skipped until some fetch completes again, and save_state() is deferred
// during a halt (pickling the halted CPU into IndexedDB was the prod "VM frozen from
// the moment it boots" bug). a restore also wakes an in_hlt=1 + IF=0 machine, which
// rescues sessions saved before that guard existed; the only legitimate cli+hlt
// state is a shutdown screen, which just re-halts.
//
// bug 3: v86's reset handler aborts in-flight XHRs, throwing away the very fetch the
// retry needs, so every retry starts another cold read. patch 3 orphans pending
// reads instead: guest-facing callbacks are dropped through v86's existing
// cancelled-id plumbing, but the XHRs complete and populate the chunk cache.
//
// bug 4: that abort was also v86's only duplicate-request limiter (it has no
// in-flight dedup of range fetches), so without patch 4 a retry loop starts a new XHR
// for a chunk already downloading; on a link slower than the retry cadence the
// request queue grows without bound, each queued request still transferring a full
// redundant chunk (observed hitting millions of requests under devtools "Slow 4G").
// patch 4 joins an identical concurrent request to the existing fetch. ATAPI allows a
// single outstanding command, so the in-flight set stays tiny.
//
// patch 4 also owns failure recovery, because v86's load_file never calls back on a
// failed ranged load: it deliberately aborts (no retry, no callback) when a server
// answers a ranged request with 200 + the full body, which Cloudflare's edge does
// sporadically (first touch of the preset ISO; later an hdb.img read in prod). that
// wedges the in-flight entry forever, since every later request joins a fetch that
// will never land (the prod "mount freezes the VM and the network goes silent" bug).
// each entry now re-issues its fetch on a timer (a repeat attempt gets a clean 206)
// and gives up after a few tries, freeing the entry so a later guest access starts
// fresh. the same 200-for-ranged-request failure hits the hard disk images, where an
// aborted read likewise has no retry and a C:\ or D:\ access hangs until the guest's
// own long disk timeout, so patch 4's wrapper is applied to hda's and hdb's buffers
// at startup too. the patch 2 halt machinery stays CD-only: Win98 is patient with
// hard disks

export function installAtapiCdromFix(emulator) {
  emulator.add_listener('emulator-started', () => {
    // no public API for any of this, so feature-detect every internal we touch and
    // degrade to stock behavior if a v86 upgrade moves it
    const cdrom = emulator.v86?.cpu?.devices?.cdrom
    if (!cdrom) return
    const proto = Object.getPrototypeOf(cdrom)
    if (proto.__atapiCdromFixInstalled) return
    const ok =
      typeof proto.atapi_handle === 'function' &&
      typeof proto.atapi_check_condition_response === 'function' &&
      typeof proto.cancel_io_operations === 'function' &&
      typeof proto.set_cdrom === 'function' &&
      typeof proto.eject === 'function' &&
      typeof proto.push_irq === 'function' &&
      'medium_changed' in cdrom &&
      cdrom.in_progress_io_ids instanceof Map &&
      cdrom.cancelled_io_ids instanceof Set
    if (!ok) {
      console.warn(
        'cdrom-atapi-fix: v86 internals changed, patches not applied'
      )
      return
    }
    proto.__atapiCdromFixInstalled = true

    // bumped by anything that invalidates an in-flight command (reset, eject, disc
    // swap) so a halt-fetch that raced one won't complete an abandoned command
    let generation = 0

    // once a halt-fetch times out, stop halting until some fetch completes again
    let haltUntrusted = false
    const HALT_WATCHDOG_MS = 5000

    // saving while the CPU is parked by a halt-fetch would persist in_hlt=1 with the
    // guest's IF=0, a machine that can never wake, so save_state() waits it out
    let cpuHalted = false
    const origSaveState = emulator.save_state.bind(emulator)
    emulator.save_state = async function () {
      if (cpuHalted) {
        await new Promise((resolve) => {
          const poll = setInterval(() => {
            if (!cpuHalted) {
              clearInterval(poll)
              resolve()
            }
          }, 100)
          setTimeout(() => {
            clearInterval(poll)
            resolve()
          }, HALT_WATCHDOG_MS + 1000)
        })
      }
      return origSaveState()
    }

    // wake a machine restored into the unwakeable state (saved mid-halt by an older
    // build, or an import of such an export). runs now because the initial restore
    // already happened before emulator-started, and again after every import
    const unbrick = () => {
      const cpu = emulator.v86?.cpu
      if (cpu?.in_hlt?.[0] && cpu.flags && !(cpu.flags[0] & 0x200)) {
        cpu.in_hlt[0] = 0
      }
    }
    unbrick()
    const origRestoreState = emulator.restore_state.bind(emulator)
    emulator.restore_state = async function (state) {
      const r = await origRestoreState(state)
      unbrick()
      return r
    }

    const cachedRead = (buffer, start, len) => {
      try {
        return buffer.get_from_cache(start, len)
      } catch {
        return null
      }
    }

    const origAtapiHandle = proto.atapi_handle
    proto.atapi_handle = function () {
      const cmd = this.data[0]

      // patch 1: first TEST UNIT READY (packet byte 0 === 0) after an insert reports
      // UNIT ATTENTION / "medium may have changed", once. mirrors v86's own "command
      // without medium" branch: check-condition response + IRQ, no command dispatch
      if (this.is_atapi && this.buffer && this.medium_changed && cmd === 0) {
        this.medium_changed = false
        this.data_pointer = 0
        this.current_atapi_command = 0
        this.atapi_check_condition_response(6, 0x28)
        this.push_irq()
        return
      }

      // patch 2: READ(10)/READ(12) that misses the chunk cache halts the CPU, fetches,
      // re-dispatches warm. sync buffers have no get_from_cache and fall through to
      // the stock (always-synchronous) path
      if (
        (cmd === 0x28 || cmd === 0xa8) &&
        this.is_atapi &&
        this.buffer &&
        typeof this.buffer.get_from_cache === 'function' &&
        this.cpu?.in_hlt
      ) {
        const lba =
          ((this.data[2] << 24) |
            (this.data[3] << 16) |
            (this.data[4] << 8) |
            this.data[5]) >>>
          0
        const count =
          cmd === 0xa8
            ? ((this.data[6] << 24) |
                (this.data[7] << 16) |
                (this.data[8] << 8) |
                this.data[9]) >>>
              0
            : (this.data[7] << 8) | this.data[8]
        const start = lba * this.sector_size
        const len = count * this.sector_size
        if (
          len > 0 &&
          start + len <= this.buffer.byteLength &&
          !cachedRead(this.buffer, start, len) &&
          !haltUntrusted
        ) {
          const myGen = ++generation
          // BSY for the handful of instructions that still run before the halt lands,
          // the same interim status stock v86 shows
          this.status_reg = 0xd0
          this.cpu.in_hlt[0] = 1
          cpuHalted = true
          let landed = false
          const watchdog = setTimeout(() => {
            if (landed) return
            haltUntrusted = true
            cpuHalted = false
            this.cpu.in_hlt[0] = 0
          }, HALT_WATCHDOG_MS)
          this.buffer.get(start, len, () => {
            landed = true
            clearTimeout(watchdog)
            haltUntrusted = false // fetches complete again
            if (generation === myGen) origAtapiHandle.call(this)
            cpuHalted = false
            this.cpu.in_hlt[0] = 0
          })
          return
        }
      }

      return origAtapiHandle.call(this)
    }

    // patch 3: on device reset, orphan the pending reads instead of aborting them.
    // marking the ids cancelled makes read_buffer drop the guest callback when the
    // response lands (v86 already has that plumbing), and skipping abort() lets the
    // response land at all, filling the chunk cache for the guest's retry
    const origCancel = proto.cancel_io_operations
    proto.cancel_io_operations = function () {
      if (!this.is_atapi) return origCancel.call(this)
      generation++
      for (const id of this.in_progress_io_ids.keys())
        this.cancelled_io_ids.add(id)
      this.in_progress_io_ids.clear()
    }

    const origEject = proto.eject
    proto.eject = function () {
      if (this.is_atapi) generation++
      return origEject.call(this)
    }

    // patch 4: dedup + retry for a disk buffer's range fetches. identical concurrent
    // requests share one fetch and every requester's callback still runs. synchronous
    // buffers (uploads) complete get() inline, so their in-flight window is zero
    const RETRY_MS = 8000
    const MAX_ATTEMPTS = 4
    const makeReadsResilient = (buffer) => {
      if (
        !buffer ||
        typeof buffer.get !== 'function' ||
        buffer.__resilientReads
      )
        return
      buffer.__resilientReads = true
      const origGet = buffer.get.bind(buffer)
      const inflight = new Map()
      buffer.get = (offset, length, fn, options) => {
        const key = offset + ':' + length
        const existing = inflight.get(key)
        if (existing) {
          existing.waiters.push(fn)
          return
        }
        const entry = { waiters: [fn], attempts: 0, timer: 0 }
        inflight.set(key, entry)
        const attempt = () => {
          clearTimeout(entry.timer)
          if (++entry.attempts > MAX_ATTEMPTS) {
            // waiters are dropped, never fed fabricated data; freeing the entry lets a
            // later guest access start a fresh fetch
            inflight.delete(key)
            return
          }
          entry.timer = setTimeout(attempt, RETRY_MS)
          origGet(
            offset,
            length,
            (data) => {
              if (inflight.get(key) !== entry) return // superseded attempt
              clearTimeout(entry.timer)
              inflight.delete(key)
              for (const w of entry.waiters) w(data)
            },
            options
          )
        }
        attempt()
      }
    }

    // the hard disks' buffers exist from boot; a disc buffer only ever enters the
    // drive through set_cdrom() (a reload comes back with an empty drive)
    const primary = emulator.v86.cpu.devices.ide?.primary
    makeReadsResilient(primary?.master?.buffer)
    makeReadsResilient(primary?.slave?.buffer)
    const origSetCdrom = proto.set_cdrom
    proto.set_cdrom = function (buffer) {
      if (this.is_atapi) generation++
      makeReadsResilient(buffer)
      return origSetCdrom.call(this, buffer)
    }
  })
}
