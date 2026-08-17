/* the parent: owns the port, speaks the frozen range, supervises the child
 *
 * This is the binary baked into the disk image and the one thing here that must never
 * crash: reloading the page restores saved RAM rather than re-running Windows startup, so
 * a parent that died before a save is dead in every restore of it and only a Force Reboot
 * brings it back. Hence fixed buffers, no allocation, no recursion, no CRT, every length
 * checked, and every unknown thing ignored rather than treated as an error.
 *
 * It parses frame headers and the frozen range only; types 0x20 and up are copied to the
 * child's pipe unexamined, so the protocol above can grow without touching this binary.
 * See ../PROTOCOL.md. */
#include "plat.h"

#define VER "0.1"
#define CAPS "win,health,exec"

#define MAX_EPOCH 40
#define MAX_HASH 72
#define MAX_PATH_LEN 200

/* The grace period matters: a child that has just started has not touched its liveness
 * file yet, and killing it for that would loop. All read from the environment at startup
 * so tests can compress them; nothing sets them in production. */
#define DEF_ALIVE_STALE_MS 30000
#define DEF_SPAWN_GRACE_MS 15000
#define DEF_BACKOFF_START_MS 1000
#define DEF_SUPERVISE_EVERY_MS 1000
#define BACKOFF_MAX_MS 60000
#define MAX_FAILS 5
/* how long after a spawn to confirm the child is still there: long enough to catch a
 * binary that cannot run at all, short enough that nobody notices */
#define DEF_SPAWN_CONFIRM_MS 80

/* Poll fast during a conversation, slowly otherwise. A push arrives as a burst, so only
 * its first frame waits for the slow tick, and the difference is 50 wakeups a second
 * against 10 for as long as the tab is open. */
#define TICK_MS 20
#define IDLE_TICK_MS 100
#define BUSY_FOR_MS 1000

static int ALIVE_STALE_MS = DEF_ALIVE_STALE_MS;
static int SPAWN_GRACE_MS = DEF_SPAWN_GRACE_MS;
static int BACKOFF_START_MS = DEF_BACKOFF_START_MS;
static int SUPERVISE_EVERY_MS = DEF_SUPERVISE_EVERY_MS;
static int SPAWN_CONFIRM_MS = DEF_SPAWN_CONFIRM_MS;

typedef struct {
  char epoch[MAX_EPOCH];
  int have_epoch;

  /* an in-flight payload push */
  int xfer;
  char xfer_hash[MAX_HASH];
  u32 xfer_len, xfer_got, xfer_next_seq;
  int xfer_bad;

  p_child child;
  char child_hash[MAX_HASH];
  char cached_hash[MAX_HASH];
  u32 child_started;
  u32 next_spawn;
  int backoff;
  int fails;

  char base[MAX_PATH_LEN];
  char alive_path[MAX_PATH_LEN];
} parent;

static parent P;

/* the payload lands here before it becomes a file: one max-size child, no allocation */
#define MAX_CHILD_BYTES (512 * 1024)
static u8 xfer_buf[MAX_CHILD_BYTES];

static u8 out_frame[F_MAX_FRAME];
static u8 out_payload[F_MAX_PAYLOAD];
static f_decoder dec;

/* --- small string helpers (no CRT) --- */

static int slen(const char *s) {
  int n = 0;
  while (s[n]) n++;
  return n;
}

static void scopy(char *dst, const char *src, int cap) {
  int i = 0;
  while (src[i] && i < cap - 1) {
    dst[i] = src[i];
    i++;
  }
  dst[i] = 0;
}

static int seq(const char *a, const char *b) {
  int i = 0;
  while (a[i] && a[i] == b[i]) i++;
  return a[i] == b[i];
}

static int utoa32(u32 v, char *out) {
  char tmp[11];
  int i = 11, n = 0;
  if (v == 0) {
    out[0] = '0';
    out[1] = 0;
    return 1;
  }
  while (v > 0 && i > 0) {
    tmp[--i] = (char)('0' + (v % 10));
    v /= 10;
  }
  while (i < 11) out[n++] = tmp[i++];
  out[n] = 0;
  return n;
}

