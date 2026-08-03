// Sealing the tracking log so a published save doesn't publish what someone was doing.
//
// A share link already boots the participant's whole filesystem, so this is not protecting
// them from us — it keeps window titles (file names, paths, whatever a program puts in its
// title bar) out of a public artifact that anyone can download.
//
// The construction is the smallest thing that gives "only the holder of one private key
// can read this":
//
//   ephemeral P-256 keypair, fresh per seal
//   ECDH against the recipient public key  ->  AES-256-GCM key
//   encrypt, and record the ephemeral public key + IV alongside
//
// One recipient, so there is no content key and no wrapping step: the derived key *is* the
// key. What makes that safe is the ephemeral pair being new every time, so no key is ever
// used twice. There is one operational consequence and it is not small: **lose the private
// key and every tracking record ever written is unreadable forever.** It needs a real
// offline backup.

export const ALG = 'ECIES-P256-AES256GCM'
const CURVE = { name: 'ECDH', namedCurve: 'P-256' }

const subtle = () => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto is unavailable')
  return s
}

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

// Keys travel as base64 SPKI/PKCS8, which is what `generateKeyPair` below prints and what
// the page and the CLI both read.
export async function importPublicKey(spkiB64) {
  return subtle().importKey('spki', unb64(spkiB64), CURVE, false, [])
}

export async function importPrivateKey(pkcs8B64) {
  return subtle().importKey('pkcs8', unb64(pkcs8B64), CURVE, false, [
    'deriveKey',
  ])
}

// Prints a keypair for `.env` / the page. Run it once, back up the private half, and never
// put the private half on a server: only the offline decrypt CLI needs it.
export async function generateKeyPair() {
  const pair = await subtle().generateKey(CURVE, true, ['deriveKey'])
  const [spki, pkcs8] = await Promise.all([
    subtle().exportKey('spki', pair.publicKey),
    subtle().exportKey('pkcs8', pair.privateKey),
  ])
  return { publicKey: b64(spki), privateKey: b64(pkcs8) }
}

const deriveAesKey = (privateKey, publicKey, usage) =>
  subtle().deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  )

// Encrypt `bytes` to `recipientPublicKey`. Returns `{ seal, body }`: `seal` is the public
// part that belongs in the chunk's metadata (it is not secret) and `body` is the ciphertext.
// The field is named for where it ends up, because the one time it was called `header` here
// and `seal` there, the two never met and every sealed chunk was written undecryptable.
export async function seal(bytes, recipientPublicKey, { keyId = 'hb1' } = {}) {
  const ephemeral = await subtle().generateKey(CURVE, true, ['deriveKey'])
  const key = await deriveAesKey(
    ephemeral.privateKey,
    recipientPublicKey,
    'encrypt'
  )
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes)
  const epk = await subtle().exportKey('spki', ephemeral.publicKey)
  return {
    seal: { alg: ALG, keyId, epk: b64(epk), iv: b64(iv) },
    body: new Uint8Array(ct),
  }
}

// Open a sealed body with the recipient private key. Throws on a wrong key or tampered
// bytes — AES-GCM authenticates, so this fails loudly rather than returning garbage, which
// is the property that makes the ciphertext worth hashing and signing.
export async function unseal({ seal: header, body }, recipientPrivateKey) {
  if (!header || header.alg !== ALG)
    throw new Error(`unknown seal algorithm ${header?.alg}`)
  const epk = await subtle().importKey(
    'spki',
    unb64(header.epk),
    CURVE,
    false,
    []
  )
  const key = await deriveAesKey(recipientPrivateKey, epk, 'decrypt')
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: unb64(header.iv) },
    key,
    body
  )
  return new Uint8Array(plain)
}

// The public key the page seals to. Committed rather than configured: it is public by
// definition, and a build that cannot find it should fail loudly rather than quietly
// writing readable logs.
export const RECIPIENT_PUBLIC_KEY_B64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2MCanU5X0yVhgfhXvyGiO4nHFRBlvyff08xN8+62rDCvly29h34jwBWZAP33gGw2RQ4KLXBws05IH+MQ7OuAQw=='

export const hasRecipientKey = () => RECIPIENT_PUBLIC_KEY_B64.length > 0
