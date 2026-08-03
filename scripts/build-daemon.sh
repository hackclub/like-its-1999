#!/usr/bin/env bash
# Build the guest agent.
#
#   scripts/build-daemon.sh host    clang -> emulator/daemon/build/  (tests, macOS)
#   scripts/build-daemon.sh guest   mingw -> emulator/daemon/bin/    (ships to Win98)
#   scripts/build-daemon.sh test    build host, run the C unit tests
#   scripts/build-daemon.sh         all of the above
#
# The guest target is freestanding on purpose: no C runtime, our own entry point, our own
# memcpy. mingw's CRT startup is the usual reason a modern binary refuses to run on
# Windows 98, and not linking it removes the question rather than deferring it to the VM.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=emulator/daemon/c
BUILD=emulator/daemon/build
BIN=emulator/daemon/bin
mkdir -p "$BUILD" "$BIN"

# C89 keeps the door open for an older compiler (Open Watcom is the fallback if mingw's
# output ever turns out not to run on 98), and the warnings are errors because this code
# has to be right rather than convenient.
WARN="-Wall -Wextra -Werror -std=c89 -pedantic"

build_host() {
  echo "host: clang -> $BUILD"
  clang -Os $WARN -o "$BUILD/test_frame" "$SRC/frame.c" "$SRC/test_frame.c"
  clang -Os $WARN -o "$BUILD/test_golden" "$SRC/frame.c" "$SRC/test_golden.c"
  clang -Os $WARN -o "$BUILD/daemon" "$SRC/frame.c" "$SRC/parent.c" "$SRC/plat_posix.c"
  clang -Os $WARN -o "$BUILD/child" "$SRC/frame.c" "$SRC/child.c" "$SRC/plat_posix.c"
}

run_tests() {
  echo "tests:"
  "$BUILD/test_frame"
}

build_guest() {
  if ! command -v i686-w64-mingw32-gcc >/dev/null 2>&1; then
    echo "guest: SKIPPED, i686-w64-mingw32-gcc not found (brew install mingw-w64)" >&2
    return 0
  fi
  echo "guest: mingw -> $BIN"
  # -nostdlib        no C runtime at all; crt0_win32.c is the entry point and the four
  #                  memory builtins GCC emits calls to regardless
  # -ffreestanding   do not assume a hosted library exists
  # -fno-builtin     stop GCC rewriting our own memcpy into a call to itself
  # -DDAEMON_NO_MAIN    the guest entry is `entry`, so main() must not be compiled: GCC emits
  #                  a call to __main from it, which lives in the runtime we are not linking
  # subsystem 4.0    the 9x loader rejects the modern default
  # windows (not console) so no DOS box flashes up when Windows starts it
  # --no-insert-timestamp  reproducible output. The child's identity IS the hash of its
  #                  bytes, and the image ships with that hash pre-cached, so a PE header
  #                  timestamp would mean every rebuild of unchanged source minted a new
  #                  identity and cost a re-push on every boot until the image caught up.
  #
  # -std=c89 without -pedantic here: the mingw headers are not C89-clean, and the warning
  # would be about Microsoft's declarations rather than about our code.
  local GWARN="-Wall -Wextra -Werror -std=c89"
  local FLAGS="-Os $GWARN -nostdlib -ffreestanding -fno-builtin -DDAEMON_NO_MAIN \
    -fno-asynchronous-unwind-tables -fno-ident -ffunction-sections \
    -Wl,--subsystem,windows:4.0 -Wl,-e,_entry -Wl,--gc-sections \
    -Wl,--no-insert-timestamp"
  # shellcheck disable=SC2086
  i686-w64-mingw32-gcc $FLAGS -DDAEMON_PARENT -o "$BIN/daemon.exe" \
    "$SRC/frame.c" "$SRC/parent.c" "$SRC/plat_win32.c" "$SRC/crt0_win32.c" \
    -lkernel32 -luser32
  # The child is what the host pushes over the wire, so it is a web asset rather than an
  # executable in the tree; .bin keeps it out of anything that scans for programs.
  # shellcheck disable=SC2086
  i686-w64-mingw32-gcc $FLAGS -DDAEMON_CHILD -o "$BIN/child.bin" \
    "$SRC/frame.c" "$SRC/child.c" "$SRC/plat_win32.c" "$SRC/crt0_win32.c" \
    -lkernel32 -luser32
  node scripts/audit-pe.mjs "$BIN/daemon.exe" "$BIN/child.bin"
  ls -l "$BIN"
}

# Randomised decoder testing under ASAN. The parent's central claim is that no input can
# crash it or make it read outside its own buffer, and this is the only thing here that tests
# that claim rather than restating it (verified against planted bugs: a missing CRC check and
# an out-of-bounds read were both caught). Apple's clang ships no libFuzzer, so the driver in
# fuzz_frame.c mutates real frames itself; the seed is printed and replays exactly.
run_fuzz() {
  echo "fuzz: clang -fsanitize=address -> $BUILD"
  clang -O1 -g -fsanitize=address -fno-omit-frame-pointer -I"$SRC" \
    -o "$BUILD/fuzz_frame" "$SRC/frame.c" "$SRC/fuzz_frame.c"
  "$BUILD/fuzz_frame" "${1:-20000}" ${2:+"$2"}
}

case "${1:-all}" in
host) build_host ;;
fuzz) run_fuzz "${2:-20000}" "${3:-}" ;;
guest) build_guest ;;
test)
  build_host
  run_tests
  run_fuzz 20000
  ;;
all)
  build_host
  run_tests
  run_fuzz 20000
  build_guest
  ;;
*)
  echo "usage: $0 [host|guest|test|all]" >&2
  exit 2
  ;;
esac
