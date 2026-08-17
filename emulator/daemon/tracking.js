// the tracking log: what the machine was doing, recorded so hours can be worked out later
//
// it deliberately computes no hours. it records spans, input counts and gaps with enough
// fidelity that any policy (idle timeout, coding versus asset attribution, the 25% asset
// cap) can be applied afterwards, and deciding the policy now would bake a guess into data
// we cannot re-gather
//
// shape follows Hackatime: activity extends the current span rather than emitting a line per
// tick, so a working session is a handful of lines rather than 17k a day
//   - a line when the foreground window changes
//   - at most one keepalive line every 2 minutes while input continues
//   - a line when input stops for longer than the idle gap, closing the span
//
// time is the host's throughout: a restored guest resumes with a stale RTC, so nothing the
// guest says about time is recorded at all

export const KEEPALIVE_MS = 2 * 60 * 1000
export const IDLE_GAP_MS = 3 * 60 * 1000

// a log line is `ev` and `t` plus whatever the kind adds; unknown fields must be preserved
// by anything that reads these, the same rule as the container
export function createLog({
  instanceId,
  keepaliveMs = KEEPALIVE_MS,
  idleGapMs = IDLE_GAP_MS,
} = {}) {
  return {
    instanceId,
    keepaliveMs,
    idleGapMs,
    lines: [],
    win: null,
    exe: null,
    // input accumulated since the last line was written
    keys: 0,
    clicks: 0,
    wheel: 0,
    activeSince: null,
    lastInput: null,
    lastWrite: null,
    visible: true,
  }
}

const push = (log, line) => {
  log.lines.push(line)
  log.lastWrite = line.t
  return line
}

// fold accumulated input into a line and reset the counters
//
// a span always ends at the last input we actually saw, never at the moment we happened to
// flush, since ending at the flush would credit the silence between the last keystroke and a
// window change, an idle timeout or a save. a lone keystroke therefore records a zero-length
// span, and a tally can credit a minimum per span later if it wants to
function flushActivity(log, reason) {
  if (log.activeSince === null) return null
  const t = Math.max(log.activeSince, log.lastInput ?? log.activeSince)
  const line = push(log, {
    ev: 'active',
    t,
    from: log.activeSince,
    exe: log.exe,
    win: log.win,
    keys: log.keys,
    clicks: log.clicks,
    wheel: log.wheel,
    visible: log.visible,
    why: reason,
  })
  log.keys = 0
  log.clicks = 0
  log.wheel = 0
  log.activeSince = reason === 'keepalive' ? t : null
  return line
}

// closes the current span so activity is never attributed to the wrong application
export function onWindow(log, { exe, win }, t) {
  if (exe === log.exe && win === log.win) return null
  flushActivity(log, 'window')
  log.exe = exe
  log.win = win
  return push(log, { ev: 'win', t, exe, win })
}

export function onInput(log, { keys = 0, clicks = 0, wheel = 0 } = {}, t) {
  if (log.lastInput !== null && t - log.lastInput >= log.idleGapMs)
    flushActivity(log, 'idle')

  log.keys += keys
  log.clicks += clicks
  log.wheel += wheel
  log.lastInput = t
  if (log.activeSince === null) log.activeSince = t

  // measured from the start of this span, not the last line written: otherwise the first
  // keystroke after a break is instantly overdue and emits an empty span
  if (t - log.activeSince >= log.keepaliveMs)
    return flushActivity(log, 'keepalive')
  return null
}

// closes a span once the gap is long enough, so the log records where the user stopped
// rather than leaving an open span running to the next keystroke
export function onTick(log, t) {
  if (log.activeSince === null || log.lastInput === null) return null
  if (t - log.lastInput < log.idleGapMs) return null
  return flushActivity(log, 'idle')
}

// recorded rather than acted on: whether a hidden tab counts is a policy question for the
// tally, and a hidden tab barely executes the guest anyway
export function onVisibility(log, visible, t) {
  if (visible === log.visible) return null
  flushActivity(log, 'visibility')
  log.visible = visible
  return push(log, { ev: 'mark', t, kind: visible ? 'shown' : 'hidden' })
}

// agent connection state, so a gap in the log can be explained rather than guessed at
export function onAgent(log, state, t, detail = '') {
  return push(log, { ev: 'agent', t, state, detail })
}

// called before the log is written into a save, so a span in progress is recorded not lost
export function seal(log) {
  flushActivity(log, 'seal')
  return log.lines
}

// sorted by time defensively: everything appends in order today, but a later source of lines
// should not be able to produce a log that reads backwards
export function toNdjson(log) {
  const sorted = [...log.lines].sort((a, b) => a.t - b.t)
  return (
    sorted.map((l) => JSON.stringify(l)).join('\n') +
    (sorted.length ? '\n' : '')
  )
}

export function fromNdjson(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

// for the toolbar, and not an hours figure: the sum of recorded active spans for this
// instance only, with no policy applied
export function summarise(log) {
  const byExe = new Map()
  let activeMs = 0
  let keys = 0
  let clicks = 0
  let wheel = 0
  for (const l of log.lines) {
    if (l.ev !== 'active') continue
    const ms = Math.max(0, l.t - l.from)
    activeMs += ms
    keys += l.keys || 0
    clicks += l.clicks || 0
    wheel += l.wheel || 0
    byExe.set(l.exe || '?', (byExe.get(l.exe || '?') || 0) + ms)
  }
  return {
    activeMs,
    // written spans plus whatever is still accumulating in the open one: counting only the
    // written half reads zero while someone is working, and counting only the pending half
    // resets to nothing every time a span is flushed
    keys: keys + log.keys,
    clicks: clicks + log.clicks,
    wheel: wheel + log.wheel,
    open: log.activeSince !== null,
    lines: log.lines.length,
    byExe: Object.fromEntries([...byExe].sort((a, b) => b[1] - a[1])),
  }
}
