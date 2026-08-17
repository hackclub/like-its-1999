// turn an uploaded filename into a unique 8-char base for the ISO writer's 8.3 names,
// so two uploads differing only past character 8 (or in case) don't collide
export function uniqueBaseName(originalName, used) {
  const stem = originalName.replace(/\.[^.]*$/, '')
  let base =
    stem
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 8) || 'FILE'
  let candidate = base
  let n = 1
  while (used.has(candidate)) {
    const suffix = String(n++)
    candidate = base.slice(0, 8 - suffix.length) + suffix
  }
  used.add(candidate)
  return candidate
}
