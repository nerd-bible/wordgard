import {EditorState, Facet, Extension} from "wordgard/state"
import {Mark, Pos, Plot, Leaf, Node, Walker, ChangeSet, MapMode,
        ElementShape, AttributeShape, Elt, pushAttribute,
        mergeAttributes, readAttributes} from "wordgard/doc"
import {Attrs} from "./attributes"
import {type EditorView} from "./editorview"

export type WidgetSpec<T> = { // FIXME move to Widget.Spec
  render: (value: T) => HTMLElement | Text
  eq?: (a: T, b: T) => boolean
  destroy?: (value: T) => void
  handleEvent?: (event: Event, view: EditorView) => boolean
}

export class Widget<T> {
  constructor(readonly type: Widget.Type<T>, readonly value: T) {}

  eq(other: any) {
    return other instanceof Widget && other.type == this.type && this.type.eq(this.value, other.value)
  }

  static define<T>(spec: WidgetSpec<T>) {
    return new Widget.Type(spec)
  }

  static create(spec: WidgetSpec<null>) {
    return new Widget.Type<null>(spec).of(null)
  }

  get hasContent() { return false }
}

export namespace Widget {
  export class Type<T> {
    render: (value: T) => HTMLElement | Text
    eq: (a: T, b: T) => boolean
    handleEvent: (event: Event, view: EditorView) => boolean
    destroy: (value: T) => void

    constructor(spec: WidgetSpec<T>) {
      this.render = spec.render
      this.eq = spec.eq || ((a, b) => a === b)
      this.handleEvent = spec.handleEvent || (() => false)
      this.destroy = spec.destroy || (() => {})
    }

    of(value: T) { return new Widget(this, value) }
  }
}

export const TextWidget = Widget.define<string>({
  render: s => document.createTextNode(s)
})

export type DecoElt = Elt<Widget<any> | string>

export type Shape = Widget<any> | DecoElt

// FIXME support some kind of dependency tracking on decoration
// sources

enum WidgetPlace { Before, After, Start, End }

export function tagShape(spec: {
  tag: Node.Selector,
  shape: Shape | ((tag: Node.Tag) => Shape),
  atom?: boolean
}): Extension {
  let {tag, shape, atom} = spec, shapeFunc: (tag: Node.Tag) => Shape
  if (typeof shape == "function") {
    if (atom == null) throw new Error("Dynamic tag shapes must provide an 'atom' field")
    shapeFunc = tag => addMarkAttributes(shape(tag), tag)
  } else {
    if (atom == null) atom = !shape.hasContent
    else if (atom != !shape.hasContent) throw new Error("'atom' and 'shape' field disagree on atomicity")
    shapeFunc = tag => addMarkAttributes(shape, tag)
  }
  return new TagShape(Node.selector(tag), memo(shapeFunc), atom)
}

class TagShape {
  extension: Extension

  constructor(readonly pred: (tag: Node.Type<any>) => boolean,
              readonly shape: (tag: Node.Tag) => Shape,
              readonly atom: boolean) {
    this.extension = [tagShapes.of(this), atomicDecorations]
  }
}

const tagShapes = Facet.define<TagShape>()

export type WrapperDeco<Param> = {
  element: string
  attributes?: Attrs | ((param: Param) => Attrs)
  rank?: number
  spanning?: boolean
}

export type AttributeDeco<Param> = {
  attribute: string
  value: string | ((param: Param) => string)
}

export type WidgetDeco<Param> = {
  widget: Widget<any> | ((param: Param) => Widget<any>)
  place: keyof typeof WidgetPlace | WidgetPlace
}

export function tagDecoration(spec: {
  tag: Node.Selector
  deco: WrapperDeco<Node.Tag> | AttributeDeco<Node.Tag> | WidgetDeco<Node.Tag>
}): Extension {
  if ((spec.deco as WrapperDeco<Node.Tag>).element) {
    return new TagWrapperSource(spec.tag, spec.deco as WrapperDeco<Node.Tag>)
  } else if ((spec.deco as WidgetDeco<any>).widget) {
    return new TagWidgetSource(spec.tag, spec.deco as WidgetDeco<Node.Tag>)
  } else {
    return new TagAttributeSource(spec.tag, spec.deco as AttributeDeco<Node.Tag>)
  }
}

function memo<T, A extends Object>(f: (arg: A) => T) {
  let map = new WeakMap<A, T>()
  return (arg: A) => {
    let found = map.get(arg)
    if (found === undefined) map.set(arg, found = f(arg))
    return found
  }
}

function addMarkAttributes(shape: Shape, tag: Node.Tag) {
  let attrs: string[] | undefined
  for (let mark of tag.marks) if (!mark.type.element) {
    let repr = mark.type.repr as AttributeShape<any>
    let value = repr.value == null ? String(mark.value) : typeof repr.value == "string" ? repr.value : repr.value(mark.value)
    if (value != null)
      pushAttribute(attrs || (attrs = []), repr.attribute, value)
  }
  if (attrs) {
    if (shape instanceof Elt) shape = new Elt(shape.tagName, mergeAttributes(shape.attrs, attrs), shape.children)
    else shape = new Elt(tag.isBlock ? "div" : "span", attrs, [shape])
  }
  return shape
}

const baseTagShape = memo((tag: Node.Tag): Shape => {
  return addMarkAttributes(tag.is(Leaf.Text) ? TextWidget.of(tag.param as string) : tag.type.shape.create(tag.param), tag)
})

