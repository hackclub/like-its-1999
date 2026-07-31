# Guest <-> host wire protocol

How the in-guest agent talks to the page over the emulated serial port, how it gets
updated, and how it repairs itself. **Spec only — nothing here is implemented yet.**

Written down before the code because the shape of this protocol decides what the save
container has to hold (`../savefile.js`), and because one piece of it (the stub) ships
inside the disk image, where mistakes are expensive to fix.

## Why a serial port

Time tracking needs to know what the user is actually doing inside Win98: which program
is in front, whether they are typing into EditPlus or clicking around Paint Shop Pro.
The host can see keystrokes, but not which window received them, and v86 exposes disk
images as raw bytes with no file-level events. A background process in the guest can
see all of it, and the UART is the one bidirectional, real-time channel v86 gives us.

Win98 can't help here over the network: its TLS is far too old for anything modern, and
`hackatime`-style HTTPS heartbeats from inside the guest are impossible.

## Transport

**COM1 (`uart0`), 115200 8N1, no flow control.**

v86 always creates `uart0`; `uart1`/COM2 exists only when the machine is configured with
`uart1: true`. That flag is part of a world's identity (`../worlds.js`), because
`restore_state` touches uart1's state only when the device exists — so a state captured
without COM2 would fault when restored into a machine that has it. Using COM1 keeps the
daemon out of that entirely: no new world, and no question about whether Win98 enumerates
the port.

Caveat to remember: v86's optional modem binds `serial0`. We don't enable it. If a modem
is ever added, the daemon moves to COM2 and that becomes a new world.

Host side: `emulator.serial_send_bytes(0, bytes)` to write,
`emulator.add_listener('serial0-output-byte', cb)` to read. Guest side: ordinary
`CreateFile("COM1", ...)` plus `SetCommState`. Don't rely on baud timing or on RTS/CTS;
v86 does not model either faithfully.

## Framing

```
39 39            sync word ("99")
type    u8       message type
flags   u8       bit 0 = more fragments follow; all other bits reserved
len     u32le    payload length
payload len bytes
crc32   u32le    CRC-32 (IEEE, the zlib polynomial) of type+flags+len+payload
```

`len` is a full u32: the format sets no size ceiling, senders fragment large payloads,
and a receiver may cap what it is willing to buffer (suggested: 64 KiB per frame,
32 KiB payload chunks for binaries).

Three rules make this extensible forever, and they are requirements, not conventions:

1. **Unknown frame types MUST be skipped, not treated as errors.** Length plus CRC means
   any reader can step over a message it has never heard of. This is what lets either
   side introduce new messages unilaterally.
2. **Unknown flag bits MUST cause the frame to be skipped**, so a future flag can change
   a payload's meaning without an old reader misreading it.
3. **Resync by scanning for the sync word** and validating `len` and CRC. Never assume
   the stream starts at a frame boundary — see the restore section.

## Message types

`0x01-0x0F` is the **frozen range**: the small common language that every guest-side
component implements forever, so the host can talk to whatever happens to be alive
without knowing which it is. `0x10+` is the daemon layer, free to change at any time.

| type   | dir     | payload                                  | meaning                                     |
| ------ | ------- | ---------------------------------------- | ------------------------------------------- |
| `0x01` | both    | —                                        | RESET: drop partial frames and stream state |
| `0x02` | host->g | `{proto, wantDaemon, hostTime}`          | ANNOUNCE: host is listening                 |
| `0x03` | g->host | `{role, proto, ver, caps, bootId, tick}` | IDENT: who is alive (`role: stub\|daemon`)  |
| `0x04` | host->g | `{ver, len, crc32, name}`                | PAYLOAD_BEGIN                               |
| `0x05` | host->g | raw bytes                                | PAYLOAD_DATA                                |
| `0x06` | host->g | `{crc32}`                                | PAYLOAD_END                                 |
| `0x07` | host->g | `{ver}`                                  | RUN: launch this cached version             |
| `0x08` | g->host | `{code, detail}`                         | STATUS: progress and errors                 |
| `0x09` | both    | `{n}`                                    | PING                                        |
| `0x0A` | both    | `{n}`                                    | PONG                                        |
| `0x0B` | host->d | `{ver}`                                  | UPGRADE: you are stale, hand over           |
| `0x10` | host->d | `{caps, sampleMs}`                       | ENABLE: start reporting                     |
| `0x11` | d->host | NDJSON sample lines                      | SAMPLE                                      |
| `0x12` | both    | —                                        | FLUSH (and its ack)                         |
| `0x13` | host->d | JSON                                     | CTRL: everything else                       |
| `0x14` | d->host | `{level, msg}`                           | LOG                                         |

`0x80+` is reserved for local experiments; a released build must not depend on it.

JSON payloads are UTF-8. Anything genuinely new (richer samples, pushing a file or a
program installer into the guest, whatever we invent later) gets a type in the daemon
range and needs no change here and no change to the stub.

## Components

```
C:\1999\STUB.EXE            frozen bootstrap, ships in the image, launched at startup
C:\1999\CACHE\<ver>.EXE     daemon versions the host has sent
C:\1999\CACHE\GOOD.TXT      last version that ran longer than 60 s
C:\1999\ALIVE               liveness file the running daemon touches
```

