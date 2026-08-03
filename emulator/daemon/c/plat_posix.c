/* The macOS/POSIX implementation of plat.h, which exists so the parent can be tested.
 *
 * The serial port is stdin/stdout. That is what lets a Node test spawn the real parent
 * binary, speak the real protocol down its stdin, and read frames back from its stdout —
 * the same conversation the browser has with a real guest, minus Windows.
 */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

#include "plat.h"

static int set_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return P_FAIL;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 ? P_FAIL : P_OK;
}

int p_serial_open(void) {
  /* A write to a pipe whose reader has gone raises SIGPIPE, whose default action kills the
   * process. The parent is the one thing here that must not die, and it writes to a child
   * that is allowed to; the error is handled through EPIPE instead. */
  signal(SIGPIPE, SIG_IGN);
  /* stdout must stay unbuffered and binary; we never use stdio for it. */
  if (set_nonblock(STDIN_FILENO) != P_OK) return P_FAIL;
  return P_OK;
}

int p_serial_read(u8 *buf, int max) {
  ssize_t n = read(STDIN_FILENO, buf, (size_t)max);
  if (n > 0) return (int)n;
  if (n == 0) return P_FAIL; /* the other end closed: the page went away */
  return (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : P_FAIL;
}

int p_serial_write(const u8 *buf, int len) {
  int at = 0;
  while (at < len) {
    ssize_t n = write(STDOUT_FILENO, buf + at, (size_t)(len - at));
    if (n > 0) {
      at += (int)n;
      continue;
    }
    if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
    return P_FAIL;
  }
  return P_OK;
}

/* --- child ---------------------------------------------------------------------- */

void p_child_init(p_child *c) {
  c->proc = 0;
  c->to_in = 0;
  c->from_out = 0;
  c->running = 0;
  c->nonblocking = 0;
}

/* Handles are stored as (fd + 1) so that zero always means "none". */
static int fd_of(void *h) { return (int)(long)h - 1; }
static void *as_handle(int fd) { return (void *)(long)(fd + 1); }

int p_child_spawn(p_child *c, const char *path, const char *arg) {
  int in[2], out[2];
  pid_t pid;

  if (c->running) return P_FAIL;
  if (pipe(in) != 0) return P_FAIL;
  if (pipe(out) != 0) {
    close(in[0]);
    close(in[1]);
    return P_FAIL;
  }

  pid = fork();
  if (pid < 0) {
    close(in[0]);
    close(in[1]);
    close(out[0]);
    close(out[1]);
    return P_FAIL;
  }
  if (pid == 0) {
    dup2(in[0], STDIN_FILENO);
    dup2(out[1], STDOUT_FILENO);
    close(in[0]);
    close(in[1]);
    close(out[0]);
    close(out[1]);
    if (arg)
      execl(path, path, arg, (char *)0);
    else
      execl(path, path, (char *)0);
    _exit(127); /* only reached if exec failed */
  }

  close(in[0]);
  close(out[1]);
  set_nonblock(out[0]);
  /* Same reasoning as the Win32 build: a child that stops reading must not be able to park
   * the parent inside a write. */
  c->nonblocking = set_nonblock(in[1]) == P_OK;
  c->proc = (void *)(long)pid;
  c->to_in = as_handle(in[1]);
  c->from_out = as_handle(out[0]);
  c->running = 1;
  return P_OK;
}

int p_child_alive(p_child *c) {
  int status;
  pid_t pid, got;
  if (!c->running) return 0;
  pid = (pid_t)(long)c->proc;
  got = waitpid(pid, &status, WNOHANG);
  if (got == pid) {
    /* Reaped. Close our ends so a restart starts clean. */
    if (c->to_in) close(fd_of(c->to_in));
    if (c->from_out) close(fd_of(c->from_out));
    p_child_init(c);
    return 0;
  }
  return 1;
}

void p_child_kill(p_child *c) {
  if (!c->running) return;
  kill((pid_t)(long)c->proc, SIGKILL);
  waitpid((pid_t)(long)c->proc, 0, 0);
  if (c->to_in) close(fd_of(c->to_in));
  if (c->from_out) close(fd_of(c->from_out));
  p_child_init(c);
}

int p_child_read(p_child *c, u8 *buf, int max) {
  ssize_t n;
  if (!c->running || !c->from_out) return 0;
  n = read(fd_of(c->from_out), buf, (size_t)max);
  if (n > 0) return (int)n;
  if (n == 0) return P_FAIL;
  return (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : P_FAIL;
}

int p_child_write(p_child *c, const u8 *buf, int len) {
  int at = 0;
  u32 deadline;
  if (!c->running || !c->to_in) return P_FAIL;
  deadline = p_ticks() + P_CHILD_WRITE_MS;
  while (at < len) {
    ssize_t n = write(fd_of(c->to_in), buf + at, (size_t)(len - at));
    if (n > 0) {
      at += (int)n;
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      /* The child is behind rather than gone. Wait, but not forever. */
      if ((u32)(p_ticks() - deadline) < 0x80000000UL) return P_FAIL;
      usleep(5000);
      continue;
    }
    return P_FAIL; /* the child died mid-write; the supervisor will notice */
  }
  return P_OK;
}

/* --- files ---------------------------------------------------------------------- */

int p_file_write(const char *path, const u8 *buf, int len) {
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0755);
  int at = 0;
  if (fd < 0) return P_FAIL;
  while (at < len) {
    ssize_t n = write(fd, buf + at, (size_t)(len - at));
    if (n <= 0) {
      close(fd);
      return P_FAIL;
    }
    at += (int)n;
  }
  close(fd);
  return P_OK;
}

int p_file_read(const char *path, u8 *buf, int max) {
  int fd = open(path, O_RDONLY);
  ssize_t n;
  if (fd < 0) return P_FAIL;
  n = read(fd, buf, (size_t)max);
  close(fd);
  return n < 0 ? P_FAIL : (int)n;
}

int p_file_exists(const char *path) {
  struct stat st;
  return stat(path, &st) == 0;
}

void p_file_delete(const char *path) { unlink(path); }

int p_dir_make(const char *path) {
  if (mkdir(path, 0755) == 0) return P_OK;
  return errno == EEXIST ? P_OK : P_FAIL;
}

void p_base_dir(char *out, int cap) {
  const char *env = getenv("DAEMON_DIR");
  int i = 0;
  if (!env || !*env) env = ".";
  while (env[i] && i < cap - 1) {
    out[i] = env[i];
    i++;
  }
  out[i] = 0;
}

int p_env_int(const char *name, int def) {
  const char *v = getenv(name);
  int n = 0, i = 0;
  if (!v || !v[0]) return def;
  for (i = 0; v[i]; i++) {
    if (v[i] < '0' || v[i] > '9') return def;
    n = n * 10 + (v[i] - '0');
  }
  return n;
}

/* --- what the child reports ------------------------------------------------------- */

/* There is no foreground window on a build that exists to be tested, so this reads
 * `$DAEMON_DIR/FOREGROUND` (one line of exe, one of title). A test can write that file to
 * simulate the user switching programs, which is how the whole event path gets exercised
 * without a desktop. */
void p_foreground(char *exe, int exe_cap, char *title, int title_cap) {
  char base[256], path[300], buf[512];
  int n, i, line = 0, at = 0;
  exe[0] = 0;
  title[0] = 0;
  p_base_dir(base, (int)sizeof base);
  snprintf(path, sizeof path, "%s/FOREGROUND", base);
  n = p_file_read(path, (u8 *)buf, (int)sizeof buf - 1);
  if (n <= 0) return;
  buf[n] = 0;
  for (i = 0; i <= n; i++) {
    if (buf[i] == '\n' || buf[i] == 0) {
      char *dst = line == 0 ? exe : title;
      int cap = line == 0 ? exe_cap : title_cap;
      int len = i - at;
      if (len > cap - 1) len = cap - 1;
      if (len > 0) memcpy(dst, buf + at, (size_t)len);
      if (len >= 0) dst[len > 0 ? len : 0] = 0;
      at = i + 1;
      if (++line > 1) break;
    }
  }
}

int p_exec(const char *cmd, char *out, int cap) {
  FILE *pipe_fp = popen(cmd, "r");
  int n = 0, status;
  out[0] = 0;
  if (!pipe_fp) return P_FAIL;
  n = (int)fread(out, 1, (size_t)cap - 1, pipe_fp);
  if (n < 0) n = 0;
  out[n] = 0;
  status = pclose(pipe_fp);
  return status < 0 ? P_FAIL : (status >> 8) & 0xff;
}

/* --- time and logging ------------------------------------------------------------ */

u32 p_ticks(void) {
  struct timeval tv;
  gettimeofday(&tv, 0);
  return (u32)((u32)tv.tv_sec * 1000UL + (u32)(tv.tv_usec / 1000));
}

void p_sleep(int ms) { usleep((useconds_t)ms * 1000); }

void p_log(const char *msg) {
  fputs(msg, stderr);
  fputc('\n', stderr);
}

void p_diag(char *out, int cap) {
  const char *s = "posix: no window manager";
  int i;
  for (i = 0; s[i] && i < cap - 1; i++) out[i] = s[i];
  out[i] = 0;
}
