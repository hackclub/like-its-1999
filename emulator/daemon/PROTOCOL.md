# Guest <-> host wire protocol

How the in-guest agent talks to the page over the emulated serial port, how it gets
updated, and how it repairs itself.

**Status:** the host half is implemented (`frame.js`, `agent.js`, `link.js`). The guest
half is not written yet; the C comes next.

## Why a serial port

Time tracking needs to know what the user is doing inside Win98: which program is in
front, and whether they are typing into EditPlus or clicking around Paint Shop Pro. The
host sees every keystroke it synthesizes but not which window received it, and v86 exposes
disk images as raw bytes with no file-level events. A background process in the guest sees
all of it, and the UART is the one bidirectional real-time channel v86 gives us.

Nothing over the network can help: Win98's TLS is far too old for a modern endpoint, so
HTTPS heartbeats from inside the guest are impossible.

## Transport

**COM1 (`uart0`), 115200 8N1, no flow control.**

v86 always creates `uart0`; `uart1`/COM2 exists only when the machine is configured with
`uart1: true`. That flag is part of a world's identity (`../worlds.js`), because
`restore_state` touches uart1 state only when the device exists, so a state captured
without COM2 would fault when restored into a machine that has it. COM1 keeps the daemon
out of that entirely: no new world, and no question about whether Win98 enumerates the
port.

Caveat: v86's optional modem binds `serial0`. We don't enable it. If a modem is ever
added, the daemon moves to COM2 and that becomes a new world.

Host side: `emulator.serial_send_bytes(0, bytes)` out,
`emulator.add_listener('serial0-output-byte', cb)` in. Guest side: ordinary
`CreateFile("COM1", ...)` plus `SetCommState`.

Two properties of the emulation worth knowing, both verified in `libv86.mjs`, because they
decide what this protocol does _not_ need to do:

- **Neither direction can drop bytes.** Host to guest, `data_received` pushes onto an
  unbounded JS array and raises an interrupt. Guest to host, `write_data` dispatches
  synchronously to the host listener; the transmit register is always reported empty, so
  the guest never blocks. There is therefore no windowing, no acknowledgement of receipt,
  and no retransmission anywhere in this protocol. Flow control would be protecting
  against a loss that cannot happen.
- **Queued bytes survive a snapshot.** That input array is serialized into a v86 state, so
  bytes queued when a save was taken arrive again when it is restored, possibly to a
  different page. This is why epochs exist (below).

Do not rely on baud timing or on RTS/CTS; v86 models neither faithfully.

## Framing

```
39 39            sync word ("99")
type    u8       message type
flags   u8       reserved, must be zero
len     u32le    payload length, <= 65536
payload len bytes
crc32   u32le    CRC-32 (IEEE, the zlib polynomial) over type+flags+len+payload
```

**There is no fragmentation.** `len` is capped at 64 KiB and that cap is normative: a
receiver MUST discard a frame header claiming more, and a sender MUST NOT emit one.
Anything larger is a sequence of messages at the level above (see `PAYLOAD_*`), never a
split frame. An earlier draft had a "more fragments follow" flag, which contradicted the
rule that unknown flag bits make a frame skippable: an old reader skipping a fragment
would leave reassembly state that never completes, and with no message id it could
silently splice unrelated bytes together. Removing fragmentation removes the whole class,
and costs nothing because the largest thing we ever send is a ~40 KB binary.

Three rules make the envelope extensible, and they are requirements, not conventions:

1. **Unknown frame types MUST be skipped, not treated as errors.** Length plus CRC lets
   any reader step over a message it has never heard of, which is what allows either side
   to add messages unilaterally, forever.
2. **Frames with any flag bit set MUST be skipped.** All bits are reserved today, so a
   future flag can change a payload's meaning without an old reader misreading it.
3. **Resync by scanning for the sync word**, then validating length and CRC. Never assume
   the stream starts on a frame boundary: it does not after a restore, and a false sync
   word inside a payload is normal. **Both sides** resync this way. The guest needs it as
   much as the host, since the emulated FIFO comes back populated from before a save.

