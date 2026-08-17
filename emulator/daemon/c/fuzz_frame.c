/* feed the guest's decoder arbitrary bytes and see whether it can be made to misbehave
 *
 *   ./scripts/build-daemon.sh fuzz          (a few seconds, part of `npm run daemon`)
 *   ./scripts/build-daemon.sh fuzz 2000000  (a long run, when the framing changes)
 *
 * Randomised rather than coverage-guided: Apple's clang ships no libFuzzer, so the driver
 * mutates real frames under ASAN instead. The libFuzzer entry point is kept below, so
 * `clang -fsanitize=fuzzer` with a brew LLVM works unchanged. Every run is reproducible:
 * the seed is printed, and passing it back replays exactly.
 *
 * The parent's claim is that no input can crash it, wedge it, or read outside its own
 * buffer. The invariants it has to satisfy whatever arrives:
 *
 *   1. progress      pushing a non-empty buffer always accepts at least one byte, or the
 *                    decoder was already full and drops it; never zero forever
 *   2. containment   every frame handed out points inside the decoder's own buffer and
 *                    within its declared length
 *   3. no invention  a frame that comes out must have a correct CRC over its own bytes
 *   4. termination   draining always ends; no input makes f_dec_next loop
 *   5. field safety  f_fields on a hostile payload never points outside it */
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "frame.h"

/* frame.c keeps its own little-endian reader static, so this has one too */
static u32 rd32le(const u8 *p) {
  return (u32)p[0] | ((u32)p[1] << 8) | ((u32)p[2] << 16) | ((u32)p[3] << 24);
}

/* one decoder reused across a whole input, because state carried between pushes is where
 * the interesting bugs live: a stale candidate from one read meeting the next */
static void feed(const unsigned char *data, size_t size) {
  f_decoder d;
  f_frame out;
  size_t at = 0;
  int guard;

  f_dec_init(&d);
  while (at < size) {
    /* the first byte of each round picks how much of the rest to hand over, so the fuzzer
     * chooses the read boundaries: a frame split across reads is the normal case and a
     * stale header split across reads is the hazard */
    size_t want = (size_t)data[at] + 1;
    int took;
    at++;
    if (want > size - at) want = size - at;
    if (want == 0) break;

    took = f_dec_push(&d, data + at, (int)want);
    /* invariant 1: progress */
    if (took <= 0) {
      fprintf(stderr, "f_dec_push accepted %d of %zu bytes\n", took, want);
      __builtin_trap();
    }
    if (took > (int)want) {
      fprintf(stderr, "f_dec_push claimed more than it was given\n");
      __builtin_trap();
    }
    at += (size_t)took;

    /* invariant 4: draining terminates; the bound is generous, but without it a decoder
     * that yielded the same frame forever would hang here */
    guard = 0;
    while (f_dec_next(&d, &out)) {
      u32 crc;
      if (++guard > F_MAX_FRAME) {
        fprintf(stderr, "f_dec_next kept yielding frames\n");
        __builtin_trap();
      }
      /* invariant 2: containment */
      if (out.len < 0 || out.len > F_MAX_PAYLOAD) {
        fprintf(stderr, "frame length %d out of range\n", out.len);
        __builtin_trap();
      }
      if (out.payload < d.buf || out.payload + out.len > d.buf + F_MAX_FRAME) {
        fprintf(stderr, "frame payload points outside the decoder buffer\n");
        __builtin_trap();
      }
      /* invariant 3: no invention; the CRC covers type, flags, length and payload, which
       * sit immediately before the payload we were handed */
      crc = f_crc32(out.payload - (F_HEADER - 2), F_HEADER - 2 + out.len);
      if (crc != rd32le(out.payload + out.len)) {
        fprintf(stderr, "a frame came out with a bad CRC\n");
        __builtin_trap();
      }

      /* invariant 5: fields; a payload is attacker-shaped even inside a valid frame */
      {
        f_field fields[F_MAX_FIELDS];
        int n = f_fields(out.payload, out.len, fields, F_MAX_FIELDS);
        int i;
        for (i = 0; i < n; i++) {
          if (fields[i].len < 0 || fields[i].p < out.payload ||
              fields[i].p + fields[i].len > out.payload + out.len) {
            fprintf(stderr, "a field points outside its payload\n");
            __builtin_trap();
          }
          /* exercise the accessors on whatever it found: these run on real input in the
           * guest and must be total */
          {
            char text[64];
            u32 v = 0;
            f_field_str(&fields[i], text, (int)sizeof text);
            f_field_uint(&fields[i], &v);
            f_field_eq(&fields[i], "epoch");
          }
        }
      }
    }
  }
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
  if (size < 2) return 0;
  feed(data, size);
  return 0;
}

