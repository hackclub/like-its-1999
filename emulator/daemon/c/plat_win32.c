/* The Windows 98 implementation of plat.h.
 *
 * Every call here is one that has existed since Windows 95, because that is what running
 * on 98 means in practice. Two traps this navigates on purpose:
 *
 *   - SetHandleInformation is NT-only. Making our end of a pipe non-inheritable is done
 *     the 9x way, with DuplicateHandle.
 *   - Overlapped I/O on a COM port is not supported on 9x, so reads are non-blocking by
 *     timeout (COMMTIMEOUTS) rather than asynchronous.
 *
 * No CRT: see crt0_win32.c. The strings here are plain byte loops for the same reason.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h> /* the 9x way to walk processes; psapi is NT-only */

#include "plat.h"

/* How long exec waits for output before returning and leaving the program running. */
#define EXEC_TIMEOUT_MS 4000

/* Where "the wire" is depends on which binary this is, and only on Windows.
 *
 * The parent owns COM1. The child talks to the parent over the pipes it was spawned with,
 * which arrive as its standard handles. On POSIX both roles use stdin/stdout and the
 * distinction does not exist, which is exactly why no host test could catch getting this
 * wrong: the first build had the child open COM1, the parent already held it, and the
 * child exited within milliseconds of every spawn. */
static int slen(const char *s) {
  int n = 0;
  while (s[n]) n++;
  return n;
}

/* --- the wire -------------------------------------------------------------------- */

#ifdef DAEMON_CHILD

static HANDLE g_in = INVALID_HANDLE_VALUE;
static HANDLE g_out = INVALID_HANDLE_VALUE;

/* The child: the pipes the parent gave us. */
int p_serial_open(void) {
  g_in = GetStdHandle(STD_INPUT_HANDLE);
  g_out = GetStdHandle(STD_OUTPUT_HANDLE);
  return (g_in == INVALID_HANDLE_VALUE || g_out == INVALID_HANDLE_VALUE) ? P_FAIL
                                                                         : P_OK;
}

int p_serial_read(u8 *buf, int max) {
  DWORD avail = 0, got = 0;
  if (g_in == INVALID_HANDLE_VALUE) return P_FAIL;
  /* Peek first: a plain read on a pipe blocks until something arrives, and this loop has
   * a liveness file to stamp and a foreground window to poll. */
  if (!PeekNamedPipe(g_in, NULL, 0, NULL, &avail, NULL)) return P_FAIL;
  if (avail == 0) return 0;
  if ((int)avail > max) avail = (DWORD)max;
  if (!ReadFile(g_in, buf, avail, &got, NULL)) return P_FAIL;
  return (int)got;
}

int p_serial_write(const u8 *buf, int len) {
  int at = 0;
  if (g_out == INVALID_HANDLE_VALUE) return P_FAIL;
  while (at < len) {
    DWORD wrote = 0;
    if (!WriteFile(g_out, buf + at, (DWORD)(len - at), &wrote, NULL)) return P_FAIL;
    if (wrote == 0) return P_FAIL;
    at += (int)wrote;
  }
  return P_OK;
}

#else

static HANDLE g_port = INVALID_HANDLE_VALUE;

