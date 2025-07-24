import {EditorState, Facet, Extension} from "@wordgard/state"
import {Prop} from "@wordgard/doc"
import {Pos, Node, Tag, Walker, TagType, ChangeDesc, MapMode,
        ElementRepresentation, AttributeRepresentation, StructureRepresentation} from "@wordgard/doc"
import {Elt, EltChild, Widget, WidgetType, TextWidget, pushAttribute, E, mergeAttributes, Shape} from "./shape"
import {Attrs} from "./attributes"

// FIXME support some kind of dependency tracking on decoration
// sources

enum WidgetPlace { Before, After, Start, End }

export type TagSelector = Tag<any> | TagType<any> | readonly TagType<any>[] | string

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
  tag: TagSelector
  deco: WrapperDeco<Tag> | AttributeDeco<Tag> | WidgetDeco<Tag>
}): Extension {
  if ((spec.deco as WrapperDeco<Tag>).element) {
    return new TagWrapperSource(spec.tag, spec.deco as WrapperDeco<Tag>)
  } else if ((spec.deco as WidgetDeco<any>).widget) {
    return new TagWidgetSource(spec.tag, spec.deco as WidgetDeco<Tag>)
  } else {
    return new TagAttributeSource(spec.tag, spec.deco as AttributeDeco<Tag>)
  }
}

function tagPredicate(selector?: TagSelector): (tag: Tag<any>) => boolean {
  return typeof selector == "string" ? t => t.type.isInGroup(selector)
    : selector instanceof TagType ? t => t.type == selector
    : selector instanceof Tag ? t => t.eq(selector)
    : selector ? t => selector.includes(t.type) : () => true
}

function memo<T>(f: (tag: Tag<any>) => T) {
  let map = new WeakMap<Tag<any>, T>()
  return (tag: Tag) => {
    let found = map.get(tag)
    if (found === undefined) map.set(tag, found = f(tag))
    return found
  }
}

function renderStructure<T>(repr: StructureRepresentation<T>, param: T) {
  let tag = typeof repr[0] == "function" ? repr[0](param) : repr[0], attrs: Attrs | undefined
  let children: EltChild[] = []
  for (let i = 1; i < repr.length; i++) {
    let val = repr[i]
    if (typeof val == "function") {
      val = val(param)
      if (Array.isArray(val)) throw new Error("Dynamic parts of a structure representation may not return arrays")
    }
    if (i == 1 && typeof val == "object" && !Array.isArray(val)) {
      attrs = val
    } else if (typeof val == "string" || val === 0) {
      children.push(val)
    } else if (Array.isArray(val)) {
      children.push(renderStructure(val, param))
    }
  }
  return E(tag, attrs || noAttrs, ...children)
}

const tagShape = memo((tag: Tag<unknown>): Shape => {
  let {repr} = tag.type, elt: Widget<any> | Elt | undefined
  if (tag.isText()) {
    elt = TextWidget.of(tag.param)
  } else if (Array.isArray(repr)) {
    elt = renderStructure(repr, tag.param)
  } else {
    let attrs = !repr.attributes ? noAttrs : typeof repr.attributes == "function" ? repr.attributes(tag.param) : repr.attributes
    elt = tag.isAtom() ? E(repr.element, attrs) : E(repr.element, attrs, 0)
  }
  let attrs: string[] | undefined
  for (let prop of tag.props) if (!prop.type.element) {
    let repr = prop.type.repr as AttributeRepresentation<any>
    let value = repr.value == null ? String(prop.value) : typeof repr.value == "string" ? repr.value : repr.value(prop.value)
    if (value != null)
      pushAttribute(attrs || (attrs = []), repr.attribute, value)
  }
  if (attrs) {
    if (elt instanceof Elt) elt = new Elt(elt.tagName, mergeAttributes(elt.attrs, attrs), elt.flags, elt.children)
    else elt = new Elt(tag.isBlock() ? "div" : "span", attrs, 0, [elt])
  }
  return elt
})

class TagWidgetSource {
  place: WidgetPlace
  tag: (tag: Tag) => boolean
  widget: (tag: Tag) => Widget<any>
  extension: Extension

  constructor(tag: TagSelector, deco: WidgetDeco<Tag>) {
    let {place, widget} = deco
    this.place = typeof place == "string" ? WidgetPlace[place] : place
    this.tag = tagPredicate(tag)
    this.widget = typeof widget == "function" ? memo(widget) : () => widget
    this.extension = tagWidgets.of(this)
  }
}