### Payload encoding

Payloads are a **field list**, not JSON:

```
count   u8        number of fields
  len   u16le     bytes in this field
  bytes len       raw
  ... repeated count times
```

Numbers are sent as decimal text in a field. There is no escaping because there is nothing
to escape, which is the point: window titles legitimately contain quotes, backslashes,
tabs and (via some programs) newlines, and every text protocol that meets them needs an
escaping scheme that both a C emitter and a JS parser have to agree on exactly. Length
prefixes are trivial in both. The dev console decodes frames for debugging.

## Message types

`0x01-0x1F` is the **frozen range**: the vocabulary every guest-side component implements
forever, so the host can talk to whatever happens to be alive without knowing which it is.
`0x20-0x7F` is the daemon layer, free to change at any time. `0x80+` is reserved for local
experiments and a released build must not depend on it.

| type   | dir     | fields                                                  | meaning                                  |
| ------ | ------- | ------------------------------------------------------- | ---------------------------------------- |
| `0x01` | both    | —                                                       | RESET: drop partial state, forget epochs |
| `0x02` | host->g | `epoch`, `proto`, `wantHash`                            | ANNOUNCE: host is listening              |
| `0x03` | g->host | `epoch`, `role`, `proto`, `ver`, `hash`, `caps`, `tick` | IDENT: who is alive                      |
| `0x04` | host->g | `epoch`, `hash`, `len`                                  | PAYLOAD_BEGIN: a child binary follows    |
| `0x05` | host->g | `epoch`, `seq`, `bytes`                                 | PAYLOAD_DATA                             |
| `0x06` | host->g | `epoch`, `hash`                                         | PAYLOAD_END: verify and run it           |
| `0x07` | g->host | `epoch`, `code`, `detail`                               | STATUS: progress, child up/down, errors  |
| `0x08` | both    | `epoch`, `n`                                            | PING                                     |
| `0x09` | both    | `epoch`, `n`                                            | PONG                                     |
| `0x20` | host->c | `epoch`, `id`, `fn`, `args...`                          | CALL                                     |
| `0x21` | c->host | `epoch`, `id`, `ok`, `data...`                          | REPLY                                    |
| `0x22` | c->host | `epoch`, `name`, `data...`                              | EVENT                                    |

`role` is `parent` or `child`. The parent implements the frozen range and nothing else;
`0x20+` it copies verbatim between the port and the child's pipe without looking inside.

## Components

```
...\Start Menu\Programs\StartUp\DAEMON.EXE   parent: autostarted by Explorer, owns COM1
C:\1999\CACHE\<hash>.EXE                     child binaries the host has pushed
C:\1999\ALIVE                                liveness file the child touches every 5 s
```

**"The agent" means the guest side as a whole**: `DAEMON.EXE`, the resident half that
survives everything, plus whichever child is currently running, the replaceable half that
does the work. That is why the host's `agent.js` models one connection with a `role` rather
than two peers.

**The parent is a bootstrap and a supervisor, never a participant.** It parses frame
headers, handles the frozen range, and copies everything else to the child over an
anonymous pipe (`CreatePipe` with inherited handles; Win9x cannot host a named pipe
server). It uses fixed buffers and no dynamic allocation. Everything expressive lives in
the child, which the host replaces at will.

**The parent must never crash, and that is a hard constraint rather than an aspiration.**
Reloading the page restores saved RAM; it does not re-run Windows startup. A parent that
died before a save is dead in every restore of that save, and only a Force Reboot (which
zeroes RAM and re-runs StartUp) brings it back. A child that dies is invisible to the user
because the parent restarts it.

**Port ownership.** The parent holds COM1 for the machine's whole life and never hands it
over. So there is no port to orphan when a child dies, no `CreateFile` race on respawn, and
the host keeps a live peer that can say "child restarting" instead of falling silent.