/* The parent: the real serial port. */
int p_serial_open(void) {
  DCB dcb;
  COMMTIMEOUTS to;

  g_port = CreateFileA("COM1", GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                       0, NULL);
  if (g_port == INVALID_HANDLE_VALUE) return P_FAIL;

  /* Ask for a receive buffer far bigger than the default kilobyte. The emulated UART
   * delivers a host write as fast as the guest can take interrupts, so a burst arrives
   * essentially instantly and a small driver buffer overruns before we get a poll in. */
  SetupComm(g_port, 16384, 16384);

  dcb.DCBlength = sizeof dcb;
  if (!GetCommState(g_port, &dcb)) return P_FAIL;
  dcb.BaudRate = CBR_115200;
  dcb.ByteSize = 8;
  dcb.Parity = NOPARITY;
  dcb.StopBits = ONESTOPBIT;
  /* Every one of these is set explicitly rather than inherited from GetCommState, because
   * the defaults differ between Windows versions and three of them would quietly destroy a
   * binary protocol:
   *   fBinary        FALSE makes the driver treat EofChar as end of input
   *   fNull          TRUE discards every zero byte, and our frames are full of them
   *   fAbortOnError  TRUE latches on the first overrun and refuses all further I/O
   * The last one is the likeliest reason the first build went permanently deaf after a
   * large push while still holding the port open. */
  dcb.fBinary = TRUE;
  dcb.fNull = FALSE;
  dcb.fAbortOnError = FALSE;
  dcb.fParity = FALSE;
  dcb.fErrorChar = FALSE;
  /* No flow control of any kind: v86 models neither RTS/CTS nor XON/XOFF faithfully. */
  dcb.fOutxCtsFlow = FALSE;
  dcb.fOutxDsrFlow = FALSE;
  dcb.fDsrSensitivity = FALSE;
  dcb.fDtrControl = DTR_CONTROL_ENABLE;
  dcb.fRtsControl = RTS_CONTROL_ENABLE;
  dcb.fOutX = FALSE;
  dcb.fInX = FALSE;
  if (!SetCommState(g_port, &dcb)) return P_FAIL;
  PurgeComm(g_port, PURGE_RXCLEAR | PURGE_TXCLEAR);

  /* Return immediately with whatever is buffered: the loop polls rather than blocks, and
   * 9x has no overlapped comm I/O to do it any other way. */
  to.ReadIntervalTimeout = MAXDWORD;
  to.ReadTotalTimeoutMultiplier = 0;
  to.ReadTotalTimeoutConstant = 0;
  to.WriteTotalTimeoutMultiplier = 0;
  to.WriteTotalTimeoutConstant = 5000;
  SetCommTimeouts(g_port, &to);
  return P_OK;
}

int p_serial_read(u8 *buf, int max) {
  DWORD got = 0;
  DWORD errors = 0;
  COMSTAT st;
  if (g_port == INVALID_HANDLE_VALUE) return P_FAIL;

  /* Unconditionally, every poll, before reading. An overrun or framing error latches in
   * the driver, and on 9x a latched error can stop delivery entirely while ReadFile keeps
   * cheerfully returning success with nothing in it — which looks exactly like an idle
   * port and is impossible to tell apart from one. Clearing first costs nothing and means
   * a lost byte only ever costs us a frame, which the decoder resynchronises past. */
  ClearCommError(g_port, &errors, &st);

  if (!ReadFile(g_port, buf, (DWORD)max, &got, NULL)) {
    ClearCommError(g_port, &errors, &st);
    return 0;
  }
  return (int)got;
}

int p_serial_write(const u8 *buf, int len) {
  int at = 0;
  if (g_port == INVALID_HANDLE_VALUE) return P_FAIL;
  while (at < len) {
    DWORD wrote = 0;
    if (!WriteFile(g_port, buf + at, (DWORD)(len - at), &wrote, NULL)) return P_FAIL;
    if (wrote == 0) return P_FAIL;
    at += (int)wrote;
  }
  return P_OK;
}

#endif /* DAEMON_CHILD */

/* --- the child ------------------------------------------------------------------- */

void p_child_init(p_child *c) {
  c->proc = NULL;
  c->to_in = NULL;
  c->from_out = NULL;
  c->running = 0;
  c->nonblocking = 0;
}

/* A pipe end the child must not inherit. SetHandleInformation would be the modern way and
 * does not exist on 9x, so duplicate it without inheritance and drop the original. */
static HANDLE uninheritable(HANDLE h) {
  HANDLE copy = NULL;
  HANDLE self = GetCurrentProcess();
  if (!DuplicateHandle(self, h, self, &copy, 0, FALSE, DUPLICATE_SAME_ACCESS))
    return h;
  CloseHandle(h);
  return copy;
}