export const tagWidgets = Facet.define<TagWidgetSource>()

export class TagWrapperSource {
  tag: (tag: Tag) => boolean
  wrapper: (tag: Tag) => Elt
  rank: number
  spanning: boolean
  extension: Extension

  constructor(tag: TagSelector, deco: WrapperDeco<Tag>) {
    this.tag = tagPredicate(tag)
    const {element, attributes, rank, spanning} = deco
    if (typeof attributes != "function") {
      let elt = attributes ? E(element, attributes) : E(element)
      this.wrapper = () => elt
    } else {
      this.wrapper = memo(tag => E(deco.element, attributes(tag)))
    }
    this.rank = rank ?? 50
    this.spanning = !!spanning
    this.extension = tagWrappers.of(this)
  }
}

export const tagWrappers = Facet.define<TagWrapperSource>()

export class TagAttributeSource {
  tag: (tag: Tag) => boolean
  attribute: string
  value: string | ((tag: Tag) => string)
  extension: Extension

  constructor(tag: TagSelector, deco: AttributeDeco<Tag>) {
    this.tag = tagPredicate(tag)
    this.attribute = deco.attribute
    this.value = deco.value
    this.extension = tagAttributes.of(this)
  }
}

export const tagAttributes = Facet.define<TagAttributeSource>()

export enum DecorationScope {
  Leaf = 1,
  InlineLeaf = 2,
  All = 4,
//  StartDepth FIXME add support
}

export class RangeDecorationSource<T> {
  tag: (tag: Tag) => boolean
  scope: DecorationScope
  wrapper: ((value: T) => Elt) | null = null
  rank: number = 0
  spanning: boolean = false
  attr: AttributeDeco<T> | null = null
  set: (state: EditorState) => RangeSet<T>
  extension: Extension

  constructor(config: {
    tag?: TagSelector
    scope?: DecorationScope
    deco: WrapperDeco<T> | AttributeDeco<T>
    set: (state: EditorState) => RangeSet<T>
    rank?: number
  }) {
    this.tag = tagPredicate(config.tag)
    this.scope = config.scope ?? DecorationScope.InlineLeaf
    this.set = config.set
    if ((config.deco as WrapperDeco<T>).element) {
      const {element, attributes, spanning, rank} = config.deco as WrapperDeco<T>
      this.spanning = !!spanning
      this.rank = rank ?? 50
      if (typeof attributes == "function") {
        this.wrapper = (value: T) => E(element, attributes(value))
      } else {
        let elt = attributes ? E(element, attributes) : E(element)
        this.wrapper = () => elt
      }
    } else {
      this.attr = config.deco as AttributeDeco<T>
    }
    this.extension = rangeDecorations.of(this)
  }
}

export const rangeDecorations = Facet.define<RangeDecorationSource<any>>()

// FIXME implement a point node decoration source

export class WidgetSource<T> {
  // FIXME names
  set: (state: EditorState) => PointSet<T>
  widget: (value: T) => Widget<any>
  extension: Extension

  constructor(config: {
    set: (state: EditorState) => PointSet<T>,
  } & (T extends Widget<any> ? {} : {
    widget: WidgetType<T> | ((value: T) => Widget<any>)
  })) {
    this.set = config.set
    let widget = (config as any).widget || ((w: any) => w)
    this.widget = widget instanceof WidgetType ? v => widget.of(v) : widget
    this.extension = widgets.of(this)
  }
}

export const widgets = Facet.define<WidgetSource<any>>()

export const noAttrs: Record<string, string> = {}

function findAbove(array: readonly number[], start: number, n: number) {
  let from = start, to = array.length
  for (;;) {
    if (from == to) return from
    let mid = (from + to) >> 1
    if (array[mid] > n) to = mid
    else from = mid + 1
  }
}

// FIXME rename to something like PointSetConfig?
class PointSetType<Value> {
  constructor(readonly side: (value: Value) => number, readonly eq: (a: Value, b: Value) => boolean) {}

  create(source: Iterable<[number, Value]>): PointSet<Value> {
    let positions: number[] = [], values: Value[] = [], prev = -1
    for (let [pos, val] of source) {
      if (pos < prev || pos == prev && this.side(values[values.length - 1]) > this.side(val))
        throw new Error("Points provided in the wrong order to PointSetType.create")
      prev = pos
      positions.push(pos)
      values.push(val)
    }
    return new PointSet<Value>(positions, values, this)
  }

  builder() {
    return new PointBuilder<Value>(this)
  }

