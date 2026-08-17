/* wire framing, C half; ../PROTOCOL.md is normative and ../frame.js is the other
 * implementation, pinned to this one by the golden vectors in fixtures/frames.bin
 *
 * runs in the parent, so: no allocation, no CRT, no recursion, fixed buffers, every
 * length checked */
#ifndef DAEMON_FRAME_H
#define DAEMON_FRAME_H

#define F_SYNC0 0x39
#define F_SYNC1 0x39
#define F_HEADER 8  /* sync(2) type(1) flags(1) len(4) */
#define F_TRAILER 4 /* crc32 */
#define F_MAX_PAYLOAD 65536
#define F_MAX_FRAME (F_HEADER + F_MAX_PAYLOAD + F_TRAILER)

/* frozen range: what the parent implements; 0x20+ belongs to the child */
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
/* `unsigned int`, not `unsigned long`: long is 32 bits under mingw and 64 on an LP64
 * host, and the arithmetic has to match across both builds */
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

/* --- decoding --- */

typedef struct {
  u8 buf[F_MAX_FRAME];
  int len;   /* bytes held */
  int start; /* consumed prefix, compacted lazily */
  u32 dropped;
} f_decoder;

void f_dec_init(f_decoder *d);
/* no f_dec_reset: RESET clears protocol state and leaves the byte stream alone, since
 * the bytes still buffered arrived after it and framing resyncs on its own */

/* Appends bytes and returns how many were accepted, which may be fewer than offered: the
 * buffer holds one maximum frame. Callers must loop, draining frames between pushes,
 * because one read can carry several. Progress is always possible: a full buffer that
 * yielded nothing cannot contain a frame, so it is dropped and counted. */
int f_dec_push(f_decoder *d, const u8 *b, int n);
/* Returns 1 and fills `out`, or 0 when more bytes are needed. `out->payload` is
 * invalidated by the following push or next call. */
int f_dec_next(f_decoder *d, f_frame *out);

/* Splits a payload into fields. Returns the count, or -1 for a malformed field list,
 * which means drop the frame rather than guess. */
int f_fields(const u8 *payload, int len, f_field *out, int max);

/* comparisons and parsing are total: no errno, no locale, no CRT */
int f_field_eq(const f_field *f, const char *s);
/* copies at most cap-1 bytes and always terminates */
void f_field_str(const f_field *f, char *out, int cap);
/* decimal only; returns 0 and leaves *out untouched if it is not a clean integer */
int f_field_uint(const f_field *f, u32 *out);

/* --- encoding --- */

/* Builds a field-list payload into a caller-supplied buffer. Once an add overflows the
 * builder stays failed and f_build_len returns -1, so callers check once at the end. */
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

/* writes sync+header+payload+crc into `out`; returns the byte count, or -1 */
int f_encode(u8 type, const u8 *payload, int len, u8 *out, int cap);

#endif