int p_child_spawn(p_child *c, const char *path, const char *arg) {
  SECURITY_ATTRIBUTES sa;
  STARTUPINFOA si;
  PROCESS_INFORMATION pi;
  HANDLE in_r = NULL, in_w = NULL, out_r = NULL, out_w = NULL;
  char cmd[300];
  char here[200];
  int n = 0, i;

  if (c->running) return P_FAIL;

  sa.nLength = sizeof sa;
  sa.lpSecurityDescriptor = NULL;
  sa.bInheritHandle = TRUE;
  if (!CreatePipe(&in_r, &in_w, &sa, 0)) return P_FAIL;
  if (!CreatePipe(&out_r, &out_w, &sa, 0)) {
    CloseHandle(in_r);
    CloseHandle(in_w);
    return P_FAIL;
  }
  in_w = uninheritable(in_w);
  out_r = uninheritable(out_r);

  /* Refuse to block when the child stops reading. PIPE_NOWAIT is the legacy LAN Manager
   * mode and is exactly what it is good for here: WriteFile then returns immediately,
   * having written what fit. If 9x declines it we remember that, and parent.c refuses to
   * forward to a child that has stopped proving it is alive. */
  {
    DWORD mode = PIPE_NOWAIT;
    c->nonblocking = SetNamedPipeHandleState(in_w, &mode, NULL, NULL) ? 1 : 0;
  }

  for (i = 0; path[i] && n < (int)sizeof cmd - 2; i++) cmd[n++] = path[i];
  if (arg) {
    cmd[n++] = ' ';
    for (i = 0; arg[i] && n < (int)sizeof cmd - 1; i++) cmd[n++] = arg[i];
  }
  cmd[n] = 0;
  /* Somewhere on the hard disk, never wherever the parent happened to be started from. A
   * child that inherits a CD as its working directory keeps the tray locked and dies with
   * the disc, and on 9x a working directory on removable media is enough on its own to
   * stop COMMAND.COM launching. */
  p_base_dir(here, (int)sizeof here);

  for (i = 0; i < (int)sizeof si; i++) ((char *)&si)[i] = 0;
  si.cb = sizeof si;
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE; /* no window, and no console flash */
  si.hStdInput = in_r;
  si.hStdOutput = out_w;
  si.hStdError = out_w;

  if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE, 0, NULL, here, &si, &pi)) {
    CloseHandle(in_r);
    CloseHandle(in_w);
    CloseHandle(out_r);
    CloseHandle(out_w);
    return P_FAIL;
  }
  CloseHandle(pi.hThread);
  CloseHandle(in_r);
  CloseHandle(out_w);

  c->proc = (void *)pi.hProcess;
  c->to_in = (void *)in_w;
  c->from_out = (void *)out_r;
  c->running = 1;
  return P_OK;
}

int p_child_alive(p_child *c) {
  DWORD code = 0;
  if (!c->running) return 0;
  if (!GetExitCodeProcess((HANDLE)c->proc, &code) || code != STILL_ACTIVE) {
    CloseHandle((HANDLE)c->proc);
    if (c->to_in) CloseHandle((HANDLE)c->to_in);
    if (c->from_out) CloseHandle((HANDLE)c->from_out);
    p_child_init(c);
    return 0;
  }
  return 1;
}

void p_child_kill(p_child *c) {
  if (!c->running) return;
  TerminateProcess((HANDLE)c->proc, 1);
  CloseHandle((HANDLE)c->proc);
  if (c->to_in) CloseHandle((HANDLE)c->to_in);
  if (c->from_out) CloseHandle((HANDLE)c->from_out);
  p_child_init(c);
}