class TagWidgetSource {
  place: WidgetPlace
  pred: (tag: Node.Type<any>) => boolean
  widget: (tag: Node.Tag) => Widget<any>
  extension: Extension

  constructor(tag: Node.Selector, deco: WidgetDeco<Node.Tag>) {
    let {place, widget} = deco
    this.place = typeof place == "string" ? WidgetPlace[place] : place
    this.pred = Node.selector(tag)
    this.widget = typeof widget == "function" ? memo(widget) : () => widget
    this.extension = tagWidgets.of(this)
  }
}

export const tagWidgets = Facet.define<TagWidgetSource>()

export class TagWrapperSource {
  pred: (tag: Node.Type<any>) => boolean
  wrapper: (tag: Node.Tag) => DecoElt
  rank: number
  spanning: boolean
  extension: Extension

  constructor(tag: Node.Selector, deco: WrapperDeco<Node.Tag>) {
    this.pred = Node.selector(tag)
    const {element, attributes, rank, spanning} = deco
    if (typeof attributes != "function") {
      let elt = new Elt<never>(element, readAttributes(attributes), null)
      this.wrapper = () => elt
    } else {
      this.wrapper = memo(tag => new Elt(deco.element, readAttributes(attributes(tag)), null))
    }
    this.rank = rank ?? 50
    this.spanning = !!spanning
    this.extension = tagWrappers.of(this)
  }
}

export const tagWrappers = Facet.define<TagWrapperSource>()

export class TagAttributeSource {
  pred: (tag: Node.Type<any>) => boolean
  attribute: string
  value: string | ((tag: Node.Tag) => string)
  extension: Extension

  constructor(tag: Node.Selector, deco: AttributeDeco<Node.Tag>) {
    this.pred = Node.selector(tag)
    this.attribute = deco.attribute
    this.value = deco.value
    this.extension = tagAttributes.of(this)
  }
}

export const tagAttributes = Facet.define<TagAttributeSource>()

export enum DecorationScope {
  Atom = 1,
  InlineAtom = 2,
  All = 4,
}

export class RangeDecorationSource<T> {
  pred: (tag: Node.Type<any>) => boolean
  scope: DecorationScope
  wrapper: ((value: T) => DecoElt) | null = null
  rank: number = 0
  spanning: boolean = false
  attr: AttributeDeco<T> | null = null
  set: (state: EditorState) => RangeSet<T>
  extension: Extension

  constructor(config: {
    tag?: Node.Selector
    scope?: DecorationScope
    deco: WrapperDeco<T> | AttributeDeco<T>
    set: (state: EditorState) => RangeSet<T>
    rank?: number
  }) {
    this.pred = Node.selector(config.tag)
    this.scope = config.scope ?? DecorationScope.InlineAtom
    this.set = config.set
    if ((config.deco as WrapperDeco<T>).element) {
      const {element, attributes, spanning, rank} = config.deco as WrapperDeco<T>
      this.spanning = !!spanning
      this.rank = rank ?? 50
      if (typeof attributes == "function") {
        this.wrapper = (value: T) => new Elt(element, readAttributes(attributes(value)), null)
      } else {
        let elt = new Elt<never>(element, readAttributes(attributes), null)
        this.wrapper = () => elt
      }
    } else {
      this.attr = config.deco as AttributeDeco<T>
    }
    this.extension = rangeDecorations.of(this)
  }
}

export const rangeDecorations = Facet.define<RangeDecorationSource<any>>()

export class WidgetSource<T> {
  set: (state: EditorState) => PointSet<T>
  widget: (value: T) => Widget<any>
  extension: Extension

  constructor(config: {
    set: (state: EditorState) => PointSet<T>,
  } & (T extends Widget<any> ? {} : {
    widget: Widget.Type<T> | ((value: T) => Widget<any>)
  })) {
    this.set = config.set
    let widget = (config as any).widget || ((w: any) => w)
    this.widget = widget instanceof Widget.Type ? v => widget.of(v) : widget
    this.extension = widgets.of(this)
  }
}

export const widgets = Facet.define<WidgetSource<any>>()

export function overrideShape<T>(spec: {
  set: (state: EditorState) => PointSet<T>,
  check?: (node: Node) => boolean,
  // FIXME document that this must not be expensive
  shape: Shape | ((value: T) => Shape),
  atom?: boolean
}) {
  let {shape, atom} = spec, shapeFunc
  if (typeof shape == "function") {
    if (atom == null) throw new Error("Dynamically computed shapes must specify `atom`")
    shapeFunc = shape
  } else {
    if (atom == null) atom = !shape.hasContent
    shapeFunc = () => shape
  }
  return new ShapeOverride(spec.set, shapeFunc, spec.check || (() => true), atom)
}

class ShapeOverride<T> {
  extension: Extension

  constructor(
    readonly set: (state: EditorState) => PointSet<T>,
    readonly shape: (value: T) => Shape,
    readonly check: (node: Node) => boolean,
    readonly atom: boolean
  ) {
    this.extension = [shapeSources.of(this), atomicDecorations]
  }
}

export const shapeSources = Facet.define<ShapeOverride<any>>()

const atomicDecorations = EditorState.isAtom.of((state, node, pos) => {
  for (let src of state.facet(shapeSources)) {
    let found = src.set(state).at(pos)
    if (found !== undefined && src.check(node)) return src.atom
  }
  for (let src of state.facet(tagShapes)) {
    if (src.pred(node.type)) return src.atom
  }
  return null
})

