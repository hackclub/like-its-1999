/* the child: the part that does the work and is allowed to die
 *
 * Talks only to the parent, over a pipe, and only in the daemon range (0x20+). It never
 * touches the port and never sends a frozen-range frame; the parent answers IDENT on its
 * behalf, since the parent knows which build it started.
 *
 * Everything risky lives here (enumerating windows, running commands) because the parent
 * restarts a child that crashes, while a dead parent needs a Force Reboot. */
#include "plat.h"

#define POLL_MS 1000
#define TICK_MS 20
#define IDLE_TICK_MS 100
#define BUSY_FOR_MS 1000

/* How often to stamp the liveness file. Must stay well below the parent's staleness
 * threshold or a healthy child gets killed, so both come from the environment and a test
 * compresses them together; production is 5s of stamping against a 30s threshold. */
#define DEF_ALIVE_EVERY_MS 5000
static int ALIVE_EVERY_MS = DEF_ALIVE_EVERY_MS;
#define MAX_TITLE 256
#define MAX_EXE 64
#define MAX_OUT 8192

static u8 out_frame[F_MAX_FRAME];
static u8 out_payload[F_MAX_PAYLOAD];
static f_decoder dec;

static char cur_exe[MAX_EXE];
static char cur_title[MAX_TITLE];
static char alive_path[256];
static u32 started;

static int same(const char *a, const char *b) {
  int i = 0;
  while (a[i] && a[i] == b[i]) i++;
  return a[i] == b[i];
}

static void scopy(char *dst, const char *src, int cap) {
  int i = 0;
  while (src[i] && i < cap - 1) {
    dst[i] = src[i];
    i++;
  }
  dst[i] = 0;
}

/* the parent compares this tick against its own clock to tell a hang from a healthy idle:
 * a hung process still has a valid handle */
static void alive_stamp(void) {
  char text[12];
  u32 v = p_ticks();
  char tmp[11];
  int i = 11, n = 0;
  if (v == 0) {
    text[n++] = '0';
  } else {
    while (v > 0 && i > 0) {
      tmp[--i] = (char)('0' + (v % 10));
      v /= 10;
    }
    while (i < 11) text[n++] = tmp[i++];
  }
  p_file_write(alive_path, (const u8 *)text, n);
}

/* everything the child sends goes to the parent, which copies it out verbatim */
static void send_frame(u8 type, f_builder *b) {
  int plen = f_build_len(b);
  int wlen;
  if (plen < 0) return;
  wlen = f_encode(type, out_payload, plen, out_frame, (int)sizeof out_frame);
  if (wlen > 0) p_serial_write(out_frame, wlen);
}

/* the epoch is echoed from whatever the call carried; the parent already drops anything
 * from a stale page before it reaches us */
static void send_event(const char *epoch, const char *name, const char *a,
                       const char *b_) {
  f_builder b;
  f_build_init(&b, out_payload, (int)sizeof out_payload);
  f_add_str(&b, epoch);
  f_add_str(&b, name);
  f_add_str(&b, a);
  f_add_str(&b, b_);
  send_frame(F_EVENT, &b);
}

static void poll_foreground(const char *epoch) {
  char exe[MAX_EXE], title[MAX_TITLE];
  p_foreground(exe, (int)sizeof exe, title, (int)sizeof title);
  if (same(exe, cur_exe) && same(title, cur_title)) return;
  scopy(cur_exe, exe, MAX_EXE);
  scopy(cur_title, title, MAX_TITLE);
  send_event(epoch, "win", cur_exe, cur_title);
}