int p_child_read(p_child *c, u8 *buf, int max) {
  DWORD avail = 0, got = 0;
  if (!c->running || !c->from_out) return 0;
  /* Peek first: a plain ReadFile on a pipe blocks until something arrives, which would
   * stall the supervision loop. PeekNamedPipe works on anonymous pipes on 9x. */
  if (!PeekNamedPipe((HANDLE)c->from_out, NULL, 0, NULL, &avail, NULL)) return P_FAIL;
  if (avail == 0) return 0;
  if ((int)avail > max) avail = (DWORD)max;
  if (!ReadFile((HANDLE)c->from_out, buf, avail, &got, NULL)) return P_FAIL;
  return (int)got;
}

int p_child_write(p_child *c, const u8 *buf, int len) {
  int at = 0;
  u32 deadline;
  if (!c->running || !c->to_in) return P_FAIL;
  deadline = p_ticks() + P_CHILD_WRITE_MS;
  while (at < len) {
    DWORD wrote = 0;
    if (!WriteFile((HANDLE)c->to_in, buf + at, (DWORD)(len - at), &wrote, NULL))
      return P_FAIL;
    at += (int)wrote;
    if (at >= len) break;
    /* In PIPE_NOWAIT mode a full pipe is a successful write of zero bytes, so this is the
     * ordinary "child is behind" path rather than an error. */
    if ((u32)(p_ticks() - deadline) < 0x80000000UL) return P_FAIL;
    Sleep(5);
  }
  return P_OK;
}

/* --- files ----------------------------------------------------------------------- */

int p_file_write(const char *path, const u8 *buf, int len) {
  HANDLE h = CreateFileA(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL, NULL);
  DWORD wrote = 0;
  if (h == INVALID_HANDLE_VALUE) return P_FAIL;
  if (!WriteFile(h, buf, (DWORD)len, &wrote, NULL) || (int)wrote != len) {
    CloseHandle(h);
    return P_FAIL;
  }
  CloseHandle(h);
  return P_OK;
}

int p_file_read(const char *path, u8 *buf, int max) {
  HANDLE h = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  DWORD got = 0;
  if (h == INVALID_HANDLE_VALUE) return P_FAIL;
  if (!ReadFile(h, buf, (DWORD)max, &got, NULL)) {
    CloseHandle(h);
    return P_FAIL;
  }
  CloseHandle(h);
  return (int)got;
}

int p_file_exists(const char *path) {
  return GetFileAttributesA(path) != 0xFFFFFFFF;
}

void p_file_delete(const char *path) { DeleteFileA(path); }

int p_dir_make(const char *path) {
  if (CreateDirectoryA(path, NULL)) return P_OK;
  return GetLastError() == ERROR_ALREADY_EXISTS ? P_OK : P_FAIL;
}

void p_base_dir(char *out, int cap) {
  DWORD n = GetEnvironmentVariableA("DAEMON_DIR", out, (DWORD)cap);
  if (n == 0 || n >= (DWORD)cap) {
    const char *def = "C:\\1999";
    int i = 0;
    while (def[i] && i < cap - 1) {
      out[i] = def[i];
      i++;
    }
    out[i] = 0;
  }
}

int p_env_int(const char *name, int def) {
  char buf[16];
  DWORD n = GetEnvironmentVariableA(name, buf, sizeof buf);
  int v = 0, i;
  if (n == 0 || n >= sizeof buf) return def;
  for (i = 0; buf[i]; i++) {
    if (buf[i] < '0' || buf[i] > '9') return def;
    v = v * 10 + (buf[i] - '0');
  }
  return v;
}

/* --- what the child reports -------------------------------------------------------- */

/* The executable behind a window. ToolHelp32 is the 9x way to walk processes; the psapi
 * route everyone reaches for first is NT-only, and this only ever runs on 98. */
