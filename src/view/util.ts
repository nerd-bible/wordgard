export function eqArray<T extends {eq(b: T): boolean}>(a?: readonly T[] | null, b?: readonly T[] | null) {
  if (!a || !b) return a == b
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}

export function cmpArray<T>(a: readonly T[], b: readonly T[]) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
