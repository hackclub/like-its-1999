// POST /api/sign  { sha256 }  ->  { keyId, signedAt, sig }
//
// **This is a timestamp oracle and nothing more, deliberately.** It signs whatever hash it
// is handed, with no identity and no state, so the only thing a signature proves is that
// somebody asked for one at that time. Read it as "these exact bytes existed by T".
//
// It is worth keeping for one narrow reason: backdating is the one thing a self-reported log
// cannot rule out by itself, and this rules it out. Everything else it might look like it
// provides, it does not:
//
//   - it does not prove who produced the bytes: anyone can call it
//   - it does not prove the log is true: a fabricated log signs just as well
//   - it does not prove nothing was left out: omission and rollback are invisible, since a
//     participant may save with the tracking chunk stripped or re-save an older signed one
//
// Closing any of those needs per-session server state and an identity, which is a different
// product decision and was consciously not made here (2026-08-03). Do not describe this as
// authentication anywhere, and do not build verification code that implies it.
//
// Vercel picks this up from `api/` with no configuration. The private key lives in an
// environment variable scoped to production, so preview deployments cannot sign with it.

import { createPrivateKey, sign as nodeSign } from 'node:crypto'

import { signedMessage } from './signed-message.mjs'

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
  const message = Buffer.from(signedMessage(KEY_ID, sha256, signedAt), 'utf8')
  const sig = nodeSign(null, message, key).toString('base64')

  return res.status(200).json({ keyId: KEY_ID, signedAt, sig })
}
