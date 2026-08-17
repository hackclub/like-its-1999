/* the whole C runtime for this program: an entry point and four memory builtins
 *
 * mingw links msvcrt.dll by default and its startup code calls exports Windows 98's
 * msvcrt does not have, which is the usual reason a modern binary refuses to start on 98.
 * Linking no runtime at all removes the question.
 *
 * built with -nostdlib -ffreestanding -fno-builtin -Wl,-e,_entry, windows subsystem so no
 * console flashes up at startup */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* only one of these is linked in at a time */
#ifdef DAEMON_PARENT
int daemon_parent_main(void);
#define DAEMON_MAIN daemon_parent_main
#else
int daemon_child_main(void);
#define DAEMON_MAIN daemon_child_main
#endif

/* GCC lowers struct assignment and array initialisation into calls to these whatever
 * -ffreestanding says, so they have to exist; nothing here is on a hot path */
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

/* the real entry point: no argv (the base directory comes from the environment), no
 * atexit, and ExitProcess is the whole teardown */
void entry(void) { ExitProcess((UINT)DAEMON_MAIN()); }
