/* Host-side unit tests for the portable framing, built with clang.
 *
 * Mirrors ../frame.test.mjs case for case, because the two implementations have to agree
 * and the cheapest way to keep them agreeing is to make them fail the same way. The
 * cross-language golden vectors (test_golden.c) then check they agree byte for byte.
 *
 * Uses printf, which the guest build never does: this binary is host-only.
 */
#include <stdio.h>
#include <string.h>

#include "frame.h"

static int failures = 0;
static int checks = 0;

static void ok(int cond, const char *what) {
  checks++;
  if (!cond) {
    failures++;
    printf("  FAIL %s\n", what);
  }
}

static void eq_int(long got, long want, const char *what) {
  checks++;
  if (got != want) {
    failures++;
    printf("  FAIL %s: got %ld want %ld\n", what, got, want);
  }
}

/* One frame in, decoded back out. */
static int roundtrip(u8 type, const char **strs, int n) {
  static u8 payload[F_MAX_PAYLOAD];
  static u8 wire[F_MAX_FRAME];
  static f_decoder d;
  f_builder b;
  f_frame out;
  f_field fields[F_MAX_FIELDS];
  int plen, wlen, count, i;

  f_build_init(&b, payload, sizeof payload);
  for (i = 0; i < n; i++) f_add_str(&b, strs[i]);
  plen = f_build_len(&b);
  if (plen < 0) return 0;

  wlen = f_encode(type, payload, plen, wire, sizeof wire);
  if (wlen < 0) return 0;

  f_dec_init(&d);
  f_dec_push(&d, wire, wlen);
  if (!f_dec_next(&d, &out)) return 0;
  if (out.type != type) return 0;

  count = f_fields(out.payload, out.len, fields, F_MAX_FIELDS);
  if (count != n) return 0;
  for (i = 0; i < n; i++)
    if (!f_field_eq(&fields[i], strs[i])) return 0;
  return 1;
}

static void test_crc(void) {
  printf("crc32\n");
  eq_int((long)f_crc32((const u8 *)"", 0), 0, "empty");
  eq_int((long)f_crc32((const u8 *)"123456789", 9), 0xcbf43926L, "check value");
  eq_int((long)f_crc32((const u8 *)"The quick brown fox", 19), 0xb74574deL, "fox");
}

static void test_roundtrip(void) {
  const char *simple[] = {"win", "EDITPLUS.EXE"};
  /* The characters that break every delimited text protocol. */
  const char *nasty[] = {"win", "C:\\My Documents\\a\tb\nc\"d'e\\ - EditPlus", "",
                         "42"};
  printf("round trip\n");
  ok(roundtrip(F_EVENT, simple, 2), "simple");
  ok(roundtrip(F_EVENT, nasty, 4), "tabs, newlines, quotes, backslashes, empty");
  ok(roundtrip(F_RESET, simple, 0), "no fields");
}

