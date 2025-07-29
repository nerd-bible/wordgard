export class Elt {
  constructor(
    readonly tagName: string,
    readonly attrs: Attributes,
    // Null means a hole
    readonly children: readonly Shape[] | null
  ) {}

  get hasHole(): boolean { return this.children == null || this.children.some(ch => ch.hasHole) }

  eqTag(elt: Elt) {
    return elt.tagName == this.tagName && sameAttributes(this.attrs, elt.attrs)
  }

  eqChildren(elt: Elt) {
    return !elt.children || !this.children ? elt.children == this.children : eqArray(this.children, elt.children) 
  }

  eq(shape: Shape) {
    return shape instanceof Elt && this.eqTag(shape) && this.eqChildren(shape)
  }
}

export const noChildren: readonly Shape[] = []

export type Shape = Elt | Widget<any>

export type WidgetSpec<T> = {
  render: (value: T) => HTMLElement | Text
  eq?: (a: T, b: T) => boolean
}

export class WidgetType<T> {
  render: (value: T) => HTMLElement | Text
  eq: (a: T, b: T) => boolean

  constructor(spec: WidgetSpec<T>) {
    this.render = spec.render
    this.eq = spec.eq || ((a, b) => a === b)
  }

  of(value: T) { return new Widget(this, value) }
}

export class Widget<T> {
  constructor(readonly type: WidgetType<T>, readonly value: T) {}

  eq(other: Shape) {
    return other instanceof Widget && other.type == this.type && this.type.eq(this.value, other.value)
  }

  static define<T>(spec: WidgetSpec<T>) {
    return new WidgetType(spec)
  }

  static create(spec: WidgetSpec<null>) {
    return new WidgetType<null>(spec).of(null)
  }

  get hasHole() { return false }
}

export const TextWidget = Widget.define<string>({
  render: s => document.createTextNode(s)
})

export class Wrapper {
  constructor(
    readonly tagName: string | null,
    readonly attrs: Attributes
  ) {}
}

// Sets of attributes are stored in arrays of strings, with the even
// indices holding attribute names, the odd ones attribute values. The
// attributes are sorted by name.
export type Attributes = readonly string[]

export const noAttributes: Attributes = []

export function sameAttributes(a: Attributes, b: Attributes) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false
  return true
}

export function compareAttributes(a: Attributes, b: Attributes) {
  for (let iA = 0, iB = 0, score = 0;;) {
    if (iA < a.length && iB < b.length && a[iA] == b[iB]) {
      if (a[iA + 1] != b[iB + 1]) score--
      iA += 2; iB += 2
    } else if (iA < a.length && (iB == b.length || a[iA] < b[iB])) {
      score--
      iA += 2
    } else if (iB < b.length && iA < a.length) {
      score--
      iB += 2
    } else {
      return score
    }
  }
}

// Combine two attribute sets, with b having higher precedence when
// they set the same attribute.
export function mergeAttributes(a: Attributes, b: Attributes) {
  if (!a.length) return b
  if (!b.length) return a
  let result: string[] = []
  for (let iA = 0, iB = 0;;) {
    let kA = iA < a.length ? a[iA] : null, kB = iB < b.length ? b[iB] : null
    if (kA == kB) {
      if (kA == null) return result
      let value = b[iB + 1]
      if (kA == "class") value = a[iA + 1] + " " + value
      else if (kA == "style") value = a[iA + 1] + ";" + value
      result.push(kA, value)
      iA += 2; iB + 2
    } else if (kA != null && (kB == null || kA < kB)) {
      result.push(kA, a[iA + 1])
      iA += 2
    } else {
      result.push(kB!, b[iB + 1])
      iB += 2
    }
  }
}

export function pushAttribute(a: string[], name: string, value: string) {
  let i = 0
  while (i < a.length && a[i] < name) i += 2
  if (i < a.length && a[i] == name) {
    if (name == "class") a[i + 1] += " " + value
    else if (name == "style") a[i + 1] += ";" + value
    else a[i + 1] = value
  } else {
    a.splice(i, 0, name, value)
  }
}

export function takeAttributes(elt: HTMLElement): Attributes {
  let attrs: string[] = []
  for (let i = 0; i < elt.attributes.length; i++) {
    let {name, value} = elt.attributes[i]
    pushAttribute(attrs, name, value)
  }
  return attrs.length ? attrs : noAttributes
}

export function readAttributes(obj: Record<string, string> | null | undefined) {
  if (!obj) return noAttributes
  let result: string[] = []
  for (let prop in obj) pushAttribute(result, prop, obj[prop])
  return result.length ? result : noAttributes
}

export function eqArray<T extends {eq(b: T): boolean}>(a: readonly T[], b: readonly T[]) {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}