**The cache is best-effort.** v86 never writes to `hda.img`: guest writes live in an
in-memory overlay that only `save_state()` persists. So `CACHE\<hash>.EXE` survives into
the user's save and comes back when they restore, but a cold boot (a new participant,
`?fresh=1`, Force Reboot) starts with only what is baked into the image. That is fine
because the host is the source of truth and pushes what it wants on every page load; the
cache only saves a re-push. For the same reason the parent cannot durably replace itself:
overwriting `DAEMON.EXE` lasts until the next cold boot and no further.

## Lifecycle

The machine is **restored running**, essentially never rebooted: a saved snapshot resumes
with the parent already executing mid-instruction, possibly a child too, and it may land in
a newer version of the site wanting a newer child.

**The host always initiates and never assumes who is alive.** On page load it mints a fresh
`epoch`, sends `RESET`, then `ANNOUNCE` every 2 s until something `IDENT`s. After ~15 s of
silence it reports tracking unavailable and keeps announcing more slowly, so an agent that
appears later still connects. Every existing v1 world has no agent at all, and that must
stay a quiet, healthy state rather than an error.

Then, by case:

- **Parent reports a child running the wanted hash.** Nothing restarts. The host starts
  calling.
- **Parent has the wanted hash in `CACHE` but is not running it.** It spawns it on the spot,
  before answering, and identifies as running it. This is the ordinary case rather than an
  optimisation: the parent keeps which-build-to-run in RAM, so every guest reboot forgets
  it, while `CACHE\<hash>.EXE` survives in the disk overlay. Without this the host re-pushed
  the entire child through a 512-byte acked window on every boot. The wanted hash on the
  `ANNOUNCE` is what makes it possible, and it is validated as a filename (letters and
  digits only) before it becomes one.
- **Parent reports a different hash, and does not have the wanted one.** Host sends
  `PAYLOAD_BEGIN`, the data, then `PAYLOAD_END`. The parent verifies the hash, writes `CACHE\<hash>.EXE`, stops any
  existing child, deletes the binary it supersedes, spawns the new one, and `STATUS`es the
  result. There is no separate
  upgrade negotiation and no live in-place upgrade: replacing the child _is_ the upgrade.
- **Push fails** (bad hash, disk error, spawn failure): the parent keeps whatever child it
  already had and says so. Something running beats nothing running. The host does not
  retry the same bytes, because they would fail the same way.
- **The child dies later.** The parent reports `child-down` and then **re-identifies**, so
  the host learns there is something to do. The parent respawns from cache when it can,
  but a machine that has never been given a child has nothing cached, so the re-identify is
  what invites a fresh push. This is distinct from a failed transfer: here
  the host _does_ push again, and the parent's own respawn backoff is what prevents a
  crash loop.

**Epochs make a mid-action save harmless.** Every frame carries the epoch it belongs to.
The guest adopts the epoch from the most recent `ANNOUNCE` and echoes it; the host drops
any frame not carrying its current epoch. So a snapshot taken mid-`CALL` restores into a
page that never asked, the stale `REPLY` arrives, and it is dropped instead of being
matched to a live request. `CALL`/`REPLY` also carry an `id`, and an unmatched `id` is
dropped: two layers, because a save can be restored twice into two pages that both minted
epochs.

**Robustness rules, all normative.** Unknown types, unknown flags, unknown epochs, unknown
ids, bad CRCs, oversize lengths and truncated tails are **dropped, never fatal**. Nothing
in either direction may put the peer into a state that a subsequent valid frame cannot
recover from. `PAYLOAD_BEGIN` always restarts a transfer from scratch, discarding any
partial one. A `PAYLOAD_DATA` or `PAYLOAD_END` without a preceding `BEGIN` is dropped. A
`RESET`, an epoch change, or any framing error clears partial payload state and deletes the
temp file. A duplicate `IDENT` is idempotent. `PAYLOAD_DATA` carries `seq` so an
out-of-order or gapped transfer is detected and the whole transfer abandoned rather than
assembled wrong.

