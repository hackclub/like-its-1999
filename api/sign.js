// POST /api/sign  { sha256 }  ->  { keyId, signedAt, sig }
//
// Countersigns a hash with a server-held Ed25519 key, so a tracking blob carries a trusted
// timestamp: "these exact bytes existed at time T". Deliberately stateless and forgetful —
// it stores nothing and needs no identity, which is why it needs no database and no auth.
//
// What it buys: an edit to a blob that is kept becomes detectable, because the signature
// will not match the edited bytes. What it does not buy, and this was an accepted trade:
// **omission and rollback are invisible.** Someone can save with the tracking chunk
// stripped, or re-save an older signed blob, and nothing here would know. Closing that
// needs per-session state on the server, which we chose not to build.
//
// Vercel picks this up from `api/` with no configuration. The private key lives in an
// environment variable scoped to production, so preview deployments cannot sign with it.

import { createPrivateKey, sign as nodeSign } from 'node:crypto'

const KEY_ID = process.env.HB_SIGN_KEY_ID || 'hb1'
const MAX_BODY = 1024

let cachedKey = null
function signingKey() {
  if (cachedKey) return cachedKey
  const b64 = process.env.HB_SIGN_KEY
  if (!b64) throw new Error('HB_SIGN_KEY is not configured')
  cachedKey = createPrivateKey({
    key: Buffer.from(b64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  return cachedKey
}

const isSha256Hex = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  let body = req.body
  if (typeof body === 'string') {
    if (body.length > MAX_BODY)
      return res.status(413).json({ error: 'body too large' })
    try {
      body = JSON.parse(body)
    } catch {
      return res.status(400).json({ error: 'body is not JSON' })
    }
  }

  const sha256 = body?.sha256
  if (!isSha256Hex(sha256))
    return res
      .status(400)
      .json({ error: 'sha256 must be 64 lowercase hex characters' })

  let key
  try {
    key = signingKey()
  } catch (e) {
    // A missing key is a deployment problem, not a client one, and must not look like a
    // valid unsigned response.
    console.error('sign: ', e.message)
    return res.status(503).json({ error: 'signing is unavailable' })
  }

  // The server's own clock is the point of the exercise: a client-supplied time would be
  // worth nothing.
  const signedAt = Date.now()
  const message = Buffer.from(`${KEY_ID}|${sha256}|${signedAt}`, 'utf8')
  const sig = nodeSign(null, message, key).toString('base64')

  return res.status(200).json({ keyId: KEY_ID, signedAt, sig })
}
