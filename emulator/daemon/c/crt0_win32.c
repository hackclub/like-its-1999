/* The entire C runtime, for a program that needs almost none of one.
 *
 * mingw links msvcrt.dll by default, and its startup code calls exports that Windows 98's
 * msvcrt does not have. That is the usual reason a modern binary refuses to start on 98,
 * and you only find out by running it. Linking no runtime at all removes the question
 * instead of deferring it, and it costs this file: an entry point, the four memory
 * builtins GCC emits calls to regardless of -ffreestanding, and nothing else.
 *
 * The program was already written to need no more than that — fixed buffers, no
 * allocation, no formatting, file access straight through CreateFile — because the parent
 * must never crash, and that ruled out most of a runtime anyway.
 *
 * Built with: -nostdlib -ffreestanding -fno-builtin -Wl,-e,_entry, and the windows
 * subsystem so no console flashes up when Windows starts it.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* Whichever of these the binary defines; only one is linked in at a time. */
#ifdef DAEMON_PARENT
int daemon_parent_main(void);
#define DAEMON_MAIN daemon_parent_main
#else
int daemon_child_main(void);
#define DAEMON_MAIN daemon_child_main
#endif

/* GCC lowers struct assignment and array initialisation into calls to these no matter what
 * -ffreestanding says, so they have to exist. Straightforward byte loops: nothing here is
 * on a hot path, and a clever version would be a liability rather than a saving. */
void *memcpy(void *dst, const void *src, unsigned int n) {
  unsigned char *d = (unsigned char *)dst;
  const unsigned char *s = (const unsigned char *)src;
  unsigned int i;
  for (i = 0; i < n; i++) d[i] = s[i];
  return dst;
}

void *memmove(void *dst, const void *src, unsigned int n) {
  unsigned char *d = (unsigned char *)dst;
  const unsigned char *s = (const unsigned char *)src;
  unsigned int i;
  if (d == s || n == 0) return dst;
  if (d < s) {
    for (i = 0; i < n; i++) d[i] = s[i];
  } else {
    for (i = n; i > 0; i--) d[i - 1] = s[i - 1];
  }
  return dst;
}

void *memset(void *dst, int c, unsigned int n) {
  unsigned char *d = (unsigned char *)dst;
  unsigned int i;
  for (i = 0; i < n; i++) d[i] = (unsigned char)c;
  return dst;
}

int memcmp(const void *a, const void *b, unsigned int n) {
  const unsigned char *x = (const unsigned char *)a;
  const unsigned char *y = (const unsigned char *)b;
  unsigned int i;
  for (i = 0; i < n; i++)
    if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/* The real entry point. No argv (the base directory comes from the environment, which is
 * why neither binary parses a command line), no atexit, no cleanup: ExitProcess is the
 * whole teardown. */
void entry(void) { ExitProcess((UINT)DAEMON_MAIN()); }