static void path_join(char *out, int cap, const char *a, const char *b) {
  int n = 0, i = 0;
  while (a[i] && n < cap - 2) out[n++] = a[i++];
  if (n && out[n - 1] != P_SEP) out[n++] = P_SEP;
  i = 0;
  while (b[i] && n < cap - 1) out[n++] = b[i++];
  out[n] = 0;
}

/* --- sending --- */

/* A frame we could not build or encode is a reply somebody is waiting for, and the host
 * sees it only as silence. It cannot be reported through send_frame itself, so it is
 * counted and the next status carries the tally. */
static u32 g_dropped_out;

static void send_frame(u8 type, f_builder *b) {
  int plen = f_build_len(b);
  int wlen;
  if (plen < 0) {
    g_dropped_out++;
    return;
  }
  wlen = f_encode(type, out_payload, plen, out_frame, (int)sizeof out_frame);
  if (wlen > 0) p_serial_write(out_frame, wlen);
  else g_dropped_out++;
}

static void send_ident(void) {
  f_builder b;
  int running = P.child.running;
  f_build_init(&b, out_payload, (int)sizeof out_payload);
  f_add_str(&b, P.epoch);
  f_add_str(&b, running ? "child" : "parent");
  f_add_uint(&b, 1); /* proto */
  f_add_str(&b, VER);
  f_add_str(&b, running ? P.child_hash : "");
  f_add_str(&b, running ? CAPS : "");
  f_add_uint(&b, p_ticks());
  send_frame(F_IDENT, &b);
}

static void send_status(const char *code, const char *detail) {
  f_builder b;
  f_build_init(&b, out_payload, (int)sizeof out_payload);
  f_add_str(&b, P.epoch);
  f_add_str(&b, code);
  f_add_str(&b, detail);
  /* frames we failed to send, which the host would otherwise see as a call that never
   * came back; zero in normal operation */
  f_add_uint(&b, g_dropped_out);
  send_frame(F_STATUS, &b);
}

/* --- the child --- */

/* CACHE\<hash>.EXE; CreateProcess on 9x wants the extension and refuses to start a
 * hash-named file without it */
static void cache_path(char *out, int cap, const char *hash) {
  char dir[MAX_PATH_LEN];
  char name[MAX_HASH + 8];
  int n = slen(hash), i;
  path_join(dir, (int)sizeof dir, P.base, "CACHE");
  for (i = 0; i < n && i < MAX_HASH - 1; i++) name[i] = hash[i];
  name[i++] = '.';
  name[i++] = 'E';
  name[i++] = 'X';
  name[i++] = 'E';
  name[i] = 0;
  path_join(out, cap, dir, name);
}

/* a hash becomes a filename, so letters and digits only: nothing off the wire gets to
 * spell a separator, a drive, or a parent directory */
