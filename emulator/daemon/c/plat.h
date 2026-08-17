/* everything the agent needs from the operating system
 *
 * parent.c and child.c include this and never a platform header, which is what lets the
 * same source build for Win98 with mingw and for macOS with clang; a Node test spawns the
 * macOS build and speaks the real protocol to it
 *
 * rules for implementations: never block indefinitely, never allocate, report failure by
 * return value; there is no errno here */
#ifndef DAEMON_PLAT_H
#define DAEMON_PLAT_H

#include "frame.h"

#define P_OK 0
#define P_FAIL (-1)

/* --- the wire --- */
/* Win32: COM1. POSIX: stdin/stdout, so a parent can be driven over a pipe by a test. */

int p_serial_open(void);
/* Reads what is available, up to max. Returns the count, 0 when nothing is waiting, or
 * P_FAIL if the port died. Must not block for longer than a few milliseconds. */
int p_serial_read(u8 *buf, int max);
/* writes all of it, or returns P_FAIL */
int p_serial_write(const u8 *buf, int len);

/* --- the child --- */
/* a spawned process plus the two pipes we talk to it over, opaque to the caller */

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
/* 1 while the process is alive; reaps it when it is not, so this is also the exit check */
int p_child_alive(p_child *c);
void p_child_kill(p_child *c);
/* non-blocking, same contract as p_serial_read */
int p_child_read(p_child *c, u8 *buf, int max);
/* Writes a whole frame and never blocks indefinitely: a child that stops reading its
 * stdin fills the pipe, and a blocking write would park the process that also has to read
 * COM1, supervise, and kill that child. The write end is non-blocking from spawn and this
 * gives up after P_CHILD_WRITE_MS, returning P_FAIL; treat that as a wedged child rather
 * than a dropped frame. */
#define P_CHILD_WRITE_MS 250
int p_child_write(p_child *c, const u8 *buf, int len);

/* --- files --- */

/* Base directory comes from DAEMON_DIR, defaulting to C:\1999 on Win32 and the working
 * directory on POSIX. The environment rather than argv, so neither binary has to parse a
 * command line on a freestanding build, and the child inherits it. */
#ifdef _WIN32
#define P_SEP '\\'
#else
#define P_SEP '/'
#endif

void p_base_dir(char *out, int cap);

/* An integer from the environment, or `def`. Supervision timeouts read these so tests can
 * compress them; nothing sets them in production. */
int p_env_int(const char *name, int def);

/* writes the whole buffer, replacing anything already there */
int p_file_write(const char *path, const u8 *buf, int len);
/* reads up to max; returns the count or P_FAIL */
int p_file_read(const char *path, u8 *buf, int max);
int p_file_exists(const char *path);

/* best effort: a file that is missing or locked is not an error worth handling */
void p_file_delete(const char *path);
int p_dir_make(const char *path);

/* No "file age" call: liveness is the child writing its tick count into ALIVE and the
 * parent comparing against its own clock. An age from a Win32 FILETIME would need 64-bit
 * division, which pulls libgcc helpers into a binary that links no runtime. */

/* --- time --- */

/* Monotonic-ish millisecond counter. Win32 gives GetTickCount, which wraps after 49 days,
 * so callers must compare with subtraction and never with <. */
u32 p_ticks(void);
void p_sleep(int ms);

/* --- what the child reports --- */

/* The foreground window's executable and title, empty when unknown. Win32 asks the window
 * manager; POSIX reads a file under the base directory so a test can simulate a window
 * change without a desktop. */
void p_foreground(char *exe, int exe_cap, char *title, int title_cap);

/* Runs a command and captures its output, truncated to cap. Returns the exit code, or
 * P_FAIL if it could not be started. */
int p_exec(const char *cmd, char *out, int cap);

/* --- diagnostics --- */
/* stderr on POSIX, OutputDebugString on Win32 where there is no console */
void p_log(const char *msg);

/* A short line about the window manager as this process sees it, reported by `health`.
 * The guest has no console and no debugger, so the only way to learn why p_foreground
 * came back empty is to have it say so on the wire. */
void p_diag(char *out, int cap);

#endif
