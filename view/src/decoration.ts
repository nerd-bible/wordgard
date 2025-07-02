import {EditorState, Facet, Extension} from "@wordgard/state"
import {Pos, Node, Tag, Walker, TagType, ChangeDesc, MapMode,
        AttributeRepresentation, ElementRepresentation} from "@wordgard/doc"
import {Elt, Widget, WidgetType, TextWidget, pushAttribute, E, EltFlag, mergeAttributes, Shape} from "./shape"

// FIXME support some kind of dependency tracking on decoration
// sources

enum WidgetPlace { Before, After, Start, End }

export type TagSelector = Tag<any> | TagType<any> | readonly TagType<any>[] | string

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

const tagShape = memo((tag: Tag<unknown>): Shape => {
  let {dom} = tag.type.spec, elt: Widget<any> | Elt | undefined
  if (tag.isText()) {
    elt = TextWidget.of(tag.param)
  } else {
    if (typeof dom == "function") throw new Error("FIXME")
    let attrs = !dom.attributes ? noAttrs : typeof dom.attributes == "function" ? dom.attributes(tag.param) : dom.attributes
    elt = tag.isAtom() ? E(dom.element, attrs) : E(dom.element, attrs, 0)
  }
  let attrs: string[] | undefined
  for (let prop of tag.props) if (!prop.type.element) {
    let dom = prop.type.spec.dom as AttributeRepresentation<any>
    let value = dom.value == null ? String(prop.value) : typeof dom.value == "string" ? dom.value : dom.value(prop.value)
    if (value != null)
      pushAttribute(attrs || (attrs = []), dom.attribute, value)
  }
  if (attrs) {
    if (elt instanceof Elt) elt = new Elt(elt.tagName, mergeAttributes(elt.attrs, attrs), elt.flags, elt.children)
    else elt = new Elt(tag.isBlock() ? "div" : "span", attrs, elt.hasHole ? EltFlag.Hole : 0, [elt])
  }
  return elt
})

export class TagWidgetSource {
  place: WidgetPlace
  tag: (tag: Tag) => boolean
  widget: (tag: Tag) => Widget<any> | null
  extension: Extension

  constructor(config: {
    tag?: TagSelector,
    side: keyof typeof WidgetPlace | WidgetPlace,
    widget: Widget<any> | ((tag: Tag) => Widget<any> | null)
  }) {
    let {tag, side, widget} = config
    this.place = typeof side == "string" ? WidgetPlace[side] : side
    this.tag = tagPredicate(tag)
    this.widget = typeof widget == "function" ? memo(widget) : () => widget
    this.extension = tagWidgets.of(this)
  }
}

export const tagWidgets = Facet.define<TagWidgetSource>()

// FIXME support attribute-only deco?
export class TagDecorationSource {
  tag: (tag: Tag) => boolean
  deco: (tag: Tag) => Elt | null
  rank: number
  extension: Extension

  constructor(config: {
    tag?: TagSelector,
    deco: Elt | ((tag: Tag) => Elt | null)
    rank?: number
  }) {
    let {tag, deco} = config
    this.tag = tagPredicate(tag)
    this.deco = typeof deco == "function" ? memo(deco) : () => deco
    this.rank = config.rank ?? 50
    this.extension = tagDecorations.of(this)
  }
}

export const tagDecorations = Facet.define<TagDecorationSource>()

export enum DecorationScope {
  Leaf = 1,
  InlineLeaf = 2,
  All = 4,
//  StartDepth FIXME add support
}

export class RangeDecorationSource<T> {
  tag: (tag: Tag) => boolean
  scope: DecorationScope
  set: (state: EditorState) => RangeSet<T>
  deco: (value: T) => Elt
  rank: number
  extension: Extension