static void exe_for_window(HWND w, char *exe, int cap) {
  DWORD pid = 0;
  HANDLE snap;
  PROCESSENTRY32 pe;
  exe[0] = 0;
  GetWindowThreadProcessId(w, &pid);
  if (!pid) return;
  snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return;
  pe.dwSize = sizeof pe;
  if (Process32First(snap, &pe)) {
    do {
      if (pe.th32ProcessID == pid) {
        /* szExeFile is a full path on 9x; keep only the file name. */
        int i, start = 0;
        for (i = 0; pe.szExeFile[i]; i++)
          if (pe.szExeFile[i] == '\\' || pe.szExeFile[i] == '/') start = i + 1;
        for (i = 0; pe.szExeFile[start + i] && i < cap - 1; i++)
          exe[i] = pe.szExeFile[start + i];
        exe[i] = 0;
        break;
      }
    } while (Process32Next(snap, &pe));
  }
  CloseHandle(snap);
}

void p_foreground(char *exe, int exe_cap, char *title, int title_cap) {
  HWND w = GetForegroundWindow();
  exe[0] = 0;
  title[0] = 0;
  if (!w) return;
  GetWindowTextA(w, title, title_cap);
  exe_for_window(w, exe, exe_cap);
}

/* Why something failed, written where the caller can see it: these run inside the guest,
 * where there is no console and no debugger, so an error code that never leaves the
 * process is an afternoon of guessing. */
static void why(char *out, int cap, const char *what, DWORD err) {
  char num[12];
  int n = 0, i, d = 0;
  for (i = 0; what[i] && n < cap - 1; i++) out[n++] = what[i];
  if (n < cap - 2) {
    out[n++] = ' ';
    do {
      num[d++] = (char)('0' + (err % 10));
      err /= 10;
    } while (err && d < (int)sizeof num);
    while (d && n < cap - 1) out[n++] = num[--d];
  }
  out[n] = 0;
}

/* Run a command through the shell and capture what it prints. COMMAND.COM rather than
 * cmd.exe, because this is Windows 98. */