function findAbove(array: readonly number[], start: number, n: number) {
  let from = start, to = array.length
  for (;;) {
    if (from == to) return from
    let mid = (from + to) >> 1
    if (array[mid] > n) to = mid
    else from = mid + 1
  }
}

export class PointSet<Value> {
  constructor(readonly positions: readonly number[],
              readonly values: readonly Value[],
              readonly type: PointSet.Type<Value>) {}

  get length() { return this.positions.length }

  map(changes: ChangeSet, side?: (value: Value) => number) {
    if (changes.empty) return this
    let positions = this.positions.slice()
    let pos = 0, i = 0
    let deleted: number[] = [], deletions = 0
    changes.iterGaps((fromA, toA, fromB) => {
      let off = fromB - fromA, end = toA - 1
      if (end > pos) {
        let nextI = findAbove(positions, i, end)
        if (off) for (; i < nextI; i++) positions[i] += off
        else i = nextI
        pos = end
      }
    }, (fromA, toA) => {
      let nextI = findAbove(positions, i, toA + 1)
      for (; i < nextI; i++) {
        let mapped = (side || this.type.side)(this.values[i]) < 0 ? changes.mapPos(positions[i], -1, MapMode.TrackBefore)
          : changes.mapPos(positions[i], 1, MapMode.TrackAfter)
        if (mapped == null) { addDel(deleted, i); deletions++ }
        else positions[i] = mapped
      }
      pos = toA + 1
    })
    if (!deletions) return new PointSet<Value>(positions, this.values, this.type)
    return new PointSet<Value>(applyDel(deleted, deletions, positions), applyDel(deleted, deletions, this.values), this.type)
  }

  /// @internal
  sideFor(i: number) { return i < this.values.length ? this.type.side(this.values[i]) : 1 }

  merge(other: PointSet<Value>) {
    if (!this.length) return other
    if (!other.length) return this
    let posA = this.positions, posB = other.positions
    let pos: number[] = new Array(posA.length, posB.length), values: Value[] = new Array(pos.length)
    for (let i = 0, a = 0, b = 0;;) {
      let nextA = a < posA.length ? posA[a] : 1e9
      let nextB = b < posB.length ? posB[b] : 1e9
      let cmp = nextA - nextB || this.sideFor(a) - other.sideFor(b)
      if (cmp < 0) {
        pos[i] = posA[a]
        values[i++] = this.values[a++]
      } else if (nextB < 1e9) {
        pos[i] = posB[b]
        values[i++] = other.values[b++]
      } else {
        return new PointSet<Value>(pos, values, this.type)
      }
    }
  }

  compareRange(fromA: number, b: PointSet<Value>, fromB: number, len: number, change: (from: number, to: number) => void) {
    let a = this, endB = fromB + len
    if (a != b || fromA != fromB) {
      let iA = findAbove(a.positions, 0, fromA - 1), lA = a.positions.length
      let iB = findAbove(b.positions, 0, fromB - 1), lB = b.positions.length
      let off = fromB - fromA
      for (;;) {
        let nextA = iA < lA ? a.positions[iA] + off : 1e9
        let nextB = iB < lB ? b.positions[iB] : 1e9
        let next = Math.min(nextA, nextB)
        if (next > endB) break
        if (nextA == nextB) {
          if (!this.type.eq(a.values[iA], b.values[iB])) change(next, next)
          iA++
          iB++
        } else if (nextA < nextB) {
          change(nextA, nextA)
          iA++
        } else {
          change(nextB, nextB)
          iB++
        }
      }
    }
  }

  iter<Source>(src: Source): PointIterator<Value, Source> {
    return new PointIterator<Value, Source>(this, src)
  }

  at(pos: number): Value | undefined { // FIXME handle undefined extends Value
    let index = findAbove(this.positions, 0, pos - 1)
    return index < this.positions.length && this.positions[index] == pos ? this.values[index] : undefined
  }

  static for<Value>(ops: {
    side?: number | ((value: Value) => number)
    eq?: (a: Value, b: Value) => boolean
  } = {}) {
    let {side, eq} = ops
    if (side == null) side = 1
    return new PointSet.Type<Value>(typeof side == "number" ? () => side : side, eq || ((a, b) => a === b))
  }
}

export namespace PointSet {
  export class Type<Value> {
    constructor(readonly side: (value: Value) => number, readonly eq: (a: Value, b: Value) => boolean) {}

    create(source: Iterable<[number, Value]>): PointSet<Value> {
      let positions: number[] = [], values: Value[] = [], prev = -1
      for (let [pos, val] of source) {
        if (pos < prev || pos == prev && this.side(values[values.length - 1]) > this.side(val))
          throw new Error("Points provided in the wrong order to PointSet.Type.create")
        prev = pos
        positions.push(pos)
        values.push(val)
      }
      return new PointSet<Value>(positions, values, this)
    }

    builder() {
      return new PointSet.Builder<Value>(this)
    }

    private _empty: PointSet<Value> | null = null

    get empty() {
      return this._empty || (this._empty = new PointSet<Value>(none, none, this))
    }
  }

  export class Builder<Value> {
    positions: number[] = []
    values: Value[] = []
    cur = 0

    constructor(readonly type: PointSet.Type<Value>) {}

    add(pos: number, value: Value) {
      if (pos < this.cur) throw new RangeError("Point positions must be added in order")
      this.cur = pos
      this.positions.push(pos)
      this.values.push(value)
    }

