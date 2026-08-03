#include "frame.h"

/* Local copies rather than <string.h>: this compiles freestanding with no CRT, and the
 * Win32 build has no memcpy to link against beyond the one we supply ourselves. */
static void copy(u8 *dst, const u8 *src, int n) {
  int i;
  for (i = 0; i < n; i++) dst[i] = src[i];
}

static void move_down(u8 *buf, int from, int n) {
  int i;
  for (i = 0; i < n; i++) buf[i] = buf[from + i];
}

/* --- CRC-32 (IEEE, the zlib polynomial) ----------------------------------------- */
/* Computed on the fly rather than from a 1 KB table: the frames are small, the parent
 * is size-constrained, and this is not on any hot path. */
u32 f_crc32(const u8 *b, int len) {
  u32 c = 0xffffffffUL;
  int i, k;
  for (i = 0; i < len; i++) {
    c ^= (u32)b[i];
    for (k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320UL ^ (c >> 1)) : (c >> 1);
  }
  return c ^ 0xffffffffUL;
}

static u32 rd32(const u8 *p) {
  return (u32)p[0] | ((u32)p[1] << 8) | ((u32)p[2] << 16) | ((u32)p[3] << 24);
}

static void wr32(u8 *p, u32 v) {
  p[0] = (u8)(v & 0xff);
  p[1] = (u8)((v >> 8) & 0xff);
  p[2] = (u8)((v >> 16) & 0xff);
  p[3] = (u8)((v >> 24) & 0xff);
}

/* --- decoding -------------------------------------------------------------------- */

void f_dec_init(f_decoder *d) {
  d->len = 0;
  d->start = 0;
  d->dropped = 0;
}


static void compact(f_decoder *d) {
  if (d->start == 0) return;
  move_down(d->buf, d->start, d->len - d->start);
  d->len -= d->start;
  d->start = 0;
}

int f_dec_push(f_decoder *d, const u8 *b, int n) {
  int room;
  if (n <= 0) return 0;
  compact(d);
  /* Full, and the caller has already drained everything extractable, so what is here
   * cannot become a frame: it is garbage that happens to start with a sync word. Drop it
   * rather than wedge, and the stream resynchronises on the next real frame. */
  if (d->len >= F_MAX_FRAME) {
    d->dropped += (u32)d->len;
    d->len = 0;
  }
  room = F_MAX_FRAME - d->len;
  if (n > room) n = room;
  copy(d->buf + d->len, b, n);
  d->len += n;
  return n;
}

int f_dec_next(f_decoder *d, f_frame *out) {
  /* Where an incomplete-but-plausible candidate began, so that waiting for it can be
   * unwound if something later turns out to be a real frame. -1 means none seen. */
  int stalled = -1;
  u32 stalled_dropped = 0;

  compact(d);
  for (;;) {
    int avail = d->len - d->start;
    const u8 *p;
    u8 type, flags;
    u32 len, want, got;
    int total;

    if (avail < F_HEADER) break;
    p = d->buf + d->start;

    if (p[0] != F_SYNC0 || p[1] != F_SYNC1) {
      d->start++;
      d->dropped++;
      continue;
    }
    type = p[2];
    flags = p[3];
    len = rd32(p + 4);

    /* Reject before waiting for bytes: a corrupt length must not make us block. Flags are
     * all reserved, so any set bit means a frame from a future we do not understand. */
    if (type == 0 || flags != 0 || len > (u32)F_MAX_PAYLOAD) {
      d->start++;
      d->dropped++;
      continue;
    }
    total = F_HEADER + (int)len + F_TRAILER;
    if (avail < total) {
      /* Incomplete, and possibly not a frame at all. A restored snapshot can leave a stale
       * header in the UART claiming 64 KB, and waiting for it would swallow every frame
       * behind it until that much traffic had arrived — on a link that is idle except for
       * an announce every couple of seconds, that is minutes of being deaf. Keep looking
       * past it, and only come back to it if nothing later proves to be real. */
      if (stalled < 0) {
        stalled = d->start;
        stalled_dropped = d->dropped;
      }
      d->start++;
      d->dropped++;
      continue;
    }

    want = rd32(p + F_HEADER + (int)len);
    got = f_crc32(p + 2, F_HEADER - 2 + (int)len);
    if (want != got) {
      d->start++;
      d->dropped++;
      continue;
    }

    out->type = type;
    out->payload = p + F_HEADER;
    out->len = (int)len;
    d->start += total;
    return 1; /* a real frame: the stalled candidate, if any, was noise */
  }
  if (stalled >= 0) {
    d->start = stalled;
    d->dropped = stalled_dropped;
  }
  return 0;
}

