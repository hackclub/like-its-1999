/* Cross-language golden vectors: the C half.
 *
 * Reads a file of frames produced by frame.js, decodes every one, re-encodes it from the
 * decoded type and fields, and writes the result back out. A Node test then decodes that
 * output and compares it to the table it started from.
 *
 * If the two implementations disagree anywhere — CRC, field lengths, header layout,
 * integer encoding — the bytes come back different and the test fails. Two independent
 * implementations of a wire format silently drifting apart is the likeliest bug in this
 * phase, and this is the only thing that actually pins them together.
 *
 *   test_golden <in.bin> <out.bin>
 *
 * Host-only: uses stdio, which the guest build never links.
 */
#include <stdio.h>

#include "frame.h"

static u8 input[1 << 20];
static u8 output[1 << 20];
static u8 payload[F_MAX_PAYLOAD];

int main(int argc, char **argv) {
  FILE *f;
  static f_decoder d;
  f_frame frame;
  int in_len = 0, out_len = 0, frames = 0;

  if (argc < 3) {
    fprintf(stderr, "usage: test_golden <in.bin> <out.bin>\n");
    return 2;
  }

  f = fopen(argv[1], "rb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }
  in_len = (int)fread(input, 1, sizeof input, f);
  fclose(f);

  f_dec_init(&d);

  /* Push and drain in a loop: the decoder holds one frame at most, and this fixture is
   * deliberately larger than that. */
  {
    const u8 *p = input;
    int left = in_len;
    while (left > 0) {
      int took = f_dec_push(&d, p, left);
      p += took;
      left -= took;

      while (f_dec_next(&d, &frame)) {
        f_field fields[F_MAX_FIELDS];
        f_builder b;
        int count, i, plen, wlen;

        count = f_fields(frame.payload, frame.len, fields, F_MAX_FIELDS);
        if (count < 0) {
          fprintf(stderr, "frame %d: payload is not a field list\n", frames);
          return 1;
        }

        /* Re-encode from what we decoded, not from the original bytes. */
        f_build_init(&b, payload, sizeof payload);
        for (i = 0; i < count; i++) f_add_bytes(&b, fields[i].p, fields[i].len);
        plen = f_build_len(&b);
        if (plen < 0) {
          fprintf(stderr, "frame %d: rebuild overflowed\n", frames);
          return 1;
        }

        wlen = f_encode(frame.type, payload, plen, output + out_len,
                        (int)sizeof output - out_len);
        if (wlen < 0) {
          fprintf(stderr, "frame %d: re-encode failed\n", frames);
          return 1;
        }
        out_len += wlen;
        frames++;
      }
    }
  }

  if (d.dropped != 0) {
    fprintf(stderr, "dropped %lu bytes resyncing: the fixture should be clean\n",
            (unsigned long)d.dropped);
    return 1;
  }

  f = fopen(argv[2], "wb");
  if (!f) {
    fprintf(stderr, "cannot write %s\n", argv[2]);
    return 2;
  }
  fwrite(output, 1, (size_t)out_len, f);
  fclose(f);

  fprintf(stderr, "round tripped %d frames, %d -> %d bytes\n", frames, in_len, out_len);
  return 0;
}