static void on_call(f_field *f, int n) {
  char epoch[40], id[16], fn[32];
  f_builder b;

  if (n < 3) return;
  f_field_str(&f[0], epoch, (int)sizeof epoch);
  f_field_str(&f[1], id, (int)sizeof id);
  f_field_str(&f[2], fn, (int)sizeof fn);

  f_build_init(&b, out_payload, (int)sizeof out_payload);
  f_add_str(&b, epoch);
  f_add_str(&b, id);

  if (same(fn, "getForeground")) {
    char exe[MAX_EXE], title[MAX_TITLE];
    p_foreground(exe, (int)sizeof exe, title, (int)sizeof title);
    f_add_str(&b, "1");
    f_add_str(&b, exe);
    f_add_str(&b, title);
  } else if (same(fn, "health")) {
    char diag[220];
    p_diag(diag, (int)sizeof diag);
    f_add_str(&b, "1");
    f_add_str(&b, "0.1");
    f_add_uint(&b, (u32)(p_ticks() - started));
    f_add_str(&b, cur_exe);
    f_add_str(&b, diag);
  } else if (same(fn, "exec")) {
    static char out[MAX_OUT];
    char cmd[512];
    int code;
    if (n < 4) {
      f_add_str(&b, "0");
      f_add_str(&b, "exec needs a command");
      send_frame(F_REPLY, &b);
      return;
    }
    f_field_str(&f[3], cmd, (int)sizeof cmd);
    code = p_exec(cmd, out, (int)sizeof out);
    if (code == P_FAIL) {
      f_add_str(&b, "0");
      /* p_exec leaves the reason in the buffer; it is the only way the guest's error code
       * reaches anyone */
      f_add_str(&b, out[0] ? out : "could not run it");
    } else {
      f_add_str(&b, "1");
      f_add_uint(&b, (u32)code);
      f_add_str(&b, out);
    }
  } else {
    f_add_str(&b, "0");
    f_add_str(&b, "no such function");
  }
  send_frame(F_REPLY, &b);
}

static void on_frame(const f_frame *fr) {
  f_field f[F_MAX_FIELDS];
  int n;
  /* only calls arrive here; the parent keeps the frozen range to itself */
  if (fr->type != F_CALL) return;
  n = f_fields(fr->payload, fr->len, f, F_MAX_FIELDS);
  if (n < 0) return;
  on_call(f, n);
}

int daemon_child_main(void) {
  static u8 in[4096];
  char base[256];
  char epoch[40];
  u32 last_poll, last_alive, last_byte;
  int i;

  p_base_dir(base, (int)sizeof base);
  {
    int at = 0;
    while (base[at] && at < (int)sizeof alive_path - 8) {
      alive_path[at] = base[at];
      at++;
    }
    if (at && alive_path[at - 1] != P_SEP) alive_path[at++] = P_SEP;
    alive_path[at++] = 'A';
    alive_path[at++] = 'L';
    alive_path[at++] = 'I';
    alive_path[at++] = 'V';
    alive_path[at++] = 'E';
    alive_path[at] = 0;
  }

  ALIVE_EVERY_MS = p_env_int("DAEMON_ALIVE_EVERY_MS", DEF_ALIVE_EVERY_MS);
  if (p_serial_open() != P_OK) return 1;
  f_dec_init(&dec);
  started = p_ticks();
  last_poll = started;
  last_alive = started;
  last_byte = started;
  epoch[0] = 0;
  for (i = 0; i < MAX_EXE; i++) cur_exe[i] = 0;
  for (i = 0; i < MAX_TITLE; i++) cur_title[i] = 0;
  alive_stamp();

  for (;;) {
    int n = p_serial_read(in, (int)sizeof in);
    u32 now;
    if (n == P_FAIL) return 0; /* the parent closed the pipe, so it is stopping us */
    if (n > 0) {
      const u8 *p = in;
      int left = n;
      last_byte = p_ticks();
      while (left > 0) {
        f_frame fr;
        int took = f_dec_push(&dec, p, left);
        if (took <= 0) break;
        p += took;
        left -= took;
        while (f_dec_next(&dec, &fr)) {
          /* remember the epoch from any call, so unsolicited events can be addressed */
          f_field f[F_MAX_FIELDS];
          if (fr.type == F_CALL && f_fields(fr.payload, fr.len, f, F_MAX_FIELDS) >= 1)
            f_field_str(&f[0], epoch, (int)sizeof epoch);
          on_frame(&fr);
        }
      }
    }

    now = p_ticks();
    if ((u32)(now - last_alive) >= (u32)ALIVE_EVERY_MS) {
      last_alive = now;
      alive_stamp();
    }
    if (epoch[0] && (u32)(now - last_poll) >= POLL_MS) {
      last_poll = now;
      poll_foreground(epoch);
    }
    if (n <= 0)
      p_sleep((u32)(p_ticks() - last_byte) < (u32)BUSY_FOR_MS ? TICK_MS
                                                             : IDLE_TICK_MS);
  }
}

#ifndef DAEMON_NO_MAIN
int main(void) { return daemon_child_main(); }
#endif