**Self-repair.** The parent supervises the child two ways, because a process handle alone
cannot see a hang: it waits on the handle, and it checks `ALIVE`, which the child touches
every 5 s. A dead process or an `ALIVE` older than 30 s means kill and respawn, backing off
1s, 2s, 4s up to 60s. After repeated failures of one binary it stops trying that hash and
reports it, so a bad push degrades to "no tracking" rather than a spawn loop. A parent
restored from a snapshot keeps supervising the child it already had, with no page involved;
a freshly started one waits to be told which build to run, since only the host knows.

Both loops poll their input every 20 ms while a conversation is in progress and every
100 ms once a second has passed with nothing arriving. A push is a burst, so only its first
frame ever waits for the slow tick.

## Time and identity

**Host time is authoritative.** A restored guest resumes with a stale RTC, so guest
timestamps can repeat, jump or run backwards. The guest reports a monotonic `tick`
(`GetTickCount`), which is an ordering hint only; the host stamps real time on everything
it records.

One saved machine can be restored many times, so tracking logs fork. That is handled in the
container rather than here: each page load gets an `instanceId` and writes its own
`hb/<instanceId>` chunk, which no other instance ever rewrites (see `../persist.js`).
Nothing in this protocol needs to know about forks.

## The daemon API

The child is an RPC surface: functions the host calls, events the host listens for. All
policy lives in JS on the host, which is testable; the guest stays as dumb as possible.

| call            | returns                                |
| --------------- | -------------------------------------- |
| `getForeground` | `exe`, `title`                         |
| `health`        | `ver`, `uptimeMs`, `exe`, `diag`       |
| `exec`          | `code`, `output` — dev only, see below |

| event | fields                 | when                          |
| ----- | ---------------------- | ----------------------------- |
| `win` | `exe`, `title`, `tick` | the foreground window changed |

`diag` is a short line about the guest as the child sees it (whether there is a foreground
window, whether ToolHelp answers, `COMSPEC`, the working directory). It exists because the
guest has no console and no debugger, so an API that fails there leaves no trace at all
unless the failure describes itself. Every capability is also exercised for real on each
connect by `like99.dev.selftest()`, since the capability list is a hardcoded string and
cannot tell you that `exec` has stopped working.

The host counts keystrokes and clicks itself from v86's `keyboard-code`, `mouse-click`
and `mouse-wheel` bus events (movement is deliberately not activity: a jiggler would make
it meaningless). The guest therefore needs no input hooks at
all, which matters because Win9x has no clean way for a background process to observe
global input (no `WH_KEYBOARD_LL`, and a global `WH_KEYBOARD` needs a DLL injected into
every process).

`exec` runs a command and returns its output. It is exposed as `like99.dev.exec()` and
gated to dev builds, the same way the CD-ROM dev bypasses are. That gate is client-side and
that is fine: the blast radius is the caller's own emulator in their own browser tab, and
`exec` lives in the child, so the worst case is a respawn.

## Build and install

- **Build:** mingw-w64 (`brew install mingw-w64`), freestanding: no CRT, PE subsystem 4.0,
  entry point and the handful of memory intrinsics supplied by `crt0_win32.c`. Dropping the
  CRT is what removes the real Win98 hazard, which is startup code calling `msvcrt.dll`
  exports that Windows 98 does not have. `scripts/audit-pe.mjs` fails the build on any
  import outside an allowlist of Win95-era symbols. The portable parts (framing,
  demux, supervision) compile for macOS with clang too, against a small platform shim, so
  the logic that must never crash gets unit tests without a VM. Prebuilt binaries are
  checked in, since the image build is offline.
- **Install:** `DAEMON.EXE` goes into `C:\WINDOWS\Start Menu\Programs\StartUp\`, and the
  current child alongside it in `C:\1999\CACHE\<hash>.EXE` so the first announce after a
  boot is a cache hit that transfers nothing. Explorer runs any executable it finds in
  StartUp, so there is no shortcut to author and no `WIN.INI` to edit. The copy is done from
  inside the guest, off a CD, by `like99.dev.installDaemon()`; the host has no FAT writer and
  building one would mean a cluster allocator, both FAT copies, VFAT long names and a race
  with Windows' own disk cache. See `../../tmp-image-build/BUILD.md` for how that folds into
  an image build.