    finish(side = 0) { return new PointSet(this.positions, this.values, this.type) }
  }
}

export class PointIterator<Value, Source> {
  declare value: Value | null
  done = false
  declare pos: number
  declare i: number

  constructor(readonly set: PointSet<Value>, readonly source: Source) {
    this.fill(0)
  }

  fill(i: number) {
    this.i = i
    if (i < this.set.positions.length) {
      this.pos = this.set.positions[i]
      this.value = this.set.values[i]
    } else {
      this.pos = 1e8
      this.value = null
      this.done = true
    }
  }

  next() {
    if (!this.done) this.fill(this.i + 1)
  }

  get side() {
    return this.done ? 1 : this.set.type.side(this.value!)
  }

  goto(pos: number) {
    this.done = false
    this.fill(findAbove(this.set.positions, 0, pos - 1))
  }    
}

function addDel(deleted: number[], i: number) {
  let last = deleted.length - 1
  if (last >= 0 && deleted[last] == i) deleted[last] = i + 1
  else deleted.push(i, i + 1)
}

function applyDel<T>(deleted: number[], deletions: number, array: readonly T[]): T[] {
  let result = new Array(array.length - deletions)
  for (let iA = 0, iR = 0, iD = 0;;) {
    let last = iD == deleted.length, from = last ? array.length : deleted[iD++]
    while (iA < from) result[iR++] = array[iA++]
    if (last) return result
    let to = deleted[iD++]
    iA += to - from
  }
}

export class RangeSet<Value> {
  constructor(
    readonly from: readonly number[],
    readonly to: readonly number[],
    readonly values: readonly Value[],
    readonly type: RangeSet.Type<Value>
  ) {}

  get length() { return this.from.length }

  map(changes: ChangeSet) {
    if (changes.empty || !this.length) return this
    let from = this.from.slice(), to = this.to.slice()
    let pos = 0, i = 0
    let deleted: number[] = [], deletions = 0
    changes.iterGaps((fromA, toA, fromB) => {
      let off = fromB - fromA, end = toA - 1
      if (end > pos) {
        let nextI = findAbove(from, i, end)
        if (off) for (; i < nextI; i++) { from[i] += off; to[i] += off }
        else i = nextI
        pos = end
      }
    }, (fromA, toA) => {
      let nextI = findAbove(to, i, toA + 1)
      for (; i < nextI; i++) {
        let value = this.values[i]
        let mappedFrom = changes.mapPos(from[i], this.type.inclusive(value, -1) ? -1 : 1)
        let mappedTo = changes.mapPos(to[i], this.type.inclusive(value, 1) ? 1 : -1)
        if (mappedFrom >= mappedTo) { addDel(deleted, i); deletions++ }
        else { from[i] = mappedFrom; to[i] = mappedTo }
      }
      pos = toA + 1
    })
    if (!deletions) return new RangeSet<Value>(from, to, this.values, this.type)
    return new RangeSet<Value>(applyDel(deleted, deletions, from), applyDel(deleted, deletions, to),
                               applyDel(deleted, deletions, this.values), this.type)
  }

  iter(): RangeIterator<Value, undefined>
  iter<Source>(source: Source): RangeIterator<Value, Source>
  iter<Source>(source?: Source): RangeIterator<Value, Source> {
    return new RangeIterator<Value, Source>(this, source!)
  }

  compareRange(fromA: number, b: RangeSet<Value>, fromB: number, len: number, change: (from: number, to: number) => void) {
    let a = this, toB = fromB + len
    if (a != b || fromA != fromB) {
      let iA = findAbove(a.from, 0, fromA - 1), lA = a.from.length
      let iB = findAbove(b.from, 0, fromB - 1), lB = b.from.length
      let off = fromB - fromA
      for (;;) {
        let [startA, endA] = iA < lA ? [a.from[iA] + off, a.to[iA] + off] : [1e9, 1e9]
        let [startB, endB] = iB < lB ? [b.from[iB], b.to[iB]] : [1e9, 1e9]
        let start = Math.min(startA, startB)
        if (start > toB) break
        if (startA == startB) {
          if (endA != endB || !a.type.eq(a.values[iA], b.values[iB])) change(start, Math.max(endA, endB))
          iA++
          iB++
        } else if (startA < startB) {
          change(startA, endA)
          iA++
        } else {
          change(startB, endB)
          iB++
        }
      }
    }
  }

  static for<Value>(ops: {
    inclusive?: boolean | ((value: Value, side: -1 | 1) => boolean),
    eq?: (a: Value, b: Value) => boolean
  } = {}) {
    let {inclusive, eq} = ops
    if (inclusive == null) inclusive = false
    return new RangeSet.Type(typeof inclusive == "boolean" ? () => inclusive : inclusive,
                             eq || ((a, b) => a === b))
  }
}

export namespace RangeSet {
  export class Type<Value> {
    constructor(readonly inclusive: (value: Value, side: -1 | 1) => boolean,
                readonly eq: (a: Value, b: Value) => boolean) {}

    create(source: Iterable<[number, number, Value]>): RangeSet<Value> {
      let from: number[] = [], to: number[] = [], values: Value[] = [], prev = -1
      for (let [f, t, val] of source) {
        if (f < prev) throw new Error("Range provided to RangeSet.Type.create are in the wrong order or overlap")
        prev = t
        from.push(f)
        to.push(t)
        values.push(val)
      }
      return new RangeSet<Value>(from, to, values, this)
    }

