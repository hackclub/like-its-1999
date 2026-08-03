/* Everything the agent needs from the operating system, and nothing else.
 *
 * parent.c and child.c include this and never a platform header, which is what lets the
 * same source build for Win98 with mingw and for macOS with clang. The macOS build is not
 * a toy: a Node test spawns it and speaks the real protocol to it, so the supervision
 * logic — spawn, notice a death, respawn with backoff — is exercised by tests rather than
 * only by hand in a VM.
 *
 * Rules for implementations: never block indefinitely, never allocate, and report failure
 * by return value. There is no errno here and nothing throws.
 */
#ifndef DAEMON_PLAT_H
#define DAEMON_PLAT_H

#include "frame.h"

#define P_OK 0
#define P_FAIL (-1)

/* --- the wire ------------------------------------------------------------------- */
/* Win32: COM1. POSIX: stdin/stdout, so a parent can be driven over a pipe by a test. */

int p_serial_open(void);
/* Reads what is available, up to max. Returns the count, 0 when nothing is waiting, or
 * P_FAIL if the port died. Must not block for longer than a few milliseconds. */
int p_serial_read(u8 *buf, int max);
/* Writes all of it, or returns P_FAIL. */
int p_serial_write(const u8 *buf, int len);

/* --- the child ------------------------------------------------------------------ */
/* A spawned process plus the two pipes we talk to it over. Opaque to the caller. */

typedef struct {
  void *proc;   /* HANDLE on Win32, a pid on POSIX */
  void *to_in;  /* our write end -> the child's stdin */
  void *from_out; /* our read end <- the child's stdout */
  int running;
  int nonblocking; /* the write end refuses to block; see p_child_write */
} p_child;

void p_child_init(p_child *c);
/* Starts `path`, with its stdin and stdout connected to the pipes. `arg` is passed as a
 * single argument, or 0 for none. */
int p_child_spawn(p_child *c, const char *path, const char *arg);
/* 1 while the process is alive. Reaps it when it is not, so this is also the "did it
 * exit" check. */
int p_child_alive(p_child *c);
void p_child_kill(p_child *c);
/* Non-blocking, same contract as p_serial_read. */
int p_child_read(p_child *c, u8 *buf, int max);
/* Writes a whole frame or nothing useful, and NEVER blocks indefinitely.
 *
 * This is the parent's most dangerous call. A child that stops reading its stdin fills the
 * pipe, and a blocking write then parks the one process that must never stop: it could no
 * longer read COM1, run supervision, or kill the very child that wedged it. So the write
 * end is put in non-blocking mode at spawn and this gives up after P_CHILD_WRITE_MS.
 *
 * Returns P_FAIL on timeout, and the caller must treat that as a wedged child rather than
 * a dropped frame. A partial write is survivable at the protocol level (the child's
 * decoder resynchronises past the truncated frame) but is never survivable as a silent
 * condition, which is why it is reported. */
#define P_CHILD_WRITE_MS 250
int p_child_write(p_child *c, const u8 *buf, int len);

/* --- files ---------------------------------------------------------------------- */

/* Path separator, and where our files live. The base directory comes from the DAEMON_DIR
 * environment variable, defaulting to C:\1999 on Win32 and the working directory on
 * POSIX. Using the environment rather than argv means neither binary has to parse a
 * command line, which on a freestanding Win32 build would be code we would rather not
 * write, and the child inherits it for free. */
#ifdef _WIN32
#define P_SEP '\\'
#else
#define P_SEP '/'
#endif

void p_base_dir(char *out, int cap);

/* An integer from the environment, or `def`. Used for the supervision timeouts: with them
 * hardcoded at tens of seconds, the hang-detection path could only be exercised by waiting
 * out a real timeout, so it would never have been tested at all. Nothing sets these in
 * production. */
int p_env_int(const char *name, int def);

/* Writes the whole buffer, replacing anything already there. */
int p_file_write(const char *path, const u8 *buf, int len);
/* Reads up to max. Returns the count or P_FAIL. */
int p_file_read(const char *path, u8 *buf, int max);
int p_file_exists(const char *path);

/* Best effort: a file that is not there, or is locked, is not an error worth handling. */
void p_file_delete(const char *path);
int p_dir_make(const char *path);

/* Note there is no "file age" call. Liveness works by the child writing its tick count
 * into ALIVE and the parent comparing against its own: both read the same clock, and it
 * avoids computing an age from a Win32 FILETIME, which needs 64-bit division and would
 * pull libgcc helpers into a binary that deliberately links no runtime. */

/* --- time ----------------------------------------------------------------------- */

/* A monotonic-ish millisecond counter. Win32 gives GetTickCount, which wraps after 49
 * days, so callers must compare with subtraction (which is correct across the wrap) and
 * never with <. */
u32 p_ticks(void);
void p_sleep(int ms);

/* --- what the child reports ------------------------------------------------------ */

/* The foreground window's executable and title, empty when unknown. Win32 asks the window
 * manager; POSIX reads a file under the base directory so a test can simulate a window
 * change without a desktop. */
void p_foreground(char *exe, int exe_cap, char *title, int title_cap);

/* Run a command and capture its output, truncated to cap. Returns the exit code, or
 * P_FAIL if it could not be started. */
int p_exec(const char *cmd, char *out, int cap);

/* --- diagnostics ---------------------------------------------------------------- */
/* Goes to stderr on POSIX and to OutputDebugString on Win32, where there is no console. */
void p_log(const char *msg);

/* A short line about the window manager as this process sees it, reported by `health`.
 * There is no console and no debugger in the guest, so the only way to learn why
 * p_foreground came back empty is to have it say so on the wire. */
void p_diag(char *out, int cap);

#endif
