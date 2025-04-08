import {EditorState, Facet, Extension} from "@wordgard/state"
import {Pos, Node, Tag, Walker, TagType, ChangeDesc, MapMode,
        AttributeRepresentation, ElementRepresentation} from "@wordgard/doc"
import {Elt, Widget, TextWidget, pushAttribute, E, EltFlag, mergeAttributes, Shape} from "./shape"

// FIXME support some kind of dependency tracking on decoration
// sources

enum WidgetPlace { Before, After, Start, End }

// FIXME allow group names?
export type TagSelector = TagType<any> | readonly TagType<any>[] | "atom"

function tagPredicate(selector?: TagSelector): (tag: Tag<any>) => boolean {
  return selector === "atom" ? t => t.isAtom()
    : selector instanceof TagType ? t => t.type == selector
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

const tagShape = memo((tag: Tag<any>): Shape => {
  let {dom} = tag.type.spec, elt: Widget<any> | Elt | undefined
  if (tag.isText()) {
    elt = TextWidget.of(tag.param)
  } else {
    if (typeof dom == "function") throw new Error("FIXME")
    if (!dom.attributes) elt = E(dom.element, 0)
    // FIXME somehow make this cast unnecessary
    else elt = E(dom.element, typeof dom.attributes == "function" ? dom.attributes((tag as any).param) : dom.attributes, 0)
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

export class RangeDecorationSource<T extends RangeValue> {
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

export class WidgetSource<T extends PointValue> {
  // FIXME names
  set: (state: EditorState) => PointSet<T>
  widget: (value: T) => Widget<any>
  extension: Extension

  constructor(config: {
    set: (state: EditorState) => PointSet<T>,
  } & (T extends Widget<any> ? {} : {widget: (value: T) => Widget<any>})) {
    this.set = config.set
    this.widget = (config as any).widget || (w => w)
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

export interface PointValue {
  side: number
}

export class PointSet<Value extends PointValue> {
  private constructor(readonly positions: readonly number[],
                      readonly values: readonly Value[]) {}

  get length() { return this.positions.length }

  map(changes: ChangeDesc) {
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
        let mapped = this.values[i].side < 0 ? changes.mapPos(positions[i], -1, MapMode.TrackBefore)
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

  compare(old: PointSet<Value>, change: ChangeDesc) {
    let ranges: number[] = [], a = old, b = this
    if (change.empty && a == b) return ranges
    let iA = 0, iB = 0, lA = a.positions.length, lB = b.positions.length
    change.iterGaps((fromA, toA, fromB, toB) => {
      if (fromA) iA = findAbove(a.positions, iA, fromA - 1)
      if (fromB) iB = findAbove(b.positions, iB, fromB - 1)
      let off = fromB - fromA
      for (;;) {
        let nextA = iA < lA ? a.positions[iA] + off : 1e9
        let nextB = iB < lB ? b.positions[iB] : 1e9
        let next = Math.min(nextA, nextB)
        if (next > toB) break
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
    })
    return ranges
  }

  iter(): PointIterator<Value, undefined>
  iter<Source>(source: Source): PointIterator<Value, Source>
  iter<Source>(source?: Source): PointIterator<Value, Source> {
    return new PointIterator<Value, Source>(this, source!)
  }

  static create<Value extends PointValue>(positions: readonly number[], values: readonly Value[], side: number = 0) {
    return new PointSet(positions, values)
  }

  static builder<Value extends PointValue>() { return new PointBuilder<Value>() }

  static empty = new PointSet([], [])
}

export class PointBuilder<Value extends PointValue> {
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

export class PointIterator<Value extends PointValue, Source> {
  value!: Value | null
  pos!: number
  i!: number

  constructor(readonly set: PointSet<any>, readonly source: Source) {
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
    }
  }

  next() {
    if (this.value) this.fill(this.i + 1)
  }

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

// FIXME find a better way to associate these? This is annoying if
// you're trying to put non-deco values into this
export interface RangeValue {
  inclusiveStart: boolean
  inclusiveEnd: boolean
}

export class RangeSet<Value extends RangeValue> {
  private constructor(
    readonly from: readonly number[],
    readonly to: readonly number[],
    readonly values: readonly Value[]
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
        let mappedFrom = changes.mapPos(from[i], value.inclusiveStart ? -1 : 1)
        let mappedTo = changes.mapPos(to[i], value.inclusiveEnd ? 1 : -1)
        if (mappedFrom >= mappedTo) { addDel(deleted, i); deletions++ }
        else { from[i] = mappedFrom; to[i] = mappedTo }
      }
      pos = toA + 1
    })
    if (!deletions) return new RangeSet<Value>(from, to, this.values)
    return new RangeSet<Value>(applyDel(deleted, deletions, from), applyDel(deleted, deletions, to),
                               applyDel(deleted, deletions, this.values))
  }

  iter(): RangeIterator<Value, undefined>
  iter<Source>(source: Source): RangeIterator<Value, Source>
  iter<Source>(source?: Source): RangeIterator<Value, Source> {
    return new RangeIterator<Value, Source>(this, source!)
  }

  compare(old: RangeSet<Value>, change: ChangeDesc) {
    let ranges: number[] = [], a = old, b = this
    if (change.empty && a == b) return ranges
    let iA = 0, iB = 0, lA = a.from.length, lB = b.from.length
    change.iterGaps((fromA, toA, fromB, toB) => {
      if (fromA) iA = findAbove(a.from, iA, fromA - 1)
      if (fromB) iB = findAbove(b.from, iB, fromB - 1)
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
    })
    return ranges
  }

  static create<Value extends RangeValue>(
    from: readonly number[], to: readonly number[], values: readonly Value[],
  ) {
    return new RangeSet(from, to, values)
  }

  static builder<Value extends RangeValue>() { return new RangeBuilder<Value>() }

  static empty = new RangeSet<any>([], [], [])
}

export class RangeBuilder<Value extends RangeValue> {
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

export class RangeIterator<Value extends RangeValue, Source> {
  value!: Value | null
  from!: number
  to!: number
  i!: number

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
  T extends {compare: (old: T, change: ChangeDesc) => number[]},
  U extends {set: (state: EditorState) => T}
>(
  stateA: EditorState, stateB: EditorState, change: ChangeDesc,
  facet: Facet<U>, 
  empty: T, addDiff: (diff: number[]) => void
) {
  let a = stateA.facet(facet), b = stateB.facet(facet), iB = 0
  for (let eltA of a) {
    let idx = b.indexOf(eltA, iB)
    if (idx < 0) {
      addDiff(empty.compare(eltA.set(stateA), change))
    } else {
      while (iB < idx) addDiff(b[iB++].set(stateB).compare(empty, change))
      addDiff(b[iB++].set(stateB).compare(eltA.set(stateA), change))
    }
  }
  while (iB < b.length) addDiff(b[iB++].set(stateB).compare(empty, change))
}

export function findChangedRanges(prev: EditorState, state: EditorState, change: ChangeDesc) {
  let ranges: number[][] = []
  let add = (diff: number[]) => { if (add.length) ranges.push(diff) }
  compareFacet<RangeSet<any>, RangeDecorationSource<any>>(prev, state, change, rangeDecorations, RangeSet.empty, add)
  compareFacet<PointSet<any>, WidgetSource<any>>(prev, state,change, widgets, PointSet.empty, add)
  return joinRanges(ranges)
}

export interface DecoWalker {
  enter(tag: Tag, shape: Shape, wrappers: readonly Elt[]): void
  leave(): void
  node(node: Node, shape: Shape, wrappers: readonly Elt[]): void
  widget(widget: Shape): void
}

class HeapIterator<R extends RangeValue, RS, P extends PointValue, PS> {
  active: RangeIterator<R, RS>[] = []
  from: number
  to: number
  points: PointIterator<P, PS>[] | null = null
  done = false

  constructor(readonly rangeHeap: RangeIterator<R, RS>[],
              readonly pointHeap: PointIterator<P, PS>[],
              start: number,
              readonly end: number) {
    for (let i = rangeHeap.length >> 1; i >= 0; i--) bubble(rangeHeap, i, cmpRangeFrom)
    for (let i = pointHeap.length >> 1; i >= 0; i--) bubble(pointHeap, i, cmpPoint)
    this.from = this.to = start
    this.next()
  }

  next() {
    if (this.done) return this
    let {rangeHeap, pointHeap, active} = this
    while (true) {
      let [startPos, startSide] = rangeHeap.length
        ? [rangeHeap[0].from, rangeHeap[0].value!.inclusiveStart ? -1 : 1]
        : [1e9, 0]
      let [endPos, endSide] = active.length ? [active[0].to, active[0].value!.inclusiveEnd ? 1 : -1] : [1e9, 0]
      let pointPos = pointHeap.length ? pointHeap[0].pos : 1e9
      let nextPos = Math.min(startPos, endPos, pointPos)
      if (nextPos == 1e9 || nextPos > this.to && this.to == this.end) {
        this.done = true
        break
      } else if (nextPos > this.to) {
        this.points = null
        this.from = this.to
        this.to = Math.min(this.end, nextPos)
        break
      } else if (pointPos == nextPos && (startPos > pointPos || startSide > 0) && (endPos > pointPos || endSide > 0)) {
        // We're looking at a set of points
        this.points = []
        while (this.pointHeap.length && this.pointHeap[0].pos == pointPos) {
          let iter = this.pointHeap[0]
          this.points.push(iter)
          iter.next()
          if (iter.value) popHeap(this.pointHeap, cmpPoint)
          else bubble(this.pointHeap, 0, cmpPoint)
        }
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

function cmpPoint(a: PointIterator<any, any>, b: PointIterator<any, any>) {
  return a.pos - b.pos
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
  pointIter: PointIterator<any, WidgetSource<any>>[] = []
  
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
      if (set.length) this.pointIter.push(set.iter(s))
    }
  }

  widgets(tag: Tag, place: WidgetPlace, walker: DecoWalker) {
    let found: Widget<any>[] | undefined
    for (let src of this.globalWidgets) {
      if (src.place == place && src.tag(tag)) {
        let widget = src.widget(tag)
        if (widget) {
          if (!found) found = []
          found.splice(rankIndex(found, widget), 0, widget)
        }
      }
    }
    if (found) {
      if (found.length > 1) found.sort(byRank)
      for (let widget of found) walker.widget(widget)
    }
  }

  walk(from: number, to: number, walker: DecoWalker) {
    for (let i of this.rangeIter) i.goto(from)
    for (let i of this.pointIter) i.goto(from)
    let iter = new HeapIterator<any, RangeDecorationSource<any>, any, WidgetSource<any>>(this.rangeIter, this.pointIter, from, to)
    let pos = this.pos.advance(from - this.pos.pos)

    let wrap: Walker = {
      skip: node => { // Only done for leaf nodes.
        this.widgets(node.tag, WidgetPlace.Before, walker)
        let shape = tagShape(node.tag)
        if (shape.hasHole) throw new Error("Shouldn't be skipping a non-leaf node")
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
          walker.enter(tag, shape, wrappers)
        }
        this.widgets(tag, WidgetPlace.Start, walker)
        return tag.isAtom()
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
      if (iter.points) {
        if (iter.points.length == 1) {
          let it = iter.points[0]
          walker.widget(it.source.widget(it.value!))
        } else {
          let widgets = iter.points.map(i => i.source.widget(i.value!)).sort(byRank)
          for (let widget of widgets) walker.widget(widget)
        }
      } else {
        pos = pos.walk(iter.to - iter.from, wrap)
      }
    }

    let after = pos.nodeAfter
    if (after) this.widgets(after!.tag, WidgetPlace.Before, walker)
    else this.widgets(pos.parent.node.tag, WidgetPlace.End, walker)
    this.pos = pos
  }
}

function rankIndex<T extends {rank: number}>(array: T[], value: T): number {
  let i = 0, {rank} = value
  while (i < array.length && array[i].rank < rank) i++
  return i
}

function byRank<T extends {rank: number}>(a: T, b: T) {
  return a.rank - b.rank
}