/* --- fields ---------------------------------------------------------------------- */

int f_fields(const u8 *payload, int len, f_field *out, int max) {
  int count, at, i, kept = 0;
  if (len < 1) return -1;
  count = payload[0];
  at = 1;
  for (i = 0; i < count; i++) {
    int flen;
    if (at + 2 > len) return -1;
    flen = (int)payload[at] | ((int)payload[at + 1] << 8);
    at += 2;
    if (at + flen > len) return -1;
    if (kept < max) {
      out[kept].p = payload + at;
      out[kept].len = flen;
      kept++;
    }
    at += flen;
  }
  /* Trailing bytes mean we misread the structure. */
  if (at != len) return -1;
  return kept;
}

int f_field_eq(const f_field *f, const char *s) {
  int i;
  for (i = 0; i < f->len; i++) {
    if (s[i] == 0 || (u8)s[i] != f->p[i]) return 0;
  }
  return s[f->len] == 0;
}

void f_field_str(const f_field *f, char *out, int cap) {
  int n = f->len, i;
  if (cap <= 0) return;
  if (n > cap - 1) n = cap - 1;
  for (i = 0; i < n; i++) out[i] = (char)f->p[i];
  out[n] = 0;
}

int f_field_uint(const f_field *f, u32 *out) {
  u32 v = 0;
  int i;
  if (f->len < 1 || f->len > 10) return 0;
  for (i = 0; i < f->len; i++) {
    u8 c = f->p[i];
    if (c < '0' || c > '9') return 0;
    /* Both halves matter. The multiply overflows above 429496729, and at exactly that
     * value it depends on the digit: 4294967296 wrapped to 0 and was accepted as a
     * perfectly good zero, which is the worst possible way to fail a length check. */
    if (v > 429496729UL || (v == 429496729UL && c > '5')) return 0;
    v = v * 10 + (u32)(c - '0');
  }
  *out = v;
  return 1;
}

/* --- encoding -------------------------------------------------------------------- */

void f_build_init(f_builder *b, u8 *buf, int cap) {
  b->buf = buf;
  b->cap = cap;
  b->len = 1; /* room for the count byte */
  b->count = 0;
  b->failed = cap < 1;
}

void f_add_bytes(f_builder *b, const void *p, int len) {
  const u8 *src = (const u8 *)p;
  if (b->failed) return;
  if (len < 0 || len > 0xffff || b->count >= 255 || b->len + 2 + len > b->cap) {
    b->failed = 1;
    return;
  }
  b->buf[b->len] = (u8)(len & 0xff);
  b->buf[b->len + 1] = (u8)((len >> 8) & 0xff);
  copy(b->buf + b->len + 2, src, len);
  b->len += 2 + len;
  b->count++;
}

void f_add_str(f_builder *b, const char *s) {
  int n = 0;
  while (s && s[n]) n++;
  f_add_bytes(b, s, n);
}

void f_add_uint(f_builder *b, u32 v) {
  char tmp[11];
  int i = 11;
  if (v == 0) {
    f_add_bytes(b, "0", 1);
    return;
  }
  while (v > 0 && i > 0) {
    tmp[--i] = (char)('0' + (v % 10));
    v /= 10;
  }
  f_add_bytes(b, tmp + i, 11 - i);
}

int f_build_len(f_builder *b) {
  if (b->failed) return -1;
  b->buf[0] = (u8)b->count;
  return b->len;
}

int f_encode(u8 type, const u8 *payload, int len, u8 *out, int cap) {
  int total = F_HEADER + len + F_TRAILER;
  if (len < 0 || len > F_MAX_PAYLOAD || total > cap) return -1;
  out[0] = F_SYNC0;
  out[1] = F_SYNC1;
  out[2] = type;
  out[3] = 0;
  wr32(out + 4, (u32)len);
  copy(out + F_HEADER, payload, len);
  /* Covers everything but the sync word, which is a marker rather than data. */
  wr32(out + F_HEADER + len, f_crc32(out + 2, F_HEADER - 2 + len));
  return total;
}
