import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'

// Serve `api/` locally, the way Vercel serves it in production.
//
// Without this, /api/sign simply does not exist under `npm run dev`: the tracking log gets
// sealed but never countersigned, every local save reads back as `unsigned`, and the one part
// of this path that talks to a server is the part nobody exercises until it is live. It runs
// the real handler with the real key (HB_SIGN_KEY in .env, the same key as production on
// purpose), so a signature made locally verifies against the public half committed in
// scripts/hb-decrypt.mjs.
//
// Dev only, and deliberately minimal: not a Vercel emulator, just enough of one to keep local
// and production on the same code path.
function apiRoutes(env) {
  return {
    name: 'local-api-routes',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || '').split('?')[0]
        if (!path.startsWith('/api/')) return next()

        // The handler reads its key from the environment, exactly as it does on Vercel.
        for (const [k, v] of Object.entries(env))
          if (k.startsWith('HB_') && !process.env[k]) process.env[k] = v

        let handler
        try {
          const mod = await server.ssrLoadModule(`.${path}.js`)
          handler = mod.default
        } catch {
          return next() // no such route: let the static server answer
        }

        const body = await new Promise((done) => {
          let raw = ''
          req.on('data', (c) => {
            raw += c
            if (raw.length > 64 * 1024) req.destroy()
          })
          req.on('end', () => done(raw))
        })

        // Enough of Vercel's response shape for these handlers, and no more.
        const shim = {
          setHeader: (k, v) => res.setHeader(k, v),
          status(code) {
            res.statusCode = code
            return shim
          },
          json(obj) {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(obj))
            return shim
          },
        }
        try {
          await handler(
            { method: req.method, headers: req.headers, body },
            shim
          )
        } catch (e) {
          server.config.logger.error(`${path}: ${e.message}`)
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'the handler threw' }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  // Every variable, not only VITE_ ones: this runs in Node inside the config, and none of it
  // is handed to the client.
  plugins: [apiRoutes(loadEnv(mode, process.cwd(), ''))],
  server: {
    // v86 fetches disk chunks with HTTP Range requests; Vite's static server handles these.
    fs: { allow: ['.'] },
    // HMR disabled on purpose: a hot-reload wipes the emulator's in-memory disk
    // overlay + RAM (all unsaved VM work). Changes to served files now apply only
    // on a MANUAL reload, so an accidental edit can't nuke a live session.
    hmr: false,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        emulator: resolve(__dirname, 'emulator/index.html'),
      },
    },
  },
  // v86 ships a large wasm binary; don't inline it.
  assetsInclude: ['**/*.bin'],
}))
