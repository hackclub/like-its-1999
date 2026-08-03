// node --test emulator/daemon/sealed.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  seal,
  unseal,
  generateKeyPair,
  importPublicKey,
  importPrivateKey,
  ALG,
} from './sealed.js'

const te = new TextEncoder()
const td = new TextDecoder()
const LOG = te.encode(
  '{"ev":"win","t":1,"exe":"EDITPLUS.EXE","win":"C:\\\\secret\\\\diary.html - EditPlus"}\n'
)

const keys = async () => {
  const { publicKey, privateKey } = await generateKeyPair()
  return {
    pub: await importPublicKey(publicKey),
    priv: await importPrivateKey(privateKey),
    publicKey,
    privateKey,
  }
}

test('a sealed log round trips', async () => {
  const { pub, priv } = await keys()
  const sealed = await seal(LOG, pub)
  assert.equal(sealed.header.alg, ALG)
  assert.ok(sealed.header.epk && sealed.header.iv)
  assert.deepEqual(await unseal(sealed, priv), LOG)
})

test('the ciphertext does not contain the plaintext', async () => {
  const { pub } = await keys()
  const { body } = await seal(LOG, pub)
  assert.ok(!td.decode(body).includes('diary.html'))
  assert.ok(!td.decode(body).includes('EDITPLUS'))
})

test('every seal derives a different key, so nothing is reused', async () => {
  const { pub, priv } = await keys()
  const a = await seal(LOG, pub)
  const b = await seal(LOG, pub)
  assert.notEqual(a.header.epk, b.header.epk, 'fresh ephemeral key each time')
  assert.notEqual(a.header.iv, b.header.iv)
  assert.notDeepEqual(a.body, b.body, 'identical input, different ciphertext')
  // Both still open.
  assert.deepEqual(await unseal(a, priv), LOG)
  assert.deepEqual(await unseal(b, priv), LOG)
})

test('the wrong private key fails loudly', async () => {
  const { pub } = await keys()
  const other = await keys()
  const sealed = await seal(LOG, pub)
  await assert.rejects(() => unseal(sealed, other.priv))
})

test('a flipped ciphertext byte fails rather than returning garbage', async () => {
  const { pub, priv } = await keys()
  const sealed = await seal(LOG, pub)
  sealed.body[Math.floor(sealed.body.length / 2)] ^= 0x01
  await assert.rejects(() => unseal(sealed, priv), 'AES-GCM authenticates')
})

test('a tampered IV or ephemeral key fails too', async () => {
  const { pub, priv } = await keys()
  const bad = await seal(LOG, pub)
  const ivBytes = Uint8Array.from(atob(bad.header.iv), (c) => c.charCodeAt(0))
  ivBytes[0] ^= 0xff
  await assert.rejects(() =>
    unseal(
      {
        ...bad,
        header: { ...bad.header, iv: btoa(String.fromCharCode(...ivBytes)) },
      },
      priv
    )
  )

  const other = await keys()
  const swapped = await seal(LOG, other.pub)
  await assert.rejects(() =>
    unseal({ ...bad, header: { ...bad.header, epk: swapped.header.epk } }, priv)
  )
})

test('an unknown algorithm is refused rather than guessed at', async () => {
  const { pub, priv } = await keys()
  const sealed = await seal(LOG, pub)
  await assert.rejects(
    () =>
      unseal({ ...sealed, header: { ...sealed.header, alg: 'rot13' } }, priv),
    /unknown seal algorithm/
  )
})

test('an empty log seals and opens', async () => {
  const { pub, priv } = await keys()
  const sealed = await seal(new Uint8Array(0), pub)
  assert.deepEqual(await unseal(sealed, priv), new Uint8Array(0))
})

test('a large log seals and opens intact', async () => {
  const { pub, priv } = await keys()
  const big = te.encode('{"ev":"active","t":1,"keys":3}\n'.repeat(20000))
  const sealed = await seal(big, pub)
  assert.deepEqual(await unseal(sealed, priv), big)
})

test('exported keys survive a trip through text', async () => {
  const { publicKey, privateKey } = await generateKeyPair()
  assert.match(publicKey, /^[A-Za-z0-9+/]+=*$/)
  const sealed = await seal(LOG, await importPublicKey(publicKey))
  assert.deepEqual(
    await unseal(sealed, await importPrivateKey(privateKey)),
    LOG
  )
})