    builder() { return new RangeSet.Builder<Value>(this) }

    private _empty: RangeSet<Value> | null = null

    get empty() {
      return this._empty || (this._empty = new RangeSet<Value>(none, none, none, this))
    }
  }

  export class Builder<Value> {
    from: number[] = []
    to: number[] = []
    values: Value[] = []
    cur = 0

    constructor(readonly type: RangeSet.Type<Value>) {}

    add(from: number, to: number, value: Value) {
      if (from >= to) throw new Error("Ranges cannot be empty")
      if (from < this.cur) throw new Error("Ranges must be added in order and cannot overlap")
      this.cur = to
      this.from.push(from)
      this.to.push(to)
      this.values.push(value)
    }

    finish() {
      return new RangeSet<Value>(this.from, this.to, this.values, this.type)
    }
  }
}
 
export class RangeIterator<Value, Source> {
  declare value: Value | null
  declare from: number
  declare to: number
  done = false
  declare i: number

  constructor(readonly set: RangeSet<any>, readonly source: Source) {
    this.fill(0)
  }

  get rank(): Source extends {rank: number} ? number : never {
    return (this.source as any).rank
  }
  get spanning(): Source extends {spanning: boolean} ? boolean : never {
    return (this.source as any).spanning
  }

  fill(i: number) {
    this.i = i
    if (i < this.set.from.length) {
      this.from = this.set.from[i]
      this.to = this.set.to[i]
      this.value = this.set.values[i]
    } else {
      this.from = this.to = 1e8
      this.value = null
      this.done = true
    }
  }

  next() {
    if (!this.done) this.fill(this.i + 1)
  }

  goto(pos: number) {
    this.done = false
    this.fill(findAbove(this.set.to, 0, pos))
  }
}

function addRange(ranges: number[], from: number, to: number) {
  let last = ranges.length - 1
  if (last < 0 || ranges[last] < from) ranges.push(from, to)
  else ranges[last] = Math.max(to, ranges[last])
}

function joinRanges(ranges: number[][]) {
  if (ranges.length == 1) return ranges[0]
  let result: number[] = [], index = ranges.map(() => 0)
  for (;;) {
    let minI = -1, minFrom = -1
    for (let i = 0; i < ranges.length; i++) {
      let idx = index[i], set = ranges[i]
      if (idx < set.length && (minI < 0 || set[idx] < minFrom)) {
        minI = idx
        minFrom = set[idx]
      }
    }
    if (minI < 0) return result
    let idx = index[minI], set = ranges[minI]
    addRange(result, set[idx], set[idx + 1])
    index[minI] += 2
  }
}

function compareFacet<
  T extends {
    compareRange: (fromA: number, b: T, fromB: number, len: number, add: (from: number, to: number) => void) => void,
    type: {empty: T}
  }, U extends {set: (state: EditorState) => T}
>(
  stateA: EditorState, stateB: EditorState,
  facet: Facet<U>, 
  fromA: number, fromB: number, len: number,
  add: (from: number, to: number) => void
) {
  let a = stateA.facet(facet), b = stateB.facet(facet), iB = 0
  for (let eltA of a) {
    let idx = b.indexOf(eltA, iB)
    if (idx < 0) {
      let set = eltA.set(stateA)
      set.compareRange(fromA, set.type.empty, fromB, len, add)
    } else {
      while (iB < idx) {
        let set = b[iB++].set(stateB)
        set.type.empty.compareRange(fromA, set, fromB, len, add)
      }
      eltA.set(stateA).compareRange(fromA, b[iB++].set(stateB), fromB, len, add)
    }
  }
  while (iB < b.length) {
    let set = b[iB++].set(stateB)
    set.type.empty.compareRange(fromA, set, fromB, len, add)
  }
}

function compareGlobal(stateA: EditorState, stateB: EditorState, facet: Facet<any>) {
  return stateA.facet(facet) != stateB.facet(facet)
}

// Compare ranges and points in decoration facets for unchanged ranges
// in the given change desc. Returns an array using the section format
// used in change descs.
export function findChangedRanges(prev: EditorState, state: EditorState, sections: ChangeSet.Sections) {
  let result: number[] = []
  let globalShapeChange = compareGlobal(prev, state, tagShapes)
  let globalChange = globalShapeChange || compareGlobal(prev, state, tagWidgets) ||
    compareGlobal(prev, state, tagWrappers) || compareGlobal(prev, state, tagAttributes)
  // When node shapes change, we need a separate pass to see whether
  // their atomicity changed, and mark a replace for the whole node if
  // it did.
  let shapeChanges: boolean | number[] = globalShapeChange
  for (let i = 0, posA = 0, posB = 0; i < sections.length;) {
    let len = sections[i++], ins = sections[i++]
    if (ins == -1 && globalChange) {
      addSection(result, len, -2)
    } else if (ins == -1) {
      // Unchanged section. See which parts have potentially updated
      // decorations, and tag those as changed
      let cur: number[] = [], curPos = 0, ranges: number[][] = [cur]
      let add = (from: number, to: number) => {
        if (from < curPos) { ranges.push(cur = []); curPos = 0 }
        addRange(cur, from, to)
      }
      compareFacet<RangeSet<any>, RangeDecorationSource<any>>(prev, state, rangeDecorations, posA, posB, len, add)
      compareFacet<PointSet<any>, WidgetSource<any>>(prev, state, widgets, posA, posB, len, add)
      compareFacet<PointSet<any>, ShapeOverride<any>>(prev, state, shapeSources, posA, posB, len, from => {
        add(from, from + 1)
        if (shapeChanges === false) shapeChanges = []
        if (typeof shapeChanges != "boolean") shapeChanges.push(from)
      })
      let joined = joinRanges(ranges), pos = posB, end = pos + len
      for (let i = 0; i < joined.length;) {
        let from = Math.max(pos, joined[i++]), to = Math.min(end, joined[i++])
        if (from > pos) addSection(result, from - pos, -1)
        addSection(result, to - from, -2)
        pos = to
      }
      if (pos < end) addSection(result, end - pos, -1)
      posA + len; posB += len
    } else {
      posA += len
      posB += ins < 0 ? len : ins
      addSection(result, len, ins)
    }
  }
  if (shapeChanges) return addAtomicityChanges(result, prev, state, shapeChanges)
  return result
}

