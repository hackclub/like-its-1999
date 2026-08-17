// the impure edge: holds the serial port, a timer, and the promise bookkeeping that turns
// the agent's request/reply frames into `await link.call()`. everything with a decision in
// it lives in agent.js and tracking.js, which are pure and tested

import { createDecoder, encode } from './frame.js'
import * as agentModule from './agent.js'
import { createAgent } from './agent.js'
import * as log from './tracking.js'

export const TICK_MS = 1000

// v86 sends raw set-1 scancodes on `keyboard-code`, so every keypress produces a make code
// and a break code; break codes have bit 7 set and 0xe0 is an extended-key prefix, so plain
// make codes approximate real keystrokes. mouse movement is deliberately not activity, since
// a jiggler would make it meaningless
const isKeyDown = (code) => code !== 0xe0 && (code & 0x80) === 0

// `mouse-click` carries the state of [left, middle, right] and is sent on press and on
// release, and again as all-false when the pointer leaves the canvas, so only a button going
// down is a click
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
        // a dead or restarting emulator must not take the page down with it
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

  // ask what is in front the moment a child appears: the child learns the epoch from the
  // calls it receives and needs one before it can address an unsolicited event, so without a
  // first call it never reports a window at all
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

  // input counters come from v86's bus rather than the DOM, so they count what actually
  // reached the guest, from any source, with no focus heuristics
  //
  // which endpoint matters: v86's bus is a connected pair, and a send on one side is
  // delivered to listeners on the other. output from the machine (`serial0-output-byte`)
  // travels device -> adapter, so `add_listener` sees it; input travels adapter -> device
  // and lands on `bus.pair`, where the devices listen. registering input counters with
  // `add_listener` silently counts nothing
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
    // the internal shape changed under us: say so rather than record zero forever
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

    // rejects rather than hanging when there is no child; the agent's own timeout covers a
    // child that never answers
    call(fn, args = []) {
      const c = agentModule.call(agent, fn, args, now())
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

    // a new build became available while the page was open
    setWanted(build) {
      send(agentModule.setWanted(agent, build))
    },

    visibility(visible) {
      log.onVisibility(trackingLog, visible, now())
    },

    // close the open span and hand back the log, for writing into a save
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