static void test_decode_hazards(void) {
  static u8 wire[F_MAX_FRAME];
  static u8 junkwire[F_MAX_FRAME + 64];
  static f_decoder d;
  u8 payload[64];
  f_builder b;
  f_frame out;
  int plen, wlen, i;

  printf("decode hazards\n");
  f_build_init(&b, payload, sizeof payload);
  f_add_str(&b, "win");
  /* '99' inside a payload is a legitimate substring of plenty of real titles. */
  f_add_str(&b, "like-its-1999 - EditPlus");
  plen = f_build_len(&b);
  wlen = f_encode(F_EVENT, payload, plen, wire, sizeof wire);

  /* Garbage first, including a false sync word. */
  {
    static const u8 junk[] = {0, 1, 2, 0x39, 0x39, 0xff, 0xff, 3, 4};
    int n = (int)sizeof junk;
    memcpy(junkwire, junk, n);
    memcpy(junkwire + n, wire, wlen);
    f_dec_init(&d);
    f_dec_push(&d, junkwire, n + wlen);
    ok(f_dec_next(&d, &out) == 1, "frame found after garbage");
    ok(d.dropped >= (u32)n, "garbage counted as dropped");
  }

  /* A truncated tail is kept, not discarded. */
  f_dec_init(&d);
  f_dec_push(&d, wire, wlen - 3);
  ok(f_dec_next(&d, &out) == 0, "incomplete frame waits");
  f_dec_push(&d, wire + wlen - 3, 3);
  ok(f_dec_next(&d, &out) == 1, "and completes when the rest arrives");

  /* Bad CRC. */
  f_dec_init(&d);
  wire[wlen - 1] ^= 0xff;
  f_dec_push(&d, wire, wlen);
  ok(f_dec_next(&d, &out) == 0, "bad crc rejected");
  wire[wlen - 1] ^= 0xff;

  /* A corrupted payload is caught by the CRC. */
  f_dec_init(&d);
  wire[F_HEADER + 4] ^= 0x01;
  f_dec_push(&d, wire, wlen);
  ok(f_dec_next(&d, &out) == 0, "corrupt payload rejected");
  wire[F_HEADER + 4] ^= 0x01;

  /* Any flag bit set means skip: they are all reserved. */
  f_dec_init(&d);
  wire[3] = 0x01;
  f_dec_push(&d, wire, wlen);
  ok(f_dec_next(&d, &out) == 0, "reserved flag makes a frame skippable");
  wire[3] = 0;

  /* Type 0 is not a frame. */
  f_dec_init(&d);
  wire[2] = 0;
  f_dec_push(&d, wire, wlen);
  ok(f_dec_next(&d, &out) == 0, "type 0 rejected");
  wire[2] = F_EVENT;

  /* An oversize length is rejected without waiting for the bytes. */
  {
    u8 header[F_HEADER];
    header[0] = F_SYNC0;
    header[1] = F_SYNC1;
    header[2] = F_PING;
    header[3] = 0;
    header[4] = 0x01;
    header[5] = 0x00;
    header[6] = 0x01;
    header[7] = 0x00; /* 65537 */
    f_dec_init(&d);
    f_dec_push(&d, header, F_HEADER);
    ok(f_dec_next(&d, &out) == 0, "oversize length rejected");
    ok(d.dropped > 0, "and dropped rather than buffered");
  }

  /* Byte-at-a-time delivery, the way a UART actually arrives. */
  f_dec_init(&d);
  for (i = 0; i < wlen; i++) {
    f_dec_push(&d, wire + i, 1);
    if (i < wlen - 1) ok(f_dec_next(&d, &out) == 0 || i == wlen - 1, "no early frame");
  }
  ok(f_dec_next(&d, &out) == 1, "reassembled byte by byte");

  /* Two frames in one push. */
  memcpy(junkwire, wire, wlen);
  memcpy(junkwire + wlen, wire, wlen);
  f_dec_init(&d);
  f_dec_push(&d, junkwire, wlen * 2);
  ok(f_dec_next(&d, &out) == 1, "first of two");
  ok(f_dec_next(&d, &out) == 1, "second of two");
  ok(f_dec_next(&d, &out) == 0, "and no third");

  /* A maximum-size payload, filled with sync words to be awkward. */
  {
    static u8 big[F_MAX_PAYLOAD];
    static u8 bigwire[F_MAX_FRAME];
    int n;
    memset(big, 0x39, sizeof big);
    n = f_encode(F_PAYLOAD_DATA, big, F_MAX_PAYLOAD, bigwire, sizeof bigwire);
    ok(n == F_MAX_FRAME, "max payload encodes");
    f_dec_init(&d);
    f_dec_push(&d, bigwire, n);
    ok(f_dec_next(&d, &out) == 1, "max payload decodes");
    ok(out.len == F_MAX_PAYLOAD, "with the full length");
    ok(f_encode(F_PAYLOAD_DATA, big, F_MAX_PAYLOAD + 1, bigwire, sizeof bigwire) == -1,
       "oversize refused by the encoder");
  }
}

/* A single read can carry more than the buffer holds. The decoder must accept what fits,
 * say how much it took, and lose nothing — the first version silently discarded the
 * overflow, which ate whole frames and was caught by the cross-language golden test. */