  constructor(config: {
    tag?: TagSelector,
    scope?: DecorationScope,
    set: (state: EditorState) => RangeSet<T>,
    rank?: number
  } & (T extends Elt ? {} : {deco: (value: T) => Elt})) {
    this.tag = tagPredicate(config.tag)
    this.scope = config.scope ?? DecorationScope.InlineLeaf
    this.set = config.set
    this.deco = (config as any).deco || (d => d)
    this.rank = config.rank || 50
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

// FIXME how do we ensure points are in the correct order if side
// isn't intrinsic?
export class PointSet<Value> {
  private constructor(readonly positions: readonly number[],
                      readonly values: readonly Value[]) {}

  get length() { return this.positions.length }

  map(changes: Value extends {side: number} ? ChangeDesc : never): PointSet<Value>
  map(changes: ChangeDesc, side: number | ((value: Value) => number)): PointSet<Value>
  map(changes: ChangeDesc, side?: number | ((value: Value) => number)) {
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
        let s = side == null ? (this.values[i] as any).side : typeof side == "number" ? side : side(this.values[i])
        let mapped = s < 0 ? changes.mapPos(positions[i], -1, MapMode.TrackBefore)
          : changes.mapPos(positions[i], 1, MapMode.TrackAfter)
        if (mapped == null) { addDel(deleted, i); deletions++ }
        else positions[i] = mapped
      }
      pos = toA + 1
    })
    if (!deletions) return new PointSet<Value>(positions, this.values)
    return new PointSet<Value>(applyDel(deleted, deletions, positions), applyDel(deleted, deletions, this.values))
  }

  merge(other: PointSet<Value>) {
    if (!this.length) return other
    if (!other.length) return this
    let posA = this.positions, posB = other.positions
    let pos: number[] = new Array(posA.length, posB.length), values: Value[] = new Array(pos.length)
    for (let i = 0, a = 0, b = 0;;) {
      let nextA = a < posA.length ? posA[a] : 1e9
      let nextB = b < posB.length ? posB[b] : 1e9
      if (nextA < nextB) {
        pos[i] = posA[a]
        values[i++] = this.values[a++]
      } else if (nextB < 1e9) {
        pos[i] = posB[b]
        values[i++] = other.values[b++]
      } else {
        return new PointSet<Value>(pos, values)
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
          // FIXME .eq
          if (a.values[iA] != b.values[iB]) addRange(ranges, next, next)
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

  // FIXME provide more ergonomic version
  static create<Value>(positions: readonly number[], values: readonly Value[]) {
    return new PointSet(positions, values)
  }

  static builder<Value>() { return new PointBuilder<Value>() }

  static empty = PointSet.create<any>([], [])
}

export class PointBuilder<Value> {
  positions: number[] = []
  values: Value[] = []
  cur = 0

  add(pos: number, value: Value) {
    if (pos < this.cur) throw new RangeError("Point positions must be added in order")
    this.cur = pos
    this.positions.push(pos)
    this.values.push(value)
  }

  finish(side = 0) { return PointSet.create(this.positions, this.values) }
}

export class PointIterator<Value> {
  declare value: Widget<any> | null
  declare pos: number
  declare i: number

  constructor(readonly set: PointSet<Value>, readonly get: (value: Value) => Widget<any>) {
    this.fill(0)
  }

  fill(i: number) {
    this.i = i
    if (i < this.set.positions.length) {
      this.pos = this.set.positions[i]
      this.value = this.get(this.set.values[i])
    } else {
      this.pos = 1e8
      this.value = null
    }
  }

  next() {
    if (this.value) this.fill(this.i + 1)
  }

  get side() { return this.value ? this.value.side : 1 }

  goto(pos: number) {
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

// FIXME make inclusive an argument to .map?
export class RangeSet<Value> {
  private constructor(
    readonly from: readonly number[],
    readonly to: readonly number[],
    readonly values: readonly Value[],
    readonly inclusive: (value: Value, side: -1 | 1) => boolean
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
        let mappedFrom = changes.mapPos(from[i], this.inclusive(value, -1) ? -1 : 1)
        let mappedTo = changes.mapPos(to[i], this.inclusive(value, 1) ? 1 : -1)
        if (mappedFrom >= mappedTo) { addDel(deleted, i); deletions++ }
        else { from[i] = mappedFrom; to[i] = mappedTo }
      }
      pos = toA + 1
    })
    if (!deletions) return new RangeSet<Value>(from, to, this.values, this.inclusive)
    return new RangeSet<Value>(applyDel(deleted, deletions, from), applyDel(deleted, deletions, to),
                               applyDel(deleted, deletions, this.values), this.inclusive)
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
          // FIXME .eq
          if (a.values[iA] != b.values[iB] || endA != endB) addRange(ranges, start, Math.max(endA, endB))
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

  static create<Value>(
    from: readonly number[], to: readonly number[], values: readonly Value[],
    inclusive: boolean | ((value: Value, side: -1 | 1) => boolean) = false
  ) {
    return new RangeSet(from, to, values, typeof inclusive == "function" ? inclusive : () => inclusive)
  }

  static builder<Value>() { return new RangeBuilder<Value>() }

  static empty = RangeSet.create<any>([], [], [])
}

export class RangeBuilder<Value> {
  from: number[] = []
  to: number[] = []
  values: Value[] = []
  cur = 0

  add(from: number, to: number, value: Value) {
    if (from >= to) throw new Error("Ranges cannot be empty")
    if (from < this.cur) throw new Error("Ranges must be added in order and cannot overlap")
    this.cur = to
    this.from.push(from)
    this.to.push(to)
    this.values.push(value)
  }

  finish() {
    return RangeSet.create<Value>(this.from, this.to, this.values)
  }
}

export class RangeIterator<Value, Source> {
  declare value: Value | null // FIXME handle null being part of value
  declare from: number
  declare to: number
  declare i: number

  constructor(readonly set: RangeSet<any>, readonly source: Source) {
    this.fill(0)
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
    }
  }

  next() {
    if (this.value) this.fill(this.i + 1)
  }

  goto(pos: number) {
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
  T extends {compareRange: (fromA: number, b: T, fromB: number, len: number) => number[]},
  U extends {set: (state: EditorState) => T}
>(
  stateA: EditorState, stateB: EditorState, change: ChangeDesc,
  facet: Facet<U>, 
  empty: T,
  fromA: number, fromB: number, len: number,
  addRanges: (ranges: number[]) => void
) {
  let a = stateA.facet(facet), b = stateB.facet(facet), iB = 0
  for (let eltA of a) {
    let idx = b.indexOf(eltA, iB)
    if (idx < 0) {
      addRanges(eltA.set(stateA).compareRange(fromA, empty, fromB, len))
    } else {
      while (iB < idx)
        addRanges(empty.compareRange(fromA, b[iB++].set(stateB), fromB, len))
      addRanges(eltA.set(stateA).compareRange(fromA, b[iB++].set(stateB), fromB, len))
    }
  }
  while (iB < b.length) addRanges(empty.compareRange(fromA, b[iB++].set(stateB), fromB, len))
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
      compareFacet<RangeSet<any>, RangeDecorationSource<any>>(prev, state, change, rangeDecorations, RangeSet.empty,
                                                              posA, posB, len, add)
      compareFacet<PointSet<any>, WidgetSource<any>>(prev, state,change, widgets, PointSet.empty,
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
  enter(tag: Tag, shape: Elt, wrappers: readonly Elt[]): void
  leave(): void
  node(node: Node, shape: Shape, wrappers: readonly Elt[]): void
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
      if (!this.point.value) popHeap(this.pointHeap, cmpPoint)
      else bubble(this.pointHeap, 0, cmpPoint)
      this.point = null
    }
    let {rangeHeap, pointHeap, active} = this
    while (true) {
      let [startPos, startSide] = rangeHeap.length
        ? [rangeHeap[0].from, rangeHeap[0].set.inclusive(rangeHeap[0].value!, -1) ? -1 : 1]
        : [1e9, 0]
      let [endPos, endSide] = active.length ? [active[0].to, active[0].set.inclusive(active[0].value!, 1) ? 1 : -1] : [1e9, 0]
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
        if (first.value)
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

class NodeWrappers {
  wrappers = none as Elt[]
  spanningWrappers = none as Elt[]

  add(elt: Elt, rank: number) {
    elt.rank = rank
    if (elt.spanning) {
      if (this.spanningWrappers == none) this.spanningWrappers = []
      this.spanningWrappers.push(elt)
    } else {
      if (this.wrappers == none) this.wrappers = []
      this.wrappers.push(elt)
    }
  }

  finish() {
    if (this.wrappers.length > 1) this.wrappers.sort(byRank)
    if (this.spanningWrappers.length > 1) this.spanningWrappers.sort(byRank)
    return !this.wrappers.length ? this.spanningWrappers :
      !this.spanningWrappers.length ? this.wrappers : this.spanningWrappers.concat(this.wrappers)
  }
}

// Enumerate all wrapper elements for a given node. Spanning wrappers
// are always moved to the front of the result. Within the
// spanning/non-spanning wrappers, the ordering is determined by rank.
function nodeWrappers(
  tag: Tag,
  active: readonly RangeIterator<any, RangeDecorationSource<any>>[],
  global: readonly TagDecorationSource[]
) {
  let result = new NodeWrappers

  for (let prop of tag.props) if (prop.type.element) {
    let dom = prop.type.spec.dom as ElementRepresentation<any>
    let attrs = typeof dom.attributes == "function" ? dom.attributes(prop.value) : dom.attributes || noAttrs
    result.add((prop.type.spanning ? E.span : E)(dom.element, attrs, 0), prop.type.rank)
  }
  
  let scope = DecorationScope.All |
    (tag.isLeaf() ? DecorationScope.Leaf | (tag.isInline() ? DecorationScope.InlineLeaf : 0) : 0)
  for (let src of global) if (src.tag(tag)) {
    let elt = src.deco(tag)
    if (elt) result.add(elt, src.rank)
  }
  for (let cur of active) {
    let {source} = cur
    if ((source.scope & scope) && source.tag(tag)) {
      let elt = source.deco(cur.value!)
      if (elt) result.add(elt, cur.source.rank)
    }
  }
  return result.finish()
}


export class DecoIterator {
  globalWidgets: readonly TagWidgetSource[]
  globalDeco: readonly TagDecorationSource[]
  pos: Pos
  rangeIter: RangeIterator<any, RangeDecorationSource<any>>[] = []
  pointIter: PointIterator<any>[] = []
  
  constructor(readonly state: EditorState) {
    this.globalWidgets = state.facet(tagWidgets)
    this.globalDeco = state.facet(tagDecorations)
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

  walk(from: number, to: number, walker: DecoWalker) {
    for (let i of this.rangeIter) i.goto(from)
    for (let i of this.pointIter) i.goto(from)
    let iter = new HeapIterator<any, RangeDecorationSource<any>, any>(this.rangeIter, this.pointIter, from, to)
    let pos = this.pos.advance(from - this.pos.pos)

    let wrap: Walker = {
      skip: node => { // Only done for leaf nodes.
        this.widgets(node.tag, WidgetPlace.Before, walker)
        let shape = tagShape(node.tag)
        if (shape.hasHole) throw new Error("Shouldn't be skipping a non-leaf node " + node)
        walker.node(node, shape, nodeWrappers(node.tag, iter.active, this.globalDeco))
        this.widgets(node.tag, WidgetPlace.After, walker)
      },
      enter: (tag, node) => {
        this.widgets(tag, WidgetPlace.Before, walker)
        let shape = tagShape(tag), wrappers = nodeWrappers(tag, iter.active, this.globalDeco)
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
        this.widgets(tag!, WidgetPlace.End, walker)
        walker.leave()
        this.widgets(tag!, WidgetPlace.After, walker)
      }
    }

    let before = pos.nodeBefore
    if (before) this.widgets(before.tag, WidgetPlace.After, walker)
    else this.widgets(pos.parent.node.tag, WidgetPlace.Start, walker)

    for (; !iter.next().done;) {
      if (iter.point) {
        walker.widget(iter.point.value!, iter.point.side)
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
}

function byRank<T extends {rank: number}>(a: T, b: T) {
  return a.rank - b.rank
}
