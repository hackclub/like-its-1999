/* The parent: owns the port, speaks the frozen range, supervises the child.
 *
 * This is the binary baked into the disk image, and it is the one thing here that must
 * never crash. Reloading the page restores saved RAM rather than re-running Windows
 * startup, so a parent that died before a save is dead in every restore of that save and
 * only a Force Reboot brings it back. A child that dies is invisible, because this
 * restarts it.
 *
 * Consequences, all deliberate: fixed buffers, no allocation, no recursion, no CRT. Every
 * length is checked, every unknown thing is ignored rather than treated as an error, and
 * no input can put it in a state a later valid frame cannot recover from.
 *
 * It parses frame headers and the frozen range only. Types 0x20 and up are copied to the
 * child's pipe without being looked at, which is what lets the protocol above it grow
 * without ever touching this binary. See ../PROTOCOL.md.
 */
#include "plat.h"

#define VER "0.1"
#define CAPS "win,health,exec"

#define MAX_EPOCH 40
#define MAX_HASH 72
#define MAX_PATH_LEN 200

/* Supervision. The grace period matters: a child that has just started has not had a
 * chance to touch its liveness file yet, and killing it for that would be a loop.
 *
 * These are read from the environment at startup so tests can compress them; nothing sets
 * them in production. Without that, the hang-detection path would need a real 30-second
 * wait to exercise, which means it would never be exercised. */
#define DEF_ALIVE_STALE_MS 30000
#define DEF_SPAWN_GRACE_MS 15000
#define DEF_BACKOFF_START_MS 1000
#define DEF_SUPERVISE_EVERY_MS 1000
#define BACKOFF_MAX_MS 60000
#define MAX_FAILS 5

/* Poll fast while a conversation is happening, slowly when nothing is. A push arrives as
 * a burst, so only its first frame ever waits for the slow tick; everything after keeps
 * the loop hot. The difference is 50 wakeups a second against 10, all day, in a program
 * that runs for as long as the tab is open. */
#define TICK_MS 20
#define IDLE_TICK_MS 100
#define BUSY_FOR_MS 1000

static int ALIVE_STALE_MS = DEF_ALIVE_STALE_MS;
static int SPAWN_GRACE_MS = DEF_SPAWN_GRACE_MS;
static int BACKOFF_START_MS = DEF_BACKOFF_START_MS;
static int SUPERVISE_EVERY_MS = DEF_SUPERVISE_EVERY_MS;