function addAtomicityChanges(
  sections: number[],
  prev: EditorState, state: EditorState,
  changes: boolean | number[]
): ChangeSet.Sections {
  let added: number[] = []
  if (Array.isArray(changes)) {
    let scan = prev.doc.resolve(0), last = -1, sectionPos = 0, sectionI = 0, off = 0
    for (let posB of changes.sort()) {
      if (posB == last) continue
      last = posB
      while (posB >= sectionPos) {
        let len = sections[sectionI++], ins = sections[sectionI++]
        if (ins < 0) {
          sectionPos += len
        } else {
          sectionPos += ins
          off += len - ins
        }
      }
      let posA = posB - off
      if (scan.pos < posA) scan = scan.advance(posA - scan.pos)
      let node = scan.nodeAfter
      if (!node) continue
      if (prev.isAtom(posA, node) != state.isAtom(posB, node))
        addRange(added, posA, posA + node.length)
    }
  } else if (changes) {
    let changedTags = new Set<Node.Type<any>>()
    let a = prev.facet(tagShapes), b = state.facet(tagShapes)
    for (let tag of state.doc.schema.tags) {
      if (atomicShape(tag, a) != atomicShape(tag, b)) changedTags.add(tag)
    }
    if (changedTags.size) prev.doc.iterate((node, pos) => {
      if (changedTags.has(node.tag.type)) {
        added.push(pos, pos + node.length)
        return false
      }
    })
  }
  if (!added.length) return sections

  let changedSections = [], pos = 0
  for (let i = 0; i < added.length;) {
    let from = added[i++], to = added[i++]
    if (from > pos) changedSections.push(from - pos, -1)
    changedSections.push(to - from, to - from)
    pos = to
  }
  if (pos < prev.doc.length) changedSections.push(prev.doc.length - pos, -1)
  return ChangeSet.composeSections(changedSections, sections)
}

function atomicShape(tag: Node.Type<any>, shapes: readonly TagShape[]) {
  for (let s of shapes) if (s.pred(tag)) return s.atom
  return tag.shape.atom
}

function addSection(sections: number[], len: number, ins: number) {
  let last = sections.length - 1
  if (last >= 0) {
    let lastIns = sections[last]
    if (lastIns >= 0 && ins >= 0) {
      sections[last - 1] += len
      sections[last] += ins
      return
    }
    if (lastIns < 0 && lastIns == ins) {
      sections[last - 1] += len
      return
    }
  }
  sections.push(len, ins)
}

export interface DecoWalker {
  enter(node: Plot, shape: DecoElt, wrappers: readonly WrapperSource[]): void
  leave(): void
  node(node: Node, shape: Shape, wrappers: readonly WrapperSource[]): void
  widget(widget: Widget<any>, side: number): void
}

class HeapIterator<R, RS, P, PS> {
  active: RangeIterator<R, RS>[] = []
  from: number
  to: number
  point: PointIterator<P, PS> | null = null
  done = false

  constructor(readonly rangeHeap: RangeIterator<R, RS>[],
              readonly pointHeap: PointIterator<P, PS>[],
              start: number,
              readonly end: number) {
    for (let i = rangeHeap.length >> 1; i >= 0; i--) bubble(rangeHeap, i, cmpRangeFrom)
    for (let i = pointHeap.length >> 1; i >= 0; i--) bubble(pointHeap, i, cmpPoint)
    this.from = this.to = start
  }

  next() {
    if (this.done) return this
    if (this.point) {
      this.point.next()
      if (this.point.done) popHeap(this.pointHeap, cmpPoint)
      else bubble(this.pointHeap, 0, cmpPoint)
      this.point = null
    }
    let {rangeHeap, pointHeap, active} = this
    while (true) {
      let [startPos, startSide] = rangeHeap.length
        ? [rangeHeap[0].from, rangeHeap[0].set.type.inclusive(rangeHeap[0].value!, -1) ? -1 : 1]
        : [1e9, 0]
      let [endPos, endSide] = active.length ? [active[0].to, active[0].set.type.inclusive(active[0].value!, 1) ? 1 : -1] : [1e9, 0]
      let {pos: pointPos, side: pointSide} = pointHeap.length ? pointHeap[0] : {pos: 1e9, side: 1}
      let nextPos = Math.min(startPos, endPos, pointPos)
      if (this.to == this.end && nextPos > this.to) {
        this.done = true
        break
      } else if (nextPos > this.to) {
        this.from = this.to
        this.to = Math.min(this.end, nextPos)
        break
      } else if (pointPos == nextPos && (startPos > pointPos || pointSide < 0) && (endPos > pointPos || pointSide < 0)) {
        this.point = this.pointHeap[0]
        this.from = this.to = pointPos
        break
      } else if ((startPos - endPos || startSide - endSide) < 0) {
        let first = rangeHeap[0]
        sink(active, active.push(first) - 1, cmpRangeTo)
        popHeap(rangeHeap, cmpRangeFrom)
      } else {
        let first = active[0]
        first.next()
        if (!first.done)
          sink(rangeHeap, rangeHeap.push(first) - 1, cmpRangeFrom)
        popHeap(active, cmpRangeTo)
      }
    }
    return this
  }
}

