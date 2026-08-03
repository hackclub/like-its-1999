// The tracking log: what the machine was doing, recorded so hours can be worked out later.
//
// **This deliberately computes no hours.** It records spans, input counts and gaps with
// enough fidelity that any policy (idle timeout, coding versus asset attribution, the 25%
// asset cap) can be applied afterwards without re-collecting anything. Deciding the policy
// now would bake a guess into data we cannot re-gather.
//
// Shape follows Hackatime: activity extends the current span rather than emitting a line
// per tick, so a working session is a handful of lines rather than 17k a day. Concretely:
//   - a line when the foreground window changes
//   - at most one keepalive line every 2 minutes while input continues
//   - a line when input stops for longer than the idle gap, closing the span
//
// Time is the host's throughout: a restored guest resumes with a stale RTC, so nothing the
// guest says about time is recorded at all.

export const KEEPALIVE_MS = 2 * 60 * 1000
export const IDLE_GAP_MS = 3 * 60 * 1000

// A log line is an object with `ev` and `t`; everything else depends on the kind. Unknown
// fields must be preserved by anything that reads these, the same rule as the container.

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
    // Current foreground window, as last reported by the guest.
    win: null,
    exe: null,
    // Input accumulated since the last line was written.
    keys: 0,
    clicks: 0,
    wheel: 0,
    // When the pending activity started and when we last saw any input.
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

// Fold accumulated input into a line and reset the counters.
//
// A span always ends at the last input we actually saw, never at the moment we happened to
// flush. Ending at the flush time would credit the silence between the last keystroke and
// a window change, an idle timeout or a save, which is time nobody worked. A lone
// keystroke therefore records a zero-length span: honest, and a tally can credit a minimum
// per span later if it wants to.
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

// The guest says the foreground window changed. Closes the current span so activity is
// never attributed to the wrong application.
export function onWindow(log, { exe, win }, t) {
  if (exe === log.exe && win === log.win) return null
  flushActivity(log, 'window')
  log.exe = exe
  log.win = win
  return push(log, { ev: 'win', t, exe, win })
}

// Input happened. Counts are cheap; a line is only written when a span opens, when the
// keepalive falls due, or when the window changes.
export function onInput(log, { keys = 0, clicks = 0, wheel = 0 } = {}, t) {
  // A long enough silence closes the previous span before this input opens a new one.
  if (log.lastInput !== null && t - log.lastInput >= log.idleGapMs)
    flushActivity(log, 'idle')

  log.keys += keys
  log.clicks += clicks
  log.wheel += wheel
  log.lastInput = t
  if (log.activeSince === null) log.activeSince = t

  // Measured from the start of *this* span, not from the last line written: otherwise the
  // first keystroke after a break is instantly "overdue" and emits an empty span.
  if (t - log.activeSince >= log.keepaliveMs)
    return flushActivity(log, 'keepalive')
  return null
}

// Time passed with no input. Closes a span once the gap is long enough, so the log records
// where the user stopped rather than leaving an open span running to the next keystroke.
export function onTick(log, t) {
  if (log.activeSince === null || log.lastInput === null) return null
  if (t - log.lastInput < log.idleGapMs) return null
  return flushActivity(log, 'idle')
}

// The page was hidden or shown. Recorded rather than acted on: whether a hidden tab counts
// is a policy question for the tally, and a hidden tab barely executes the guest anyway.
export function onVisibility(log, visible, t) {
  if (visible === log.visible) return null
  flushActivity(log, 'visibility')
  log.visible = visible
  return push(log, { ev: 'mark', t, kind: visible ? 'shown' : 'hidden' })
}

// Agent connection state, so a gap in the log can be explained rather than guessed at.
export function onAgent(log, state, t, detail = '') {
  return push(log, { ev: 'agent', t, state, detail })
}

// Close whatever is open. Called before the log is written into a save, so a span that was
// in progress is recorded rather than lost.
export function seal(log) {
  flushActivity(log, 'seal')
  return log.lines
}

// NDJSON for the container. Sorted by time defensively: everything appends in order today,
// but a later source of lines should not be able to produce a log that reads backwards.
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

// A rough shape of what was recorded, for the toolbar. Not an hours figure: it is the sum
// of recorded active spans for this instance only, with no policy applied.
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
    // Written spans plus whatever is still accumulating in the open one. A summary that
    // reads zero while someone is actively working is just wrong, and counting only the
    // pending half (which is what clicks and wheel used to do) is wrong the other way:
    // it reset to nothing every time a span was flushed.
    keys: keys + log.keys,
    clicks: clicks + log.clicks,
    wheel: wheel + log.wheel,
    open: log.activeSince !== null,
    lines: log.lines.length,
    byExe: Object.fromEntries([...byExe].sort((a, b) => b[1] - a[1])),
  }
}