**The stub is a bootstrap, not a protocol participant.** It speaks only the frozen
range, never parses a daemon payload's semantics (CRC32 only), and after launching the
daemon it **closes the port and holds no protocol state**. Everything expressive lives
in the daemon, which is a host-side asset we can replace at will.

**The stub is itself replaceable.** Because it has already exited by then, a running
daemon can overwrite `STUB.EXE` for the next boot. Nothing in the image is permanent.

**Port ownership.** Only one process can hold COM1. The daemon holds it while alive; the
stub opens it only when no daemon is running, and the daemon closes it before handing
back.

## Lifecycle

The machine is **restored running**, essentially never rebooted: a saved snapshot comes
back with the daemon already executing mid-instruction and the stub long gone, and it
may land in a newer version of the site that wants a newer daemon. Every rule below
exists because of that.

**The host always initiates and never assumes who is alive.** On page load it sends
`RESET`, then `ANNOUNCE` every 2 s until it gets an `IDENT`. Both stub and daemon
implement `IDENT`, so one exchange identifies whatever is there. After ~15 s of silence
the host reports tracking unavailable and keeps announcing at a slower rate — an agent
that shows up later (an older world, a crash, a guest that was busy) still connects.

Then, by case:

- **Daemon alive, wanted version.** Host sends `ENABLE`. Tracking resumes. Nothing
  restarts, nothing reboots.
- **Daemon alive, stale version.** Host sends `UPGRADE`, then `PAYLOAD_*`. The daemon
  **flushes its pending samples first** so the swap costs no tracked time, writes
  `CACHE\<ver>.EXE`, verifies CRC, launches `STUB.EXE`, closes the port and exits. The
  stub takes over, `IDENT`s as `stub`, and launches the new daemon, which lands in the
  case above. A live upgrade, no guest reboot, nothing lost.
- **Stub alive** (fresh boot, or the daemon died). Host either confirms its cached
  version with `RUN` or streams a payload first. Then the case above.
- **No payload available** (host offline, asset missing): keep running the old daemon.
  Something running beats nothing running.

**Downgrade tolerance.** The host MUST accept an older daemon and degrade by capability
rather than refusing to track. `caps` in `IDENT` is the negotiation, not the version
number.

**Self-repair is the stub's job, out of band.** It cannot listen on the port while the
daemon owns it, so it supervises two other ways: it waits on the daemon's process handle,
and it checks `ALIVE` (touched every 5 s). A dead process _or_ an `ALIVE` older than 30 s
means kill and relaunch — the file catches hangs, which a process handle alone cannot.
Relaunch backs off 1s, 2s, 4s, ... capped at 60s; after three consecutive failures of a
version it falls back to `GOOD.TXT`. If no host answers within 10 s the stub launches its
cached daemon anyway, so a machine restored with no page listening never hangs.

**Frame-level resync after a restore.** The UART device state is serialized into a v86
state, but the host's JS reassembly buffer is not, so a partial frame can straddle a
save. The host's opening `RESET` plus sync-word scanning covers it, and re-announcing is
idempotent — an `ANNOUNCE` arriving at any time is always safe to answer.

## Time and identity

**Host time is authoritative.** A restored guest resumes with a stale RTC, so guest
timestamps can repeat, jump or run backwards. The guest reports `bootId` (fresh per
process start) and a monotonic `GetTickCount`, which are **ordering hints only**; the
host stamps real time onto every sample.

The host also mints an `instanceId` per restore and records it in the container's
provenance chain, because one saved machine can be restored many times and fork
overlapping sample ranges. Overlapping ranges from forks are deduped conservatively,
never summed — the alternative is double-counted hours in a submission, which is exactly
what review fines exist for.

## Samples

One NDJSON line per sample, matching the `heartbeats` chunk in a save container:

```json
{
  "t": 1753977600,
  "bootId": "…",
  "tick": 84213,
  "win": "index.html - EditPlus",
  "exe": "EDITPLUS.EXE",
  "keys": 47,
  "clicks": 12
}
```

Fields are additive and unknown fields are ignored on both sides, so the sample schema
grows without touching the protocol version. The guest stays dumb: it reports the
foreground window (`GetForegroundWindow` + `GetWindowText`) and coarse activity counts;
the host merges its own keystroke and mouse observations and does the interpreting.

Per-application attribution is not a nicety. Review rules cap art and asset time at 25%
of approved hours, and separating EditPlus time from Paint Shop Pro time is what makes
that number defensible instead of guessed.

## Build and install

- **Build:** Open Watcom, `wcl386 -bt=nt -l=nt`, cross-compiled on macOS. It genuinely
  targets Win32-on-Win9x, runs headless, and needs no in-guest build step, so daemon
  iteration stays scriptable. Prebuilt binaries are checked in, since the image build is
  offline.
- **Install:** drop `STUB.EXE` plus a StartUp shortcut into the image offline with
  `mtools` (see `../../tmp-image-build/BUILD.md`). No in-guest installer, no
  human-driven step.
- The daemon is platform code, not something a participant runs, so the "everything you
  build with shipped before 2000" rule doesn't bind it.