function bubble<T>(heap: T[], index: number, cmp: (a: T, b: T) => number) {
  for (let cur = heap[index];;) {
    let childIndex = (index << 1) + 1
    if (childIndex >= heap.length) break
    let child = heap[childIndex]
    if (childIndex + 1 < heap.length && cmp(child, heap[childIndex + 1]) >= 0) {
      child = heap[childIndex + 1]
      childIndex++
    }
    if (cmp(cur, child) < 0) break
    heap[childIndex] = cur
    heap[index] = child
    index = childIndex
  }
}

function sink<T>(heap: T[], index: number, cmp: (a: T, b: T) => number) {
  let elt = heap[index]
  while (index > 0) {
    let parent = (index + 1) >> 1
    if (cmp(heap[parent], elt) < 0) break
    heap[index] = heap[parent]
    heap[parent] = elt
    index = parent
  }
}

function popHeap<T>(heap: T[], cmp: (a: T, b: T) => number) {
  let last = heap.pop()!
  if (heap.length) {
    heap[0] = last
    bubble(heap, 0, cmp)
  }
}

function cmpRangeFrom(a: RangeIterator<any, any>, b: RangeIterator<any, any>) {
  return a.from - b.from || b.value!.inclusiveStart - a.value!.inclusiveStart
}

function cmpRangeTo(a: RangeIterator<any, any>, b: RangeIterator<any, any>) {
  return a.to - b.to || a.value!.inclusiveEnd - b.value!.inclusiveEnd
}

function cmpPoint(a: PointIterator<any, any>, b: PointIterator<any, any>) {
  return a.pos - b.pos || a.side - b.side
}

const none: readonly any[] = []

export type WrapperSource = Mark<any> | TagWrapperSource | RangeIterator<any, RangeDecorationSource<any>>

// Enumerate all wrapper elements for a given node. Spanning wrappers
// are always moved to the front of the result. Within the
// spanning/non-spanning wrappers, the ordering is determined by rank.
//
// Note that the return value contains range iterators, and those will
// become invalid as soon as they are advanced further.
function nodeWrappers(
  tag: Node.Tag,
  active: readonly RangeIterator<any, RangeDecorationSource<any>>[],
  global: readonly TagWrapperSource[],
  atom: boolean
): readonly WrapperSource[] {
  let wrappers: WrapperSource[] | undefined

  for (let mark of tag.marks) if (mark.type.element) (wrappers || (wrappers = [])).push(mark)
  for (let src of global) if (src.pred(tag.type)) (wrappers || (wrappers = [])).push(src)
  if (active.length) {
    let scope = tagScope(tag, atom)
    for (let cur of active) {
      let {source} = cur
      if (source.wrapper && (source.scope & scope) && source.pred(tag.type)) (wrappers || (wrappers = [])).push(cur)
    }
  }

  if (!wrappers) return none
  if (wrappers.length > 1) wrappers.sort((a, b) => (a.spanning == b.spanning ? 0 : a.spanning ? -1 : 1) || a.rank - b.rank)
  return wrappers
}

function tagScope(tag: Node.Tag, atom: boolean): DecorationScope {
  return DecorationScope.All |
    (atom ? DecorationScope.Atom | (tag.isInline ? DecorationScope.InlineAtom : 0) : 0)
}

export function renderWrapper(src: WrapperSource, tag: Node.Tag): DecoElt {
  if (src instanceof TagWrapperSource) return src.wrapper(tag)
  if (src instanceof RangeIterator) return src.source.wrapper!(src.value)
  return renderMarkWrapper(src)
}

export const renderMarkWrapper = memo((mark: Mark<any>) => {
  let repr = mark.type.repr as ElementShape<any>
  let attrs = readAttributes(typeof repr.attributes == "function" ? repr.attributes(mark.value) : repr.attributes)
  return new Elt<never>(repr.element, attrs, null)
})

export class DecoIterator {
  globalWidgets: readonly TagWidgetSource[]
  globalWrappers: readonly TagWrapperSource[]
  globalAttrs: readonly TagAttributeSource[]
  tagShapes: readonly TagShape[]
  pos: Pos
  rangeIter: RangeIterator<any, RangeDecorationSource<any>>[] = []
  pointIter: PointIterator<any, WidgetSource<any> | ShapeOverride<any>>[] = []
  
  constructor(readonly state: EditorState) {
    this.globalWidgets = state.facet(tagWidgets)
    this.globalWrappers = state.facet(tagWrappers)
    this.globalAttrs = state.facet(tagAttributes)
    this.tagShapes = state.facet(tagShapes)
    this.pos = state.doc.resolve(0)
    for (let s of state.facet(rangeDecorations)) {
      let set = s.set(state)
      if (set.length) this.rangeIter.push(set.iter(s))
    }
    for (let s of state.facet(widgets)) {
      let set = s.set(state)
      if (set.length) this.pointIter.push(set.iter(s))
    }
    for (let s of state.facet(shapeSources)) {
      let set = s.set(state)
      if (set.length) this.pointIter.push(set.iter(s))
    }
  }

