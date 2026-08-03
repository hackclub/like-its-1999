/* Wire framing, the C half. The normative description is ../PROTOCOL.md and the other
 * implementation is ../frame.js; the two are pinned together by golden vectors
 * (fixtures/frames.bin) rather than by hope.
 *
 * Constraints this file lives under, because it runs in the parent, which must never
 * crash: no allocation, no CRT, no recursion, every buffer fixed and every length
 * checked. Nothing here can fail in a way a later valid frame cannot recover from.
 */
#ifndef DAEMON_FRAME_H
#define DAEMON_FRAME_H

#define F_SYNC0 0x39
#define F_SYNC1 0x39
#define F_HEADER 8  /* sync(2) type(1) flags(1) len(4) */
#define F_TRAILER 4 /* crc32 */
#define F_MAX_PAYLOAD 65536
#define F_MAX_FRAME (F_HEADER + F_MAX_PAYLOAD + F_TRAILER)

/* Frozen range: everything the parent implements. 0x20+ belongs to the child. */
#define F_RESET 0x01
#define F_ANNOUNCE 0x02
#define F_IDENT 0x03
#define F_PAYLOAD_BEGIN 0x04
#define F_PAYLOAD_DATA 0x05
#define F_PAYLOAD_END 0x06
#define F_STATUS 0x07
#define F_PING 0x08
#define F_PONG 0x09
#define F_FROZEN_MAX 0x1f
#define F_CALL 0x20
#define F_REPLY 0x21
#define F_EVENT 0x22

#define F_MAX_FIELDS 16 /* more than any message we define; extras are ignored */

typedef unsigned char u8;
typedef unsigned short u16;
/* `unsigned int`, not `unsigned long`: long is 32 bits under mingw but 64 on a LP64 host,
 * and the whole point of building this for both is that the arithmetic matches. It did
 * not, once: the child stamped a 64-bit millisecond count into an 11-byte buffer, the
 * truncated value read back as an enormous age, and the parent killed a healthy child
 * every couple of hundred milliseconds. `unsigned int` is 32 bits on both targets. */
typedef unsigned int u32;

typedef struct {
  const u8 *p;
  int len;
} f_field;

typedef struct {
  u8 type;
  const u8 *payload; /* points into the decoder's buffer, valid until the next call */
  int len;
} f_frame;

u32 f_crc32(const u8 *b, int len);

/* --- decoding ------------------------------------------------------------------ */

typedef struct {
  u8 buf[F_MAX_FRAME];
  int len;   /* bytes held */
  int start; /* consumed prefix, compacted lazily */
  u32 dropped;
} f_decoder;

void f_dec_init(f_decoder *d);
void f_dec_reset(f_decoder *d);

/* Append bytes, returning how many were accepted, which may be fewer than offered: the
 * buffer holds one maximum frame and no more. Callers MUST loop, draining frames between
 * pushes, because a single read can easily carry more than one frame:
 *
 *   while (n > 0) {
 *     int took = f_dec_push(&d, p, n);
 *     p += took; n -= took;
 *     while (f_dec_next(&d, &frame)) handle(&frame);
 *   }
 *
 * Progress is always possible: if the buffer is full and yielded nothing, it cannot
 * contain a frame, so it is dropped and counted. (The JS decoder grows an array instead
 * and hides this; the C cannot, so the API says it out loud.) */
int f_dec_push(f_decoder *d, const u8 *b, int n);
/* Extract the next whole frame. Returns 1 and fills `out`, or 0 when more bytes are
 * needed. `out->payload` is invalidated by the following push or next call. */
int f_dec_next(f_decoder *d, f_frame *out);

/* Split a payload into fields. Returns the count, or -1 if it is not a well-formed
 * field list (which means: drop the frame, never guess). */
int f_fields(const u8 *payload, int len, f_field *out, int max);

/* Field helpers. Comparisons and parsing are total: no errno, no locale, no CRT. */
int f_field_eq(const f_field *f, const char *s);
/* Copies at most cap-1 bytes and always terminates. */
void f_field_str(const f_field *f, char *out, int cap);
/* Decimal only. Returns 0 and leaves *out untouched if it is not a clean integer. */
int f_field_uint(const f_field *f, u32 *out);

/* --- encoding ------------------------------------------------------------------ */

/* Builds a field-list payload into a caller-supplied buffer. Every add is bounds
 * checked; once one overflows the builder stays failed and f_build_len returns -1,
 * so a caller can check once at the end rather than after every field. */
typedef struct {
  u8 *buf;
  int cap;
  int len;
  int count;
  int failed;
} f_builder;

void f_build_init(f_builder *b, u8 *buf, int cap);
void f_add_bytes(f_builder *b, const void *p, int len);
void f_add_str(f_builder *b, const char *s);
void f_add_uint(f_builder *b, u32 v);
int f_build_len(f_builder *b); /* -1 if anything overflowed */

/* Writes sync+header+payload+crc into `out`. Returns the byte count, or -1. */
int f_encode(u8 type, const u8 *payload, int len, u8 *out, int cap);

#endif
