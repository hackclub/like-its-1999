// Generate the two keypairs the tracking data needs. Run once:
//
//   node scripts/hb-keys.mjs
//
// They do different jobs and must be handled differently:
//
//   sealing (ECDH P-256)  the page encrypts tracking logs to the PUBLIC half, which is
//                         committed in emulator/daemon/sealed.js. The PRIVATE half never
//                         goes near a server — only the offline decrypt CLI needs it.
//                         Lose it and every tracking record ever written is unreadable,
//                         so back it up somewhere that is not a laptop.
//
//   signing (Ed25519)     the PRIVATE half goes in the HB_SIGN_KEY environment variable
//                         on Vercel, scoped to production so preview deploys cannot sign.
//                         The PUBLIC half is committed so anyone can verify.

import { generateKeyPairSync } from 'node:crypto'
import { generateKeyPair } from '../emulator/daemon/sealed.js'

const sealing = await generateKeyPair()

const ed = generateKeyPairSync('ed25519')
const signing = {
  publicKey: ed.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64'),
  privateKey: ed.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64'),
}

console.log(`
SEALING (ECDH P-256)
--------------------
public  — commit this as RECIPIENT_PUBLIC_KEY_B64 in emulator/daemon/sealed.js
${sealing.publicKey}

private — OFFLINE ONLY. Password manager plus one copy elsewhere. Never on a server.
${sealing.privateKey}


SIGNING (Ed25519)
-----------------
public  — commit this as SIGN_PUBLIC_KEY_B64 in scripts/hb-decrypt.mjs
${signing.publicKey}

private — set as HB_SIGN_KEY on Vercel (production scope only)
${signing.privateKey}
`)
