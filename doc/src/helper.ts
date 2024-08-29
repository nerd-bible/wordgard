export const none: readonly any[] = []

export function splitGroups(groups: string) {
  let result = []
  for (let pos = 0; pos < groups.length;) {
    let space = groups.indexOf(" ", pos)
    if (space < 0) space = groups.length
    if (space > pos) result.push(groups.slice(pos, space))
    pos = space + 1
  }
  return result
}

export function compareDeep(a: any, b: any) {
  if (a === b) return true
  if (!a || !b || typeof a != "object" || typeof b != "object") return false
  let array = Array.isArray(a)
  if (Array.isArray(b) != array) return false
  if (array) {
    if (a.length != b.length) return false
    for (let i = 0; i < a.length; i++) if (!compareDeep(a[i], b[i])) return false
  } else {
    for (let p in a) if (!(p in b) || !compareDeep(a[p], b[p])) return false
    for (let p in b) if (!(p in a)) return false
  }
  return true
}

export function eqArray<T extends {eq: (other: T) => boolean}>(a: readonly T[], b: readonly T[]) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}