  private _empty: PointSet<Value> | null = null

  get empty() {
    return this._empty || (this._empty = new PointSet<Value>(none, none, this))
  }
}

export class PointSet<Value> {
  constructor(readonly positions: readonly number[],
              readonly values: readonly Value[],
              readonly type: PointSetType<Value>) {}

  get length() { return this.positions.length }

  map(changes: ChangeDesc, side?: (value: Value) => number) {
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

  compareRange(fromA: number, b: PointSet<Value>, fromB: number, len: number) {
    let a = this, ranges: number[] = [], endB = fromB + len
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
          if (!this.type.eq(a.values[iA], b.values[iB])) addRange(ranges, next, next)
          iA++
          iB++
        } else if (nextA < nextB) {
          addRange(ranges, nextA, nextA)
          iA++
        } else {
          addRange(ranges, nextB, nextB)
          iB++
        }
      }
    }
    return ranges
  }

  iter(this: Value extends Widget<any> ? this : never): PointIterator<Value>
  iter(get: (value: Value) => Widget<any>): PointIterator<Value>
  iter(get?: (value: Value) => Widget<any>): PointIterator<Value> {
    return new PointIterator<Value>(this, get || (x => x as Widget<any>))
  }

  static for<Value>(ops: {
    side?: number | ((value: Value) => number)
    eq?: (a: Value, b: Value) => boolean
  } = {}) {
    let {side, eq} = ops
    if (side == null) side = 1
    return new PointSetType<Value>(typeof side == "number" ? () => side : side, eq || ((a, b) => a === b))
  }
}

export class PointBuilder<Value> {
  positions: number[] = []
  values: Value[] = []
  cur = 0

  constructor(readonly type: PointSetType<Value>) {}

  add(pos: number, value: Value) {
    if (pos < this.cur) throw new RangeError("Point positions must be added in order")
    this.cur = pos
    this.positions.push(pos)
    this.values.push(value)
  }

  finish(side = 0) { return new PointSet(this.positions, this.values, this.type) }
}

export class PointIterator<Value> {
  declare value: Value | null
  done = false
  declare pos: number
  declare i: number

  constructor(readonly set: PointSet<Value>, readonly get: (value: Value) => Widget<any>) {
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

export class RangeSetType<Value> {
  constructor(readonly inclusive: (value: Value, side: -1 | 1) => boolean,
              readonly eq: (a: Value, b: Value) => boolean) {}

  create(source: Iterable<[number, number, Value]>): RangeSet<Value> {
    let from: number[] = [], to: number[] = [], values: Value[] = [], prev = -1
    for (let [f, t, val] of source) {
      if (f < prev) throw new Error("Range provided to RangeSetType.create are in the wrong order or overlap")
      prev = t
      from.push(f)
      to.push(t)
      values.push(val)
    }
    return new RangeSet<Value>(from, to, values, this)
  }

  builder() { return new RangeBuilder<Value>(this) }

  private _empty: RangeSet<Value> | null = null

  get empty() {
    return this._empty || (this._empty = new RangeSet<Value>(none, none, none, this))
  }
}

export class RangeSet<Value> {
  constructor(
    readonly from: readonly number[],
    readonly to: readonly number[],
    readonly values: readonly Value[],
    readonly type: RangeSetType<Value>
  ) {}

  get length() { return this.from.length }

  map(changes: ChangeDesc) {
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

  compareRange(fromA: number, b: RangeSet<Value>, fromB: number, len: number) {
    let a = this, ranges: number[] = [], toB = fromB + len
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
          if (endA != endB || !a.type.eq(a.values[iA], b.values[iB])) addRange(ranges, start, Math.max(endA, endB))
          iA++
          iB++
        } else if (startA < startB) {
          addRange(ranges, startA, endA)
          iA++
        } else {
          addRange(ranges, startB, endB)
          iB++
        }
      }
    }
    return ranges
  }

  static for<Value>(ops: {
    inclusive?: boolean | ((value: Value, side: -1 | 1) => boolean),
    eq?: (a: Value, b: Value) => boolean
  } = {}) {
    let {inclusive, eq} = ops
    if (inclusive == null) inclusive = false
    return new RangeSetType(typeof inclusive == "boolean" ? () => inclusive : inclusive,
                            eq || ((a, b) => a === b))
  }
}

export class RangeBuilder<Value> {
  from: number[] = []
  to: number[] = []
  values: Value[] = []
  cur = 0