static void test_push_more_than_fits(void) {
  static u8 wire[F_MAX_FRAME * 3];
  static f_decoder d;
  u8 payload[64];
  f_builder b;
  f_frame out;
  int plen, one, total = 0, seen = 0, left, i;
  const u8 *p;

  printf("oversized pushes\n");
  f_build_init(&b, payload, sizeof payload);
  f_add_str(&b, "e1");
  f_add_str(&b, "win");
  plen = f_build_len(&b);
  one = f_encode(F_EVENT, payload, plen, wire, sizeof wire);
  for (i = 1; i < 40; i++) {
    f_encode(F_EVENT, payload, plen, wire + i * one, (int)sizeof wire - i * one);
  }
  total = one * 40;

  f_dec_init(&d);
  p = wire;
  left = total;
  while (left > 0) {
    int took = f_dec_push(&d, p, left);
    ok(took > 0, "push always makes progress");
    if (took <= 0) break;
    p += took;
    left -= took;
    while (f_dec_next(&d, &out)) seen++;
  }
  eq_int(seen, 40, "every frame survives a stream larger than the buffer");
  eq_int((long)d.dropped, 0, "and nothing is dropped doing it");

  /* One enormous push of pure garbage must not wedge: it is dropped and the decoder
   * recovers on the next real frame. */
  f_dec_init(&d);
  for (i = 0; i < (int)sizeof wire; i++) wire[i] = 0x39;
  p = wire;
  left = (int)sizeof wire;
  while (left > 0) {
    int took = f_dec_push(&d, p, left);
    if (took <= 0) break;
    p += took;
    left -= took;
    while (f_dec_next(&d, &out)) seen++;
  }
  ok(d.dropped > 0, "garbage is dropped rather than buffered forever");
  f_dec_push(&d, wire, 0);
  {
    int n = f_encode(F_EVENT, payload, plen, wire, sizeof wire);
    f_dec_init(&d);
    f_dec_push(&d, wire, n);
    ok(f_dec_next(&d, &out) == 1, "and a real frame still decodes afterwards");
  }
}

static void test_fields(void) {
  f_field fields[F_MAX_FIELDS];
  u8 buf[64];
  u32 v;

  printf("fields\n");
  /* Malformed lists decode to -1 rather than a guess. */
  {
    u8 bad1[] = {3, 0, 0};       /* claims 3 fields, has 1 */
    u8 bad2[] = {1, 10, 0, 1, 2}; /* length past the end */
    u8 bad3[] = {1, 1, 0, 65, 66}; /* trailing byte */
    ok(f_fields(bad1, sizeof bad1, fields, F_MAX_FIELDS) == -1, "short list");
    ok(f_fields(bad2, sizeof bad2, fields, F_MAX_FIELDS) == -1, "length past end");
    ok(f_fields(bad3, sizeof bad3, fields, F_MAX_FIELDS) == -1, "trailing byte");
    ok(f_fields(bad1, 0, fields, F_MAX_FIELDS) == -1, "empty");
  }

  /* Integers are decimal or nothing. */
  {
    f_builder b;
    int n, count;
    f_build_init(&b, buf, sizeof buf);
    f_add_uint(&b, 0);
    f_add_uint(&b, 4294967295UL);
    f_add_str(&b, "12a");
    f_add_str(&b, "");
    n = f_build_len(&b);
    count = f_fields(buf, n, fields, F_MAX_FIELDS);
    eq_int(count, 4, "four fields");
    ok(f_field_uint(&fields[0], &v) && v == 0, "zero");
    ok(f_field_uint(&fields[1], &v) && v == 4294967295UL, "u32 max");
    ok(!f_field_uint(&fields[2], &v), "not a number");
    ok(!f_field_uint(&fields[3], &v), "empty is not a number");
  }

  /* Truncating copy always terminates. */
  {
    f_builder b;
    char small[4];
    int n;
    f_build_init(&b, buf, sizeof buf);
    f_add_str(&b, "EDITPLUS.EXE");
    n = f_build_len(&b);
    f_fields(buf, n, fields, F_MAX_FIELDS);
    f_field_str(&fields[0], small, sizeof small);
    ok(strcmp(small, "EDI") == 0, "truncated and terminated");
    ok(f_field_eq(&fields[0], "EDITPLUS.EXE"), "compare equal");
    ok(!f_field_eq(&fields[0], "EDITPLUS"), "prefix is not equal");
    ok(!f_field_eq(&fields[0], "EDITPLUS.EXE!"), "longer is not equal");
  }

  /* A builder that overflows stays failed rather than writing a short frame. */
  {
    f_builder b;
    u8 tiny[8];
    f_build_init(&b, tiny, sizeof tiny);
    f_add_str(&b, "abc");
    f_add_str(&b, "this will not fit");
    ok(f_build_len(&b) == -1, "overflow is reported once at the end");
  }
}

int main(void) {
  test_crc();
  test_roundtrip();
  test_decode_hazards();
  test_push_more_than_fits();
  test_fields();
  printf("%s: %d checks, %d failures\n", failures ? "FAIL" : "ok", checks, failures);
  return failures ? 1 : 0;
}