  widgets(tag: Node.Tag, place: WidgetPlace, walker: DecoWalker) {
    for (let src of this.globalWidgets) {
      if (src.place == place && src.pred(tag.type)) {
        let widget = src.widget(tag)
        if (widget) walker.widget(widget, place == WidgetPlace.Before || place == WidgetPlace.End ? 1 : -1)
      }
    }
  }

  walk(from: number, inclusiveStart: boolean, to: number, walker: DecoWalker) {
    for (let i of this.rangeIter) i.goto(from)
    for (let i of this.pointIter) i.goto(inclusiveStart ? from : from + 1)
    let iter = new HeapIterator<any, RangeDecorationSource<any>, any, WidgetSource<any> | ShapeOverride<any>>(
      this.rangeIter, this.pointIter, from, to)
    let pos = this.pos.advance(from - this.pos.pos), started = inclusiveStart

    let pendingShape: ShapeOverride<any> | undefined, pendingShapePos = -1, pendingShapeValue: any

    let wrap: Walker = {
      skip: (node, pos) => { // Only done for leaf nodes.
        if (started) this.widgets(node.tag, WidgetPlace.Before, walker)
        else started = true
        let shape
        if (pendingShape && pendingShapePos == pos && pendingShape.check(node)) {
          shape = pendingShape.shape(pendingShapeValue)
          pendingShape = undefined
        } else {
          shape = this.tagShape(node.tag, iter.active)
        }
        pendingShape = undefined
        if (shape.hasContent) throw new Error("Leaf nodes shapes shouldn't have a content hole")
        walker.node(node, shape, nodeWrappers(node.tag, iter.active, this.globalWrappers, true))
        this.widgets(node.tag, WidgetPlace.After, walker)
      },
      enterPlot: (node, pos) => {
        if (started) this.widgets(node.tag, WidgetPlace.Before, walker)
        else started = true
        let shape
        if (pendingShape && pendingShapePos == pos) {
          shape = pendingShape.shape(pendingShapeValue)
          pendingShape = undefined
        } else {
          shape = this.tagShape(node.tag, iter.active)
        }
        let wrappers = nodeWrappers(node.tag, iter.active, this.globalWrappers, !shape.hasContent)
        let atom = !shape.hasContent
        if (atom) walker.node(node!, shape, wrappers)
        else walker.enter(node!, shape as DecoElt, wrappers)
        this.widgets(node.tag, WidgetPlace.Start, walker)
        return !atom
      },
      leavePlot: tag => {
        if (started) this.widgets(tag!, WidgetPlace.End, walker)
        else started = true
        walker.leave()
        this.widgets(tag!, WidgetPlace.After, walker)
      }
    }

    if (inclusiveStart) {
      let before = pos.nodeBefore
      if (before) this.widgets(before.tag, WidgetPlace.After, walker)
      else this.widgets(pos.parent.node.tag, WidgetPlace.Start, walker)
    }

    for (; !iter.next().done;) {
      if (iter.point) {
        let {source, value} = iter.point
        if (source instanceof WidgetSource) {
          walker.widget(source.widget(value!), iter.point.side)
        } else if (pendingShapePos < pos.pos || !pendingShape ||
                   comparePrec(pendingShape, source, this.state.facet(shapeSources)) < 0) {
          pendingShape = source
          pendingShapePos = pos.pos
          pendingShapeValue = value
        }
      } else {
        pos = pos.walk(iter.to - iter.from, wrap)
      }
    }
    if (pos.pos < to) pos = pos.walk(to - pos.pos, wrap)

    let after = pos.nodeAfter
    if (after) this.widgets(after!.tag, WidgetPlace.Before, walker)
    else this.widgets(pos.parent.node.tag, WidgetPlace.End, walker)
    this.pos = pos
  }

  tagShape(tag: Node.Tag, active: RangeIterator<any, RangeDecorationSource<any>>[]) {
    let shape
    if (!tag.is(Leaf.Text)) for (let src of this.tagShapes) if (src.pred(tag.type)) {
      shape = src.shape(tag)
      break
    }
    if (!shape) shape = baseTagShape(tag)
    let add: string[] | undefined
    for (let src of this.globalAttrs) {
      if (src.pred(tag.type))
        pushAttribute(add || (add = []), src.attribute, typeof src.value == "function" ? src.value(tag) : src.value)
    }
    for (let iter of active) {
      let {attr} = iter.source
      if (attr && iter.source.pred(tag.type) && (iter.source.scope & tagScope(tag, !shape.hasContent)))
        pushAttribute(add || (add = []), attr.attribute, typeof attr.value == "function" ? attr.value(iter.value) : attr.value)
    }
    if (add) {
      if (shape instanceof Elt) shape = new Elt(shape.tagName, mergeAttributes(shape.attrs, add), shape.children)
      else shape = new Elt(tag.isBlock ? "div" : "span", add, [shape])
    }
    return shape
  }
}

function comparePrec<T>(a: T, b: T, facet: readonly T[]) {
  if (a !== b) for (let elt of facet) {
    if (a === elt) return -1
    if (b === elt) return 1
  }
  return 0
}