  constructor(readonly type: RangeSetType<Value>) {}

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
  T extends {compareRange: (fromA: number, b: T, fromB: number, len: number) => number[], type: {empty: T}},
  U extends {set: (state: EditorState) => T}
>(
  stateA: EditorState, stateB: EditorState, change: ChangeDesc,
  facet: Facet<U>, 
  fromA: number, fromB: number, len: number,
  addRanges: (ranges: number[]) => void
) {
  let a = stateA.facet(facet), b = stateB.facet(facet), iB = 0
  for (let eltA of a) {
    let idx = b.indexOf(eltA, iB)
    if (idx < 0) {
      let set = eltA.set(stateA)
      addRanges(set.compareRange(fromA, set.type.empty, fromB, len))
    } else {
      while (iB < idx) {
        let set = b[iB++].set(stateB)
        addRanges(set.type.empty.compareRange(fromA, set, fromB, len))
      }
      addRanges(eltA.set(stateA).compareRange(fromA, b[iB++].set(stateB), fromB, len))
    }
  }
  while (iB < b.length) {
    let set = b[iB++].set(stateB)
    addRanges(set.type.empty.compareRange(fromA, set, fromB, len))
  }
}

// Compare ranges and points in decoration facets for unchanged ranges
// in the given change desc. Returns an array using the section format
// used in change descs.
export function findChangedRanges(prev: EditorState, state: EditorState, change: ChangeDesc) {
  let result: number[] = []
  for (let sections = change.sections, i = 0, posA = 0, posB = 0; i < sections.length;) {
    let len = sections[i++], ins = sections[i++]
    if (ins == -1) {
      // Unchanged section. See which parts have potentially updated
      // decorations, and tag those as changed
      let local: number[][] = []
      let add = (ranges: number[]) => { if (ranges.length) local.push(ranges) }
      compareFacet<RangeSet<any>, RangeDecorationSource<any>>(prev, state, change, rangeDecorations,
                                                              posA, posB, len, add)
      compareFacet<PointSet<any>, WidgetSource<any>>(prev, state,change, widgets,
                                                     posA, posB, len, add)
      let joined = joinRanges(local), pos = posB, end = pos + len
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
  return result
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
  enter(tag: Tag, shape: Elt, wrappers: readonly WrapperSource[]): void
  leave(): void
  node(node: Node, shape: Shape, wrappers: readonly WrapperSource[]): void
  widget(widget: Widget<any>, side: number): void
}

class HeapIterator<R, RS, P> {
  active: RangeIterator<R, RS>[] = []
  from: number
  to: number
  point: PointIterator<P> | null = null
  done = false

  constructor(readonly rangeHeap: RangeIterator<R, RS>[],
              readonly pointHeap: PointIterator<P>[],
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

function cmpPoint(a: PointIterator<any>, b: PointIterator<any>) {
  return a.pos - b.pos || a.side - b.side
}

const none: readonly any[] = []

export type WrapperSource = Prop<any> | TagWrapperSource | RangeIterator<any, RangeDecorationSource<any>>

// Enumerate all wrapper elements for a given node. Spanning wrappers
// are always moved to the front of the result. Within the
// spanning/non-spanning wrappers, the ordering is determined by rank.
//
// Note that the return value contains range iterators, and those will
// become invalid as soon as they are advanced further.
function nodeWrappers(
  tag: Tag,
  active: readonly RangeIterator<any, RangeDecorationSource<any>>[],
  global: readonly TagWrapperSource[]
): readonly WrapperSource[] {
  let wrappers: WrapperSource[] | undefined

  for (let prop of tag.props) if (prop.type.element) (wrappers || (wrappers = [])).push(prop)
  for (let src of global) if (src.tag(tag)) (wrappers || (wrappers = [])).push(src)
  if (active.length) {
    let scope = tagScope(tag)
    for (let cur of active) {
      let {source} = cur
      if (source.wrapper && (source.scope & scope) && source.tag(tag)) (wrappers || (wrappers = [])).push(cur)
    }
  }

  if (!wrappers) return none
  if (wrappers.length > 1) wrappers.sort((a, b) => (a.spanning == b.spanning ? 0 : a.spanning ? -1 : 1) || a.rank - b.rank)
  return wrappers
}

function tagScope(tag: Tag): DecorationScope {
  return DecorationScope.All |
    (tag.isLeaf() ? DecorationScope.Leaf | (tag.isInline() ? DecorationScope.InlineLeaf : 0) : 0)
}

export function renderWrapper(src: WrapperSource, tag: Tag): Elt {
  if (src instanceof TagWrapperSource) return src.wrapper(tag)
  if (src instanceof RangeIterator) return src.source.wrapper!(src.value)
  return renderPropWrapper(src)
}

export function renderPropWrapper(prop: Prop<any>) {
  // FIXME memoize this
  let repr = prop.type.repr as ElementRepresentation<any>
  let attrs = typeof repr.attributes == "function" ? repr.attributes(prop.value) : repr.attributes || noAttrs
  return E(repr.element, attrs)
}

export class DecoIterator {
  globalWidgets: readonly TagWidgetSource[]
  globalWrappers: readonly TagWrapperSource[]
  globalAttrs: readonly TagAttributeSource[]
  pos: Pos
  rangeIter: RangeIterator<any, RangeDecorationSource<any>>[] = []
  pointIter: PointIterator<any>[] = []
  
  constructor(readonly state: EditorState) {
    this.globalWidgets = state.facet(tagWidgets)
    this.globalWrappers = state.facet(tagWrappers)
    this.globalAttrs = state.facet(tagAttributes)
    this.pos = state.doc.resolve(0)
    for (let s of state.facet(rangeDecorations)) {
      let set = s.set(state)
      if (set.length) this.rangeIter.push(set.iter(s))
    }
    for (let s of state.facet(widgets)) {
      let set = s.set(state)
      if (set.length) this.pointIter.push(set.iter(s.widget))
    }
  }

  widgets(tag: Tag, place: WidgetPlace, walker: DecoWalker) {
    for (let src of this.globalWidgets) {
      if (src.place == place && src.tag(tag)) {
        let widget = src.widget(tag)
        if (widget) walker.widget(widget, place == WidgetPlace.Before || place == WidgetPlace.End ? 1 : -1)
      }
    }
  }

  walk(from: number, inclusiveStart: boolean, to: number, walker: DecoWalker) {
    for (let i of this.rangeIter) i.goto(from)
    for (let i of this.pointIter) i.goto(inclusiveStart ? from : from + 1)
    let iter = new HeapIterator<any, RangeDecorationSource<any>, any>(this.rangeIter, this.pointIter, from, to)
    let pos = this.pos.advance(from - this.pos.pos), started = inclusiveStart

    let wrap: Walker = {
      skip: node => { // Only done for leaf nodes.
        if (started) this.widgets(node.tag, WidgetPlace.Before, walker)
        else started = true
        let shape = this.tagShape(node.tag, iter.active)
        if (shape.hasHole) throw new Error("Shouldn't be skipping a non-leaf node " + node)
        walker.node(node, shape, nodeWrappers(node.tag, iter.active, this.globalWrappers))
        this.widgets(node.tag, WidgetPlace.After, walker)
      },
      enter: (tag, node) => {
        if (started) this.widgets(tag, WidgetPlace.Before, walker)
        else started = true
        let shape = this.tagShape(tag, iter.active), wrappers = nodeWrappers(tag, iter.active, this.globalWrappers)
        if (tag.isAtom()) {
          if (shape.hasHole) throw new Error(`Shape for atom ${tag.name} has a hole`)
          walker.node(node!, shape, wrappers)
        } else {
          if (!shape.hasHole) throw new Error(`Shape for tag ${tag.name} does not have a hole`)
          walker.enter(tag, shape as Elt, wrappers)
        }
        this.widgets(tag, WidgetPlace.Start, walker)
        return !tag.isAtom()
      },
      leave: tag => {
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
        walker.widget(iter.point.get(iter.point.value!), iter.point.side)
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


  tagShape(tag: Tag, active: RangeIterator<any, RangeDecorationSource<any>>[]) {
    let shape = tagShape(tag)
    let add: string[] | undefined
    for (let src of this.globalAttrs) {
      if (src.tag(tag))
        pushAttribute(add || (add = []), src.attribute, typeof src.value == "function" ? src.value(tag) : src.value)
    }
    for (let iter of active) {
      let {attr} = iter.source
      if (attr && iter.source.tag(tag) && (iter.source.scope & tagScope(tag)))
        pushAttribute(add || (add = []), attr.attribute, typeof attr.value == "function" ? attr.value(iter.value) : attr.value)
    }
    if (add) {
      if (shape instanceof Elt) shape = new Elt(shape.tagName, mergeAttributes(shape.attrs, add), shape.flags, shape.children)
      else shape = new Elt(tag.isBlock() ? "div" : "span", add, 0, [shape])
    }
    return shape
  }
}