typedef struct {
  char epoch[MAX_EPOCH];
  int have_epoch;

  /* An in-flight payload push. */
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

/* The payload lands here before it becomes a file. One max-size child, no allocation. */
#define MAX_CHILD_BYTES (512 * 1024)
static u8 xfer_buf[MAX_CHILD_BYTES];

static u8 out_frame[F_MAX_FRAME];
static u8 out_payload[F_MAX_PAYLOAD];
static f_decoder dec;

/* --- small string helpers (no CRT) ----------------------------------------------- */

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

/* --- sending --------------------------------------------------------------------- */

static void send_frame(u8 type, f_builder *b) {
  int plen = f_build_len(b);
  int wlen;
  if (plen < 0) return; /* nothing we can do, and a dropped frame is always survivable */
  wlen = f_encode(type, out_payload, plen, out_frame, (int)sizeof out_frame);
  if (wlen > 0) p_serial_write(out_frame, wlen);
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
  send_frame(F_STATUS, &b);
}

/* --- the child ------------------------------------------------------------------- */

/* CACHE\<hash>.EXE. The extension is not decoration: CreateProcess on 9x wants one, and
 * a hash-named file without it would simply refuse to start. */
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

/* A hash becomes a filename, so it is checked rather than trusted: letters and digits
 * only, which leaves no way to spell a separator, a drive or a parent directory. This
 * closes nothing the host could not already do by pushing whatever bytes it likes, but a
 * field off the wire should never be able to name a path regardless. */
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

/* Liveness is a tick count in a file rather than its modification time: both sides read
 * the same clock, and it avoids 64-bit FILETIME arithmetic in a binary with no runtime. */
static void alive_stamp(void) {
  char text[12];
  int n = utoa32(p_ticks(), text);
  p_file_write(P.alive_path, (const u8 *)text, n);
}

/* Milliseconds since the child last stamped, or -1 if it never has. */
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

/* Try to start the cached binary. Reports through STATUS either way, because silence is
 * indistinguishable from a wedge from the host's side. */
static void try_spawn(void) {
  char path[MAX_PATH_LEN];
  if (P.child.running || !P.cached_hash[0]) return;
  if (P.fails >= MAX_FAILS) return;

  cache_path(path, (int)sizeof path, P.cached_hash);
  if (!p_file_exists(path)) {
    P.cached_hash[0] = 0;
    return;
  }
  if (p_child_spawn(&P.child, path, 0) != P_OK) {
    P.fails++;
    P.backoff = P.backoff ? P.backoff * 2 : BACKOFF_START_MS;
    if (P.backoff > BACKOFF_MAX_MS) P.backoff = BACKOFF_MAX_MS;
    P.next_spawn = p_ticks() + (u32)P.backoff;
    send_status(P.fails >= MAX_FAILS ? "child-failed" : "child-down", "spawn failed");
    return;
  }
  scopy(P.child_hash, P.cached_hash, MAX_HASH);
  P.child_started = p_ticks();
  alive_stamp(); /* a clean slate for the new child to prove itself against */
  send_status("child-up", P.child_hash);
  send_ident();
}

/* The host announces which build it wants on every page load, and the cache usually
 * already holds it: the same page reloaded, or a guest rebooted under a page that has not
 * changed. Spawning it here means the common case transfers nothing at all, instead of
 * re-pushing tens of kilobytes through a 512-byte acked window every single boot.
 *
 * Nothing is retried here. If the spawn fails, supervise() owns the backoff, and a hash
 * we are already trying is left alone so a burst of announces cannot restart it. */
static void adopt_cached(f_field *want) {
  char hash[MAX_HASH];
  char path[MAX_PATH_LEN];

  f_field_str(want, hash, MAX_HASH);
  if (!hash_ok(hash)) return;
  if (seq(hash, P.cached_hash)) return; /* already running it, or already trying */
  cache_path(path, (int)sizeof path, hash);
  if (!p_file_exists(path)) return; /* not ours to conjure: the host will push it */

  stop_child();
  scopy(P.cached_hash, hash, MAX_HASH);
  P.fails = 0;
  P.backoff = 0;
  P.next_spawn = p_ticks();
  try_spawn();
}

/* Death and hangs are different failures and only one of them is visible in a process
 * handle, so both are checked. */
static void supervise(void) {
  u32 now = p_ticks();

  if (P.child.running && !p_child_alive(&P.child)) {
    P.child_hash[0] = 0;
    P.fails++;
    P.backoff = P.backoff ? P.backoff * 2 : BACKOFF_START_MS;
    if (P.backoff > BACKOFF_MAX_MS) P.backoff = BACKOFF_MAX_MS;
    P.next_spawn = now + (u32)P.backoff;
    send_status(P.fails >= MAX_FAILS ? "child-failed" : "child-down", "exited");
    /* Re-identify: the host learns there is something to do, and pushes a replacement if
     * we have nothing cached to run. */
    send_ident();
    return;
  }

  if (P.child.running && (u32)(now - P.child_started) > (u32)SPAWN_GRACE_MS) {
    long age = alive_age();
    if (age < 0 || age > ALIVE_STALE_MS) {
      /* Alive as a process but not as a program: a process handle cannot see this. */
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

/* --- payload transfer ------------------------------------------------------------- */

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
  /* Always restart from scratch: a BEGIN discards whatever was in flight. */
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

/* Acknowledge every chunk, and let the host wait for it before sending the next.
 *
 * This is the one place the protocol needs real flow control, and the reason is a layer
 * below us. The emulated UART cannot drop bytes, which is what made an unpaced push look
 * safe on paper, but Windows' serial driver sits behind it with a buffer measured in
 * kilobytes, and a host write arrives as fast as the guest can take interrupts. A 21 KB
 * binary sent in one go overran it and left the port deaf. One chunk in flight at a time
 * removes the race rather than guessing at a safe rate. */
static void on_payload_data(f_field *f, int n) {
  u32 seq_no = 0;
  if (!P.xfer || n < 3) return; /* a stray DATA without a BEGIN is dropped */
  if (!f_field_uint(&f[1], &seq_no)) {
    P.xfer_bad = 1;
    return;
  }
  if (seq_no + 1 == P.xfer_next_seq) {
    /* A repeat of the chunk we already have: the ack went missing, so send another and
     * keep the transfer moving rather than deadlocking on it. */
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

/* Integrity here is the per-frame CRC plus the declared length and contiguous sequence
 * numbers. The hash is an identity label rather than a checksum: computing sha256 in a
 * freestanding parent would be a hundred lines guarding against a corruption the CRC has
 * already excluded, over a transport that cannot drop bytes. */
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

  /* Already running exactly these bytes: keep the child. The host pushes again after a
   * `child-down` because it cannot know the parent has the binary cached and is retrying,
   * so the two can cross; without this the redundant push would kill a child that had just
   * come back, and the write would fail anyway because Windows locks a running executable. */
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

  /* A new build gets a fresh start: the old one's failures say nothing about it. */
  stop_child();
  /* And the one it replaces goes, so a long run of dev pushes cannot fill the disk with
   * every build that ever ran. Done after stop_child because Windows will not delete a
   * running executable. */
  if (P.cached_hash[0] && !seq(P.cached_hash, P.xfer_hash)) {
    char old[MAX_PATH_LEN];
    cache_path(old, (int)sizeof old, P.cached_hash);
    p_file_delete(old);
  }
  scopy(P.cached_hash, P.xfer_hash, MAX_HASH);
  P.fails = 0;
  P.backoff = 0;
  P.next_spawn = p_ticks();
  xfer_abort();
  try_spawn();
}

/* --- frames from the host ---------------------------------------------------------- */

static void forward_to_child(const f_frame *fr) {
  int wlen;
  if (!P.child.running) return; /* nothing to forward to; the host knows we are not ready */
  wlen = f_encode(fr->type, fr->payload, fr->len, out_frame, (int)sizeof out_frame);
  if (wlen > 0) p_child_write(&P.child, out_frame, wlen);
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
    /* Drop everything provisional. The host sends this on every page load, and a restored
     * snapshot can leave us mid-anything. */
    xfer_abort();
    f_dec_reset(&dec);
    return;
  }
  if (n < 1) return; /* every other frozen message carries at least an epoch */

  /* Once an epoch is known, anything from a different one is a ghost from a previous page
   * and is ignored. A fresh ANNOUNCE is how a new page takes over. */
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
      /* IDENT, STATUS, PONG are ours to send, not to receive. Ignore rather than object. */
      break;
  }
}

/* --- main --------------------------------------------------------------------------- */

static void init(void) {
  int i;
  for (i = 0; i < (int)sizeof P; i++) ((u8 *)&P)[i] = 0;
  ALIVE_STALE_MS = p_env_int("DAEMON_ALIVE_STALE_MS", DEF_ALIVE_STALE_MS);
  SPAWN_GRACE_MS = p_env_int("DAEMON_SPAWN_GRACE_MS", DEF_SPAWN_GRACE_MS);
  BACKOFF_START_MS = p_env_int("DAEMON_BACKOFF_MS", DEF_BACKOFF_START_MS);
  SUPERVISE_EVERY_MS = p_env_int("DAEMON_SUPERVISE_MS", DEF_SUPERVISE_EVERY_MS);
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
  /* Wait for the port rather than exiting without it.
   *
   * This runs from StartUp, so it races Windows bringing the machine up, and it is the one
   * process here that cannot be restarted: a page reload restores saved RAM instead of
   * re-running startup, so a parent that gave up at boot is gone from every restore of that
   * save and only a Force Reboot brings it back. Exiting because COM1 was busy for a second
   * would cost the whole session's tracking. Anything else holding the port (a modem
   * dialler, a previous instance shutting down) resolves the same way. */
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
      /* The page went away. On Win32 the port stays open across page loads, so this only
       * happens on POSIX when the test closes the pipe: exit cleanly. */
      stop_child();
      return 0;
    }
    if (n > 0) {
      const u8 *p = in;
      int left = n;
      last_byte = p_ticks();
      /* Push and drain: one read can carry several frames, and the decoder holds one. */
      while (left > 0) {
        f_frame fr;
        int took = f_dec_push(&dec, p, left);
        if (took <= 0) break;
        p += took;
        left -= took;
        while (f_dec_next(&dec, &fr)) on_frame(&fr);
      }
    }

    /* Whatever the child says goes straight out: frames are self-delimiting, so this
     * needs no parsing and stays a pipe rather than a participant. */
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
