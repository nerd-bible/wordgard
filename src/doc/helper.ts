export const none: readonly any[] = []

export function inGroup(group: string, groups: Set<string>) {
  let space = group.indexOf(" ")
  if (space < 0) return groups.has(group)
  for (let pos = 0;;) {
    if (!groups.has(group.slice(pos, space))) return false
    if (space == group.length) return true
    space = group.indexOf(" ", pos = space + 1)
    if (space < 0) space = group.length
  }
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

export function validate<T>(validator: string | ((value: T) => void) | undefined, value: T) {
  if (typeof validator == "string") {
    let types = validator.split("|")
    let name = value === null ? "null" : typeof value
    if (types.indexOf(name) < 0) throw new RangeError(`Expected value of type ${validator} got ${name}`)
  } else if (validator) {
    validator(value)
  }
  return value
}
