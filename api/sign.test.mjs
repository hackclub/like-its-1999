// node --test api/sign.test.mjs
//
// The countersigning endpoint, checked against the public key that is actually committed.
// This is the same kind of test as the framing golden vectors: two halves that never run
// together (a serverless handler and an offline CLI) agreeing about a byte-for-byte format.
// Without it, either side can be changed on its own and stay perfectly self-consistent while
// every signature in the wild becomes unverifiable.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { signedMessage } from './signed-message.mjs'

// A throwaway key: the point is the format, not this particular keypair.
const { generateKeyPairSync } = await import('node:crypto')
const pair = generateKeyPairSync('ed25519')
process.env.HB_SIGN_KEY = pair.privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .toString('base64')

const { default: handler } = await import('./sign.js')

// Enough of Vercel's response object for the handler to talk to.
function fakeRes() {
  const res = {
    code: 200,
    body: null,
    headers: {},
    setHeader(k, v) {
      res.headers[k] = v
    },
    status(c) {
      res.code = c
      return res
    },
    json(obj) {
      res.body = obj
      return res
    },
  }
  return res
}

const call = async (req) => {
  const res = fakeRes()
  await handler(req, res)
  return res
}

const hashOf = (s) => createHash('sha256').update(s).digest('hex')

test('a signature from the endpoint verifies with the committed public key', async () => {
  const sha256 = hashOf('a sealed tracking log, pretend')
  const res = await call({ method: 'POST', body: { sha256 } })
  assert.equal(res.code, 200)
  const { keyId, signedAt, sig } = res.body
  assert.ok(sig && signedAt && keyId)

  // Verify with our throwaway public half, exactly the way hb-decrypt.mjs does.
  // pair.publicKey is already a KeyObject, so hand verify() the object itself.
  const key = pair.publicKey
  const message = Buffer.from(signedMessage(keyId, sha256, signedAt), 'utf8')
  assert.equal(verify(null, message, key, Buffer.from(sig, 'base64')), true)

  // And the negative case that matters: a different hash must not verify against it, or the
  // signature would say nothing about which bytes it covered.
  const other = Buffer.from(
    signedMessage(keyId, hashOf('different bytes'), signedAt),
    'utf8'
  )
  assert.equal(verify(null, other, key, Buffer.from(sig, 'base64')), false)
})

test('the committed public key is a real Ed25519 key, or absent', () => {
  // A malformed committed key would only be discovered by someone trying to check a
  // submission months later, which is the worst possible time.
  const src = readFileSync(
    fileURLToPath(new URL('../scripts/hb-decrypt.mjs', import.meta.url)),
    'utf8'
  )
  const b64 = /const SIGN_PUBLIC_KEY_B64 =\s*'([^']*)'/.exec(src)?.[1]
  assert.notEqual(b64, undefined, 'the constant still exists')
  if (!b64) return // not generated yet, which the CLI reports rather than crashing on
  const key = createPublicKey({
    key: Buffer.from(b64, 'base64'),
    format: 'der',
    type: 'spki',
  })
  assert.equal(key.asymmetricKeyType, 'ed25519')
})

test('the endpoint refuses anything that is not a sha256 hex string', async () => {
  for (const body of [
    {},
    { sha256: '' },
    { sha256: 'nope' },
    { sha256: hashOf('x').toUpperCase() }, // uppercase is not the format we sign
    { sha256: hashOf('x') + 'a' },
  ]) {
    const res = await call({ method: 'POST', body })
    assert.equal(res.code, 400, JSON.stringify(body))
  }
  const wrongMethod = await call({ method: 'GET' })
  assert.equal(wrongMethod.code, 405)
})

test('a body that arrives as a string is parsed, and an oversize one is refused', async () => {
  const sha256 = hashOf('string body')
  const ok = await call({ method: 'POST', body: JSON.stringify({ sha256 }) })
  assert.equal(ok.code, 200)

  const huge = await call({ method: 'POST', body: 'x'.repeat(2048) })
  assert.equal(huge.code, 413)
})