#ifndef FUZZ_LIBFUZZER

/* --- the standalone driver --- */

#include <stdlib.h>
#include <time.h>

/* xorshift64*, so a seed reproduces a run exactly on any machine */
static unsigned long long g_state;
static u32 rnd(void) {
  g_state ^= g_state >> 12;
  g_state ^= g_state << 25;
  g_state ^= g_state >> 27;
  return (u32)((g_state * 2685821657736338717ULL) >> 32);
}

#define CASE_MAX 4096

/* a believable frame, so mutations start from something the decoder accepts rather than
 * from noise it rejects in the first two bytes */
static int seed_frame(u8 *out, int cap) {
  u8 payload[256];
  f_builder b;
  int plen, n = (int)(rnd() % 5);
  int i;
  f_build_init(&b, payload, (int)sizeof payload);
  for (i = 0; i <= n; i++) {
    int len = (int)(rnd() % 24);
    u8 field[24];
    int j;
    for (j = 0; j < len; j++) field[j] = (u8)(rnd() & 0xff);
    f_add_bytes(&b, field, len);
  }
  plen = f_build_len(&b);
  if (plen < 0) return 0;
  return f_encode((u8)(1 + rnd() % 0x30), payload, plen, out, cap);
}

static int build_case(u8 *buf, int cap) {
  int n = 0;
  int frames = (int)(rnd() % 4);
  int i;

  /* a read-size byte, then some frames, then damage; feed() chooses its boundaries from
   * the read-size bytes */
  buf[n++] = (u8)(rnd() & 0xff);
  for (i = 0; i <= frames && n < cap - 32; i++) {
    int wrote = seed_frame(buf + n, cap - n);
    if (wrote > 0) n += wrote;
    if (n < cap) buf[n++] = (u8)(rnd() & 0xff);
  }
  /* garbage tail, sometimes: a lone sync word, or a plausible header with a length that
   * will never arrive, which is the restore hazard */
  switch (rnd() % 4) {
    case 0:
      if (n < cap - 2) {
        buf[n++] = 0x39;
        buf[n++] = 0x39;
      }
      break;
    case 1:
      if (n < cap - 8) {
        buf[n++] = 0x39;
        buf[n++] = 0x39;
        buf[n++] = (u8)(1 + rnd() % 0x30);
        buf[n++] = 0;
        buf[n++] = 0x00;
        buf[n++] = 0x00;
        buf[n++] = 0x01;
        buf[n++] = 0x00;
      }
      break;
    default:
      break;
  }
  /* now corrupt it, the way a UART still full of a previous session's bytes looks */
  {
    int flips = (int)(rnd() % 8);
    for (i = 0; i < flips && n > 0; i++) buf[rnd() % (u32)n] ^= (u8)(1 << (rnd() % 8));
    if (n > 4 && (rnd() % 4) == 0) n -= (int)(rnd() % (u32)(n / 2));
  }
  return n;
}

int main(int argc, char **argv) {
  static u8 buf[CASE_MAX];
  long long iterations = argc > 1 ? atoll(argv[1]) : 20000;
  unsigned long long seed =
      argc > 2 ? strtoull(argv[2], NULL, 10) : (unsigned long long)time(NULL);
  long long i;

  g_state = seed ? seed : 1;
  printf("fuzz: %lld cases, seed %llu\n", iterations, seed);
  for (i = 0; i < iterations; i++) {
    int n = build_case(buf, CASE_MAX);
    if (n >= 2) feed(buf, (size_t)n);
  }
  printf("fuzz: ok\n");
  return 0;
}

#endif