int p_exec(const char *cmd, char *out, int cap) {
  SECURITY_ATTRIBUTES sa;
  STARTUPINFOA si;
  PROCESS_INFORMATION pi;
  HANDLE r = NULL, w = NULL, nul = INVALID_HANDLE_VALUE;
  char line[512];
  char shell[200];
  char here[200];
  int n = 0, i;
  DWORD code = 0;

  out[0] = 0;
  /* COMSPEC rather than a bare "COMMAND.COM": the search CreateProcess does without a full
   * path starts at the calling image's directory and the current directory, and this
   * process gets launched with whatever the parent inherited, which has been E:\ often
   * enough to matter. */
  if (!GetEnvironmentVariableA("COMSPEC", shell, (DWORD)sizeof shell)) {
    const char *def = "C:\\WINDOWS\\COMMAND.COM";
    for (i = 0; def[i]; i++) shell[i] = def[i];
    shell[i] = 0;
  }
  sa.nLength = sizeof sa;
  sa.lpSecurityDescriptor = NULL;
  sa.bInheritHandle = TRUE;
  if (!CreatePipe(&r, &w, &sa, 0)) {
    why(out, cap, "CreatePipe failed, error", GetLastError());
    return P_FAIL;
  }
  r = uninheritable(r);

  /* A real handle rather than NULL. 9x is far less forgiving than NT here: with
   * STARTF_USESTDHANDLES it hands all three straight to the new process, and a null stdin
   * is what a COMMAND.COM launch trips over. */
  nul = CreateFileA("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                    OPEN_EXISTING, 0, NULL);

  for (i = 0; shell[i] && n < (int)sizeof line - 6; i++) line[n++] = shell[i];
  line[n++] = ' ';
  line[n++] = '/';
  line[n++] = 'C';
  line[n++] = ' ';
  for (i = 0; cmd[i] && n < (int)sizeof line - 1; i++) line[n++] = cmd[i];
  line[n] = 0;
  p_base_dir(here, (int)sizeof here);

  for (i = 0; i < (int)sizeof si; i++) ((char *)&si)[i] = 0;
  si.cb = sizeof si;
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  si.hStdOutput = w;
  si.hStdError = w;
  si.hStdInput = nul == INVALID_HANDLE_VALUE ? NULL : nul;

  if (!CreateProcessA(NULL, line, NULL, NULL, TRUE, 0, NULL, here, &si, &pi)) {
    why(out, cap, "CreateProcess failed, error", GetLastError());
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    CloseHandle(r);
    CloseHandle(w);
    return P_FAIL;
  }
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  CloseHandle(w); /* our copy: the read ends when the child's copy closes */
  CloseHandle(pi.hThread);

  /* Collect output with a deadline, peeking rather than blocking.
   *
   * Reading to EOF would be the obvious thing and is a trap: a GUI program launched from
   * the shell inherits the pipe's write end, so the pipe never closes while its window is
   * open, and a blocking read would hang the child until the user closed it. The child
   * would then stop stamping its liveness file and the parent would kill it, all because
   * somebody opened Notepad. */
  n = 0;
  {
    u32 deadline = p_ticks() + EXEC_TIMEOUT_MS;
    for (;;) {
      DWORD avail = 0, got = 0;
      if (n >= cap - 1) break;
      if (!PeekNamedPipe(r, NULL, 0, NULL, &avail, NULL)) break;
      if (avail > 0) {
        if ((int)avail > cap - 1 - n) avail = (DWORD)(cap - 1 - n);
        if (!ReadFile(r, out + n, avail, &got, NULL) || got == 0) break;
        n += (int)got;
        continue;
      }
      /* Nothing waiting: stop once the process is gone, or the deadline passes. */
      if (!GetExitCodeProcess(pi.hProcess, &code) || code != STILL_ACTIVE) break;
      if ((u32)(p_ticks() - deadline) < 0x80000000UL) break;
      Sleep(20);
    }
  }
  out[n] = 0;

  GetExitCodeProcess(pi.hProcess, &code);
  if (code == STILL_ACTIVE) code = 0; /* left running on purpose, not a failure */
  CloseHandle(pi.hProcess);
  CloseHandle(r);
  return (int)code;
}

void p_diag(char *out, int cap) {
  HWND w = GetForegroundWindow();
  DWORD pid = 0;
  HANDLE snap;
  char part[128];
  int n = 0, i;

  GetWindowThreadProcessId(w, &pid);
  snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);

#define DIAG_ADD(s)                                    \
  for (i = 0; (s)[i] && n < cap - 1; i++) out[n++] = (s)[i]

  why(part, (int)sizeof part, "fg", (DWORD)(w != NULL));
  DIAG_ADD(part);
  why(part, (int)sizeof part, " desktop", (DWORD)(GetDesktopWindow() != NULL));
  DIAG_ADD(part);
  why(part, (int)sizeof part, " pid", pid);
  DIAG_ADD(part);
  why(part, (int)sizeof part, " snap", (DWORD)(snap != INVALID_HANDLE_VALUE));
  DIAG_ADD(part);
  /* The environment the child inherited. CreateProcess finds COMMAND.COM through PATH,
   * so an empty environment looks exactly like a missing shell. */
  DIAG_ADD(" comspec=");
  part[0] = 0;
  GetEnvironmentVariableA("COMSPEC", part, (DWORD)sizeof part);
  DIAG_ADD(part[0] ? part : "(unset)");
  DIAG_ADD(" cwd=");
  part[0] = 0;
  GetCurrentDirectoryA((DWORD)sizeof part, part);
  DIAG_ADD(part[0] ? part : "(none)");

#undef DIAG_ADD

  out[n] = 0;
  if (snap != INVALID_HANDLE_VALUE) CloseHandle(snap);
}

/* --- time and logging -------------------------------------------------------------- */

u32 p_ticks(void) { return (u32)GetTickCount(); }

void p_sleep(int ms) { Sleep((DWORD)ms); }

/* There is no console on a windows-subsystem program, so this goes where a debugger can
 * see it. Silent in normal operation. */
void p_log(const char *msg) {
  OutputDebugStringA(msg);
  (void)slen(msg);
}
