// The impure edge: emulator in, agent and log out.
//
// Everything with a decision in it lives in agent.js and tracking.js, which are pure and
// tested. This file is the part that cannot be: it holds the serial port, a timer, and the
// promise bookkeeping that turns the agent's request/reply frames into `await link.call()`.
// Keep it boring.

import { createDecoder, encode } from './frame.js'
import * as agentModule from './agent.js'
import { createAgent } from './agent.js'
import * as log from './tracking.js'

export const TICK_MS = 1000

// v86 sends raw set-1 scancodes on `keyboard-code`, so every physical keypress produces a
// make code and a break code. Break codes have bit 7 set and 0xE0 is an extended-key
// prefix, so counting only plain make codes approximates real keystrokes. Mouse *movement*
// is deliberately not counted as activity: moving a pointer while reading is not work, and
// a jiggler would make it meaningless.
const isKeyDown = (code) => code !== 0xe0 && (code & 0x80) === 0

// `mouse-click` carries the state of [left, middle, right] and is sent on both press and
// release — and again as all-false when the pointer leaves the canvas. Counting every event
// therefore counted every click at least twice. Only a button going down is a click.
function countPresses(previous, next) {
  let presses = 0
  for (let i = 0; i < 3; i++) if (next[i] && !previous[i]) presses++
  return presses
}

export function createLink({
  emulator,
  epoch,
  instanceId,
  wantHash = '',
  wantBytes = null,
  now = () => Date.now(),
  onState = () => {},
  onEvent = () => {},
} = {}) {
  const agent = createAgent({ epoch, wantHash, wantBytes })
  const decoder = createDecoder()
  const trackingLog = log.createLog({ instanceId })
  const waiting = new Map() // call id -> { resolve, reject }
  let stopped = false

  const send = (frames) => {
    for (const f of frames) {
      try {
        emulator.serial_send_bytes(0, encode(f.type, f.fields))
      } catch (e) {
        // A dead or restarting emulator must not take the page down with it.
        console.debug('serial write failed:', e.message)
      }
    }
  }

  const handleEvents = (events) => {
    for (const ev of events) {
      if (ev.type === 'state') {
        log.onAgent(trackingLog, ev.state, now(), ev.ver || '')
        if (ev.state === 'ready') primeForeground()
        onState(ev.state, agent)
      } else if (ev.type === 'event' && ev.name === 'win') {
        const [exe, win] = ev.data
        log.onWindow(trackingLog, { exe, win }, now())
        onEvent(ev)
      } else if (ev.type === 'reply') {
        const w = waiting.get(ev.id)
        if (w) {
          waiting.delete(ev.id)
          ev.ok
            ? w.resolve(ev.data)
            : w.reject(new Error(ev.data[0] || 'call failed'))
        }
      } else {
        onEvent(ev)
      }
    }
  }

  // Ask what is in front the moment a child appears.
  //
  // Two reasons, and the second is not optional. The obvious one: the log should say what
  // the machine is doing now rather than waiting for the user to switch programs. The
  // load-bearing one: the child learns the epoch from the calls it receives, and it needs
  // one before it can address an unsolicited event. Without a first call it would sit
  // there with nothing to answer to and never report a window at all, which is precisely
  // what the native test caught.
  const primeForeground = () => {
    const c = agentModule.call(agent, 'getForeground', [], now())
    if (!c) return
    send([c.frame])
    waiting.set(c.id, {
      resolve: ([exe, win]) => log.onWindow(trackingLog, { exe, win }, now()),
      reject: () => {},
    })
  }

  const pump = (bytes) => {
    for (const frame of decoder.push(bytes)) {
      const r = agentModule.onFrame(agent, frame, now())
      send(r.sends)
      handleEvents(r.events)
    }
  }

  emulator.add_listener('serial0-output-byte', (byte) => {
    if (!stopped) pump(Uint8Array.of(byte))
  })

  // Input counters, taken from v86's bus rather than the DOM so they count what actually
  // reached the guest, from any source, with no focus heuristics.
  //
  // Which endpoint matters. v86's bus is a connected pair: a send on one side is delivered
  // to listeners on the *other*. Output from the machine (`serial0-output-byte`) travels
  // device -> adapter, so `add_listener` sees it. Input travels adapter -> device, so
  // `add_listener` never sees it — those events land on `bus.pair`, where the devices
  // listen. Registering input counters with `add_listener` silently counts nothing, which
  // is exactly what it did the first time this was written.
  const input = (counts) => !stopped && log.onInput(trackingLog, counts, now())
  const pair = emulator.bus?.pair
  if (pair?.register) {
    pair.register(
      'keyboard-code',
      (c) => isKeyDown(c) && input({ keys: 1 }),
      null
    )
    let buttons = [false, false, false]
    pair.register(
      'mouse-click',
      (data) => {
        const next = [!!data?.[0], !!data?.[1], !!data?.[2]]
        const presses = countPresses(buttons, next)
        buttons = next
        if (presses) input({ clicks: presses })
      },
      null
    )
    pair.register('mouse-wheel', () => input({ wheel: 1 }), null)
  } else {
    // The internal shape changed under us: say so rather than record zero forever.
    console.warn('v86 bus.pair is unavailable; input will not be counted')
  }

  const timer = setInterval(() => {
    if (stopped) return
    const t = now()
    const r = agentModule.onTick(agent, t)
    send(r.sends)
    handleEvents(r.events)
    log.onTick(trackingLog, t)
  }, TICK_MS)

  return {
    agent,
    log: trackingLog,

    get state() {
      return agent.state
    },

    // Await a function on the child. Rejects rather than hanging when there is no child;
    // the agent's own timeout covers a child that never answers.
    call(fn, args = []) {
      const c = agentModule.call(agent, fn, args, now())
      // Say why, not just no. "absent" means nothing is running in the guest at all,
      // which until the agent ships in the image is the normal state after any reload.
      if (!c)
        return Promise.reject(
          new Error(
            `cannot run ${fn}: no agent is running in the guest (state "${agent.state}")`
          )
        )
      send([c.frame])
      return new Promise((resolve, reject) =>
        waiting.set(c.id, { resolve, reject })
      )
    },

    // A new build became available while the page was open.
    setWanted(build) {
      send(agentModule.setWanted(agent, build))
    },

    visibility(visible) {
      log.onVisibility(trackingLog, visible, now())
    },

    // Close the open span and hand back the log, for writing into a save.
    seal() {
      log.seal(trackingLog)
      return trackingLog
    },

    summary() {
      return log.summarise(trackingLog)
    },

    stop() {
      stopped = true
      clearInterval(timer)
      for (const w of waiting.values()) w.reject(new Error('link stopped'))
      waiting.clear()
    },
  }
}