static int hash_ok(const char *h) {
  int i = 0;
  for (; h[i]; i++) {
    int c = h[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')))
      return 0;
    if (i >= MAX_HASH - 8) return 0; /* leaves room for ".EXE" */
  }
  return i > 0;
}

static void stop_child(void) {
  if (!P.child.running) return;
  p_child_kill(&P.child);
  P.child_hash[0] = 0;
}

/* liveness is a tick count in a file rather than its modification time: both sides read
 * the same clock, and it avoids 64-bit FILETIME arithmetic in a binary with no runtime */
static void alive_stamp(void) {
  char text[12];
  int n = utoa32(p_ticks(), text);
  p_file_write(P.alive_path, (const u8 *)text, n);
}

/* milliseconds since the child last stamped, or -1 if it never has */
static long alive_age(void) {
  u8 buf[16];
  u32 v = 0;
  int n = p_file_read(P.alive_path, buf, (int)sizeof buf - 1), i;
  if (n <= 0) return -1;
  for (i = 0; i < n; i++) {
    if (buf[i] < '0' || buf[i] > '9') break;
    v = v * 10 + (u32)(buf[i] - '0');
  }
  if (i == 0) return -1;
  return (long)(u32)(p_ticks() - v);
}

/* Tries to start the cached binary, reporting through STATUS either way: from the host's
 * side silence is indistinguishable from a wedge. */
static void try_spawn(void) {
  char path[MAX_PATH_LEN];
  if (P.child.running || !P.cached_hash[0]) return;
  if (P.fails >= MAX_FAILS) return;

  cache_path(path, (int)sizeof path, P.cached_hash);
  if (!p_file_exists(path)) {
    /* cached a moment ago and gone now: a disk error, or somebody tidying C:\1999; saying
     * so invites the host to push again */
    P.cached_hash[0] = 0;
    send_status("child-down", "cached binary has vanished");
    send_ident();
    return;
  }
  if (p_child_spawn(&P.child, path, 0) == P_OK) {
    /* "started" has to mean "still there a moment later": on POSIX the fork always works
     * and an exec failure shows up as an immediate exit, and on 9x a PE that loads with a
     * missing import dies just as fast */
    p_sleep(SPAWN_CONFIRM_MS);
    if (!p_child_alive(&P.child)) P.child_hash[0] = 0;
  }
  if (!P.child.running) {
    P.fails++;
    P.backoff = P.backoff ? P.backoff * 2 : BACKOFF_START_MS;
    if (P.backoff > BACKOFF_MAX_MS) P.backoff = BACKOFF_MAX_MS;
    P.next_spawn = p_ticks() + (u32)P.backoff;
    send_status(P.fails >= MAX_FAILS ? "child-failed" : "child-down",
                "it would not start");
    return;
  }
  scopy(P.child_hash, P.cached_hash, MAX_HASH);
  P.child_started = p_ticks();
  alive_stamp(); /* a clean slate for the new child to prove itself against */
  send_status("child-up", P.child_hash);
  send_ident();
}

/* The host announces which build it wants on every page load and the cache usually holds
 * it already, so spawning from here means the common case transfers nothing instead of
 * re-pushing tens of kilobytes through a 512-byte acked window every boot.
 *
 * Nothing is retried here: supervise() owns the backoff, and a hash we are already trying
 * is left alone so a burst of announces cannot restart it. */
static void adopt_cached(f_field *want) {
  char hash[MAX_HASH];
  char path[MAX_PATH_LEN];

  f_field_str(want, hash, MAX_HASH);
  if (!hash_ok(hash)) {
    send_status("adopt-skipped", "the announced hash is not a usable name");
    return;
  }
  /* Neither of these is a failure and both must stay quiet: the first is the steady state
   * and the second is the ordinary unseen build that the push exists to fix. Announces
   * arrive every two seconds, so a status here would be a stream of noise. */
  if (seq(hash, P.cached_hash)) return;
  cache_path(path, (int)sizeof path, hash);
  if (!p_file_exists(path)) return;

  stop_child();
  scopy(P.cached_hash, hash, MAX_HASH);
  P.fails = 0;
  P.backoff = 0;
  P.next_spawn = p_ticks();
  try_spawn();
}

/* death and hangs are different failures and only death is visible in a process handle,
 * so both are checked */
static void supervise(void) {
  u32 now = p_ticks();

  if (P.child.running && !p_child_alive(&P.child)) {
    P.child_hash[0] = 0;
    P.fails++;
    P.backoff = P.backoff ? P.backoff * 2 : BACKOFF_START_MS;
    if (P.backoff > BACKOFF_MAX_MS) P.backoff = BACKOFF_MAX_MS;
    P.next_spawn = now + (u32)P.backoff;
    send_status(P.fails >= MAX_FAILS ? "child-failed" : "child-down", "exited");
    /* re-identify, so the host pushes a replacement if we have nothing cached to run */
    send_ident();
    return;
  }

  if (P.child.running && (u32)(now - P.child_started) > (u32)SPAWN_GRACE_MS) {
    long age = alive_age();
    if (age < 0 || age > ALIVE_STALE_MS) {
      /* alive as a process but not as a program, which a process handle cannot see */
      stop_child();
      P.fails++;
      P.next_spawn = now + BACKOFF_START_MS;
      send_status("child-down", "liveness timeout");
      send_ident();
      return;
    }
  }

  if (!P.child.running && P.cached_hash[0] && (u32)(now - P.next_spawn) < 0x80000000UL)
    try_spawn();
}

/* --- payload transfer --- */

static void ack_chunk(u32 seq_no) {
  f_builder b;
  f_build_init(&b, out_payload, (int)sizeof out_payload);
  f_add_str(&b, P.epoch);
  f_add_str(&b, "payload-ack");
  f_add_uint(&b, seq_no);
  send_frame(F_STATUS, &b);
}

static void xfer_abort(void) {
  P.xfer = 0;
  P.xfer_bad = 0;
  P.xfer_got = 0;
  P.xfer_next_seq = 0;
  P.xfer_hash[0] = 0;
}

static void on_payload_begin(f_field *f, int n) {
  u32 len = 0;
  /* a BEGIN discards whatever was in flight */
  xfer_abort();
  if (n < 3 || !f_field_uint(&f[2], &len) || len == 0 || len > MAX_CHILD_BYTES) {
    send_status("push-failed", "bad length");
    return;
  }
  f_field_str(&f[1], P.xfer_hash, MAX_HASH);
  if (!hash_ok(P.xfer_hash)) {
    P.xfer_hash[0] = 0;
    send_status("push-failed", "bad hash");
    return;
  }
  P.xfer = 1;
  P.xfer_len = len;
}

/* Acknowledge every chunk and let the host wait for it before sending the next.
 *
 * The emulated UART cannot drop bytes, but Windows' serial driver behind it has a buffer
 * measured in kilobytes and a host write arrives as fast as the guest can take
 * interrupts: a 21 KB binary sent in one go overran it and left the port deaf. One chunk
 * in flight removes the race rather than guessing at a safe rate. */
static void on_payload_data(f_field *f, int n) {
  u32 seq_no = 0;
  if (!P.xfer || n < 3) return; /* a stray DATA without a BEGIN is dropped */
  if (!f_field_uint(&f[1], &seq_no)) {
    P.xfer_bad = 1;
    return;
  }
  if (seq_no + 1 == P.xfer_next_seq) {
    /* a repeat of the chunk we already have, so the ack went missing: send another rather
     * than deadlock on it */
    ack_chunk(seq_no);
    return;
  }
  if (seq_no != P.xfer_next_seq) {
    P.xfer_bad = 1; /* a gap means the whole transfer is suspect */
    return;
  }
  if (P.xfer_got + (u32)f[2].len > P.xfer_len) {
    P.xfer_bad = 1;
    return;
  }
  {
    int i;
    for (i = 0; i < f[2].len; i++) xfer_buf[P.xfer_got + (u32)i] = f[2].p[i];
  }
  P.xfer_got += (u32)f[2].len;
  P.xfer_next_seq++;
  ack_chunk(seq_no);
}

/* Integrity is the per-frame CRC plus the declared length and contiguous sequence
 * numbers. The hash is an identity label rather than a checksum: sha256 in a freestanding
 * parent would guard against corruption the CRC has already excluded. */
static void on_payload_end(f_field *f, int n) {
  char path[MAX_PATH_LEN];
  char dir[MAX_PATH_LEN];

  if (!P.xfer) return; /* stray END */
  if (P.xfer_bad || P.xfer_got != P.xfer_len) {
    send_status("push-failed", P.xfer_bad ? "gap" : "short");
    xfer_abort();
    return;
  }
  if (n >= 2 && !f_field_eq(&f[1], P.xfer_hash)) {
    send_status("push-failed", "hash mismatch");
    xfer_abort();
    return;
  }

  /* Already running exactly these bytes, so keep the child. The host pushes again after a
   * `child-down` without knowing we have the binary cached and are retrying, so the two
   * cross; the write would fail anyway, since Windows locks a running executable. */
  if (P.child.running && seq(P.xfer_hash, P.child_hash)) {
    send_status("push-ignored", "already running it");
    xfer_abort();
    send_ident();
    return;
  }

  path_join(dir, (int)sizeof dir, P.base, "CACHE");
  p_dir_make(dir);
  cache_path(path, (int)sizeof path, P.xfer_hash);
  if (p_file_write(path, xfer_buf, (int)P.xfer_got) != P_OK) {
    send_status("push-failed", "write failed");
    xfer_abort();
    return;
  }

  /* The previous binary stays on disk until the new one has started: a push that
   * transfers perfectly can still fail to spawn, and PROTOCOL.md promises a failed push
   * leaves the machine with whatever child it already had. */
  {
    char previous[MAX_HASH];
    scopy(previous, P.cached_hash, MAX_HASH);

    stop_child();
    scopy(P.cached_hash, P.xfer_hash, MAX_HASH);
    P.fails = 0;
    P.backoff = 0;
    P.next_spawn = p_ticks();
    xfer_abort();
    try_spawn();

    if (P.child.running) {
      /* it works, so drop the one it replaces; after the spawn, because Windows will not
       * delete a running executable */
      if (previous[0] && !seq(previous, P.child_hash)) {
        char old[MAX_PATH_LEN];
        cache_path(old, (int)sizeof old, previous);
        p_file_delete(old);
      }
    } else if (previous[0] && !seq(previous, P.cached_hash)) {
      /* roll back to the child we know starts; try_spawn already reported the failure */
      scopy(P.cached_hash, previous, MAX_HASH);
      P.fails = 0;
      P.backoff = 0;
      P.next_spawn = p_ticks();
      try_spawn();
      send_status("push-failed", "new child would not start, kept the previous one");
    }
  }
}

/* --- frames from the host --- */

/* Hands a frame to the child and treats a child that will not take it as wedged.
 *
 * A child that has stopped reading fills the pipe, and a blocking write would park the
 * process that also has to read COM1 and kill that child. Two guards: the write end is
 * non-blocking with a deadline (p_child_write), and a child whose liveness file has gone
 * stale is not written to at all. */
static void forward_to_child(const f_frame *fr) {
  int wlen;
  if (!P.child.running) return; /* nothing to forward to; the host knows we are not ready */

  if (!P.child.nonblocking) {
    /* no non-blocking pipe from the platform, so the liveness file is all that stands
     * between us and an unbounded write */
    long age = alive_age();
    if (age < 0 || age > ALIVE_STALE_MS) {
      stop_child();
      send_status("child-down", "not reading its pipe");
      send_ident();
      return;
    }
  }

  wlen = f_encode(fr->type, fr->payload, fr->len, out_frame, (int)sizeof out_frame);
  if (wlen <= 0) return;
  if (p_child_write(&P.child, out_frame, wlen) != P_OK) {
    /* died mid-write or stopped draining, which mean the same thing from here: leaving it
     * running would leave a half-frame in the pipe of a child we no longer believe in */
    stop_child();
    send_status("child-down", "stuck writing to it");
    send_ident();
  }
}

static void on_frame(const f_frame *fr) {
  f_field f[F_MAX_FIELDS];
  int n;

  if (fr->type > F_FROZEN_MAX) {
    forward_to_child(fr);
    return;
  }

  n = f_fields(fr->payload, fr->len, f, F_MAX_FIELDS);

  if (fr->type == F_RESET) {
    /* Drops everything provisional: a restored snapshot can leave us mid-transfer, and the
     * host sends this on every page load.
     *
     * It deliberately does NOT clear the decoder. Buffered bytes arrive after this frame,
     * and the host sends RESET and ANNOUNCE back to back in its first tick, so they
     * routinely land in one read: clearing here threw the announce away and left the guest
     * silent until the next one two seconds later. */
    xfer_abort();
    return;
  }
  if (n < 1) return; /* every other frozen message carries at least an epoch */

  /* once an epoch is known, anything from a different one is a previous page and is
   * ignored; a fresh ANNOUNCE is how a new page takes over */
  if (fr->type == F_ANNOUNCE) {
    f_field_str(&f[0], P.epoch, MAX_EPOCH);
    P.have_epoch = 1;
    /* epoch, proto, wanted hash */
    if (n >= 3) adopt_cached(&f[2]);
    send_ident();
    return;
  }
  if (!P.have_epoch) return;
  {
    char got[MAX_EPOCH];
    f_field_str(&f[0], got, MAX_EPOCH);
    if (!seq(got, P.epoch)) return;
  }

  switch (fr->type) {
    case F_PAYLOAD_BEGIN:
      on_payload_begin(f, n);
      break;
    case F_PAYLOAD_DATA:
      on_payload_data(f, n);
      break;
    case F_PAYLOAD_END:
      on_payload_end(f, n);
      break;
    case F_PING: {
      f_builder b;
      f_build_init(&b, out_payload, (int)sizeof out_payload);
      f_add_str(&b, P.epoch);
      f_add_bytes(&b, n >= 2 ? (const void *)f[1].p : (const void *)"", n >= 2 ? f[1].len : 0);
      send_frame(F_PONG, &b);
      break;
    }
    default:
      /* IDENT, STATUS, PONG are ours to send, not to receive */
      break;
  }
}

/* --- main --- */

static void init(void) {
  int i;
  for (i = 0; i < (int)sizeof P; i++) ((u8 *)&P)[i] = 0;
  ALIVE_STALE_MS = p_env_int("DAEMON_ALIVE_STALE_MS", DEF_ALIVE_STALE_MS);
  SPAWN_GRACE_MS = p_env_int("DAEMON_SPAWN_GRACE_MS", DEF_SPAWN_GRACE_MS);
  BACKOFF_START_MS = p_env_int("DAEMON_BACKOFF_MS", DEF_BACKOFF_START_MS);
  SUPERVISE_EVERY_MS = p_env_int("DAEMON_SUPERVISE_MS", DEF_SUPERVISE_EVERY_MS);
  SPAWN_CONFIRM_MS = p_env_int("DAEMON_SPAWN_CONFIRM_MS", DEF_SPAWN_CONFIRM_MS);
  p_child_init(&P.child);
  p_base_dir(P.base, MAX_PATH_LEN);
  p_dir_make(P.base);
  path_join(P.alive_path, MAX_PATH_LEN, P.base, "ALIVE");
  f_dec_init(&dec);
}

int daemon_parent_main(void) {
  static u8 in[4096];
  u32 last_supervise, last_byte;

  init();
  /* Waits for the port rather than exiting without it. This runs from StartUp, so it races
   * Windows bringing the machine up, and a parent that gave up at boot is gone from every
   * restore of that save. Anything else holding the port (a modem dialler, a previous
   * instance shutting down) resolves the same way. */
  {
    int said = 0;
    while (p_serial_open() != P_OK) {
      if (!said) {
        p_log("daemon: waiting for the port");
        said = 1;
      }
      p_sleep(2000);
    }
  }
  last_supervise = p_ticks();
  last_byte = last_supervise;

  for (;;) {
    int n = p_serial_read(in, (int)sizeof in);
    if (n == P_FAIL) {
      /* the page went away; on Win32 the port stays open across page loads, so this only
       * happens on POSIX when the test closes the pipe */
      stop_child();
      return 0;
    }
    if (n > 0) {
      const u8 *p = in;
      int left = n;
      last_byte = p_ticks();
      /* push and drain: one read can carry several frames, and the decoder holds one */
      while (left > 0) {
        f_frame fr;
        int took = f_dec_push(&dec, p, left);
        if (took <= 0) break;
        p += took;
        left -= took;
        while (f_dec_next(&dec, &fr)) on_frame(&fr);
      }
    }

    /* whatever the child says goes straight out: frames are self-delimiting, so this
     * needs no parsing */
    if (P.child.running) {
      int m = p_child_read(&P.child, in, (int)sizeof in);
      if (m > 0) p_serial_write(in, m);
    }

    if ((u32)(p_ticks() - last_supervise) >= (u32)SUPERVISE_EVERY_MS) {
      last_supervise = p_ticks();
      supervise();
    }
    if (n <= 0)
      p_sleep((u32)(p_ticks() - last_byte) < (u32)BUSY_FOR_MS ? TICK_MS
                                                             : IDLE_TICK_MS);
  }
}

#ifndef DAEMON_NO_MAIN
int main(void) { return daemon_parent_main(); }
#endif
