// The exact bytes a countersignature covers.
//
// One line of code, in its own file, because it is written on both sides of a boundary: the
// endpoint signs it and an offline CLI verifies it, and those two never run together. The
// last time a value was spelled one way by the producer and another by the consumer, every
// sealed log went to disk undecryptable and no test could see it, since each half was
// correct on its own.
//
// The key id is inside the message so a signature cannot be replayed as if it came from a
// different key, and the timestamp is inside it because the timestamp is the entire point.
export const signedMessage = (keyId, sha256Hex, signedAt) =>
  `${keyId || 'hb1'}|${sha256Hex}|${signedAt}`
