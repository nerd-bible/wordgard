import {EditorView} from "./editorview"
import {EditorState, Facet, Extension} from "@willows/state"
import {Pos, Node, Tag, Walker, TagType, ChangeDesc, MapMode} from "@willows/doc"

enum WidgetPlace { Before, After, Start, End }

// FIXME allow group names?
export type TagSelector = TagType<any> | readonly TagType<any>[] | "atom"

function tagPredicate(selector?: TagSelector): (tag: Tag<any>) => boolean {
  return selector === "atom" ? t => t.isAtom()
    : selector instanceof TagType ? t => t.type == selector
    : selector ? t => selector.includes(t.type) : () => true
}

function memo<T>(f: (tag: Tag<any>) => T | null) {
  let map = new WeakMap<Tag<any>, T | null>()
  return (tag: Tag) => {
    let found = map.get(tag)
    if (found === undefined) map.set(tag, found = f(tag))
    return found
  }
}

export class TagWidgetSource {
  place: WidgetPlace
  tag: (tag: Tag) => boolean
  widget: (tag: Tag) => Widget | null
  extension: Extension

  constructor(config: {
    tag?: TagSelector,
    side: keyof typeof WidgetPlace | WidgetPlace,
    widget: Widget | ((tag: Tag) => Widget | null)
  }) {
    let {tag, side, widget} = config
    this.place = typeof side == "string" ? WidgetPlace[side] : side
    this.tag = tagPredicate(tag)
    this.widget = typeof widget == "function" ? memo(widget) : () => widget
    this.extension = tagWidgets.of(this)
  }
}

export const tagWidgets = Facet.define<TagWidgetSource>()

export class TagDecorationSource {
  tag: (tag: Tag) => boolean
  deco: (tag: Tag) => Decoration | null // FIXME memoize
  extension: Extension

  constructor(config: {
    tag?: TagSelector,
    deco: Decoration | ((tag: Tag) => Decoration | null)
  }) {
    let {tag, deco} = config
    this.tag = tagPredicate(tag)
    this.deco = typeof deco == "function" ? memo(deco) : () => deco
    this.extension = tagDecorations.of(this)
  }
}

export const tagDecorations = Facet.define<TagDecorationSource>()

export enum DecorationScope {
  Leaf = 1,
  InlineLeaf = 2,
  All = 4,
//  StartDepth
}

// FIXME this should associate decorators with ranges, which determine
// what type of nodes (potentially at what depth) to decorate, rather
// like TagWidgetSource.
export class RangeDecorationSource<T> {
  tag: (tag: Tag) => boolean
  scope: DecorationScope
  set: (state: EditorState) => RangeSet<T>
  deco: (value: T) => Decoration
  extension: Extension

  constructor(config: {
    tag?: TagSelector,
    scope?: DecorationScope,
    set: (state: EditorState) => RangeSet<T>
  } & (T extends Decoration ? {} : {deco: (value: T) => Decoration})) {
    this.tag = tagPredicate(config.tag)
    this.scope = config.scope ?? DecorationScope.InlineLeaf
    this.set = config.set
    this.deco = (config as any).deco || (d => d)
    this.extension = rangeDecorations.of(this)
  }
}

export const rangeDecorations = Facet.define<RangeDecorationSource<any>>()

// FIXME implement a point node decoration source

export class WidgetSource<T> {
  // FIXME names
  set: (state: EditorState) => PointSet<T>
  widget: (value: T) => Widget
  extension: Extension

  constructor(config: {
    set: (state: EditorState) => PointSet<T>,
  } & (T extends Widget ? {} : {widget: (value: T) => Widget})) {
    this.set = config.set
    this.widget = (config as any).widget || (w => w)
    this.extension = widgets.of(this)
  }
}

export const widgets = Facet.define<WidgetSource<any>>()

// FIXME define event handling and update mechanisms
// FIXME avoid subclassing interface
export abstract class Widget {
  render: (view: EditorView) => HTMLElement
  rank: number

  constructor(config: {
    render: (view: EditorView) => HTMLElement,
    rank?: number
  }) {
    this.render = config.render
    this.rank = config.rank ?? 0
  }
}

export enum DecorationType { Spanning, Atom }

export const noAttrs: Record<string, string> = {}

export class Decoration {
  attributes: Record<string, string>
  element: string | undefined
  rank: number
  type: DecorationType

  constructor(spec: {
    attributes?: Record<string, string>,
    element?: string,
    rank?: number,
    atoms?: boolean
  }, readonly leaf: boolean) {
    this.attributes = spec.attributes || noAttrs
    this.element = spec.element
    this.rank = Math.max(0, Math.min(100, spec.rank ?? 100))
    this.type = spec.atoms ? DecorationType.Atom : DecorationType.Spanning
  }
}

function findAbove(array: readonly number[], start: number, n: number) {
  let from = start, to = array.length
  for (;;) {
    if (from == to) return from
    let mid = (from + to) >> 1
    if (array[mid] > n) to = mid
    else from = mid + 1
  }
}

// FIXME put side back onto values somehow?
export class PointSet<Value> {
  private constructor(readonly positions: readonly number[],
                      readonly values: readonly Value[],
                      readonly side: number) {}

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
        let mapped = this.side < 0 ? changes.mapPos(positions[i], -1, MapMode.TrackBefore)
          : changes.mapPos(positions[i], 1, MapMode.TrackAfter)
        if (mapped == null) { addDel(deleted, i); deletions++ }
        else positions[i] = mapped
      }
      pos = toA + 1
    })
    if (!deletions) return new PointSet<Value>(positions, this.values, this.side)
    return new PointSet<Value>(applyDel(deleted, deletions, positions), applyDel(deleted, deletions, this.values), this.side)
  }

  merge(other: PointSet<Value>) {
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
        return new PointSet<Value>(pos, values, this.side)
      }
    }
  }

  compare(old: PointSet<Value>, change: ChangeDesc) {
    let ranges: number[] = [], a = old, b = this
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

  iter(from?: number): PointIterator<Value, undefined>
  iter<Source>(from: number, source: Source): PointIterator<Value, Source>
  iter<Source>(from = 0, source?: Source): PointIterator<Value, Source> {
    return new PointIterator<Value, Source>(this, from, source!)
  }

  static create<Value>(positions: readonly number[], values: readonly Value[], side: number = 0) {
    return new PointSet(positions, values, side)
  }

  static builder<Value>() { return new PointBuilder<Value>() }

  static empty = new PointSet([], [], 0)
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

  finish(side = 0) { return PointSet.create(this.positions, this.values, side) }
}

export class PointIterator<Value, Source> {
  value!: Value | null
  pos!: number
  i!: number

  constructor(readonly set: PointSet<any>, from: number, readonly source: Source) {
    this.fill(findAbove(set.positions, 0, from - 1))
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

const enum RangeSide { StartInclusive = 1, EndInclusive = 2 }

export class RangeSet<Value> {
  private constructor(
    readonly from: readonly number[],
    readonly to: readonly number[],
    readonly values: readonly Value[],
    readonly side: RangeSide // FIXME move to source
  ) {}

  get length() { return this.from.length }

  map(changes: ChangeDesc) {
    if (changes.empty) return this
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
        let mappedFrom = changes.mapPos(from[i], this.side & RangeSide.StartInclusive ? -1 : 1)
        let mappedTo = changes.mapPos(to[i], this.side & RangeSide.EndInclusive ? 1 : -1)
        if (mappedFrom >= mappedTo) { addDel(deleted, i); deletions++ }
        else { from[i] = mappedFrom; to[i] = mappedTo }
      }
      pos = toA + 1
    })
    if (!deletions) return new RangeSet<Value>(from, to, this.values, this.side)
    return new RangeSet<Value>(applyDel(deleted, deletions, from), applyDel(deleted, deletions, to),
                               applyDel(deleted, deletions, this.values), this.side)
  }

  iter(from?: number): RangeIterator<Value, undefined>
  iter<Source>(from: number, source: Source): RangeIterator<Value, Source>
  iter<Source>(from = 0, source?: Source): RangeIterator<Value, Source> {
    return new RangeIterator<Value, Source>(this, from, source!)
  }

  compare(old: RangeSet<Value>, change: ChangeDesc) {
    let ranges: number[] = [], a = old, b = this
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

  static create<Value>(
    from: readonly number[], to: readonly number[],
    values: readonly Value[],
    startSide: number = 1, endSide: number = -1
  ) {
    let side = (startSide < 0 ? RangeSide.StartInclusive : 0) | (endSide < 0 ? 0 : RangeSide.EndInclusive)
    return new RangeSet(from, to, values, side)
  }

  static builder<Value>() { return new RangeBuilder<Value>() }

  static empty = new RangeSet([], [], [], 0 as RangeSide)
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

  finish(startSide: number = 1, endSide: number = -1) {
    return RangeSet.create<Value>(this.from, this.to, this.values, startSide, endSide)
  }
}

export class RangeIterator<Value, Source> {
  value!: Value | null
  from!: number
  to!: number
  i!: number

  constructor(readonly set: RangeSet<any>, from: number, readonly source: Source) {
    this.fill(findAbove(set.to, 0, from))
  }

  get startSide() { return this.set.side & RangeSide.StartInclusive ? -1 : 1 }
  get endSide() { return this.set.side & RangeSide.EndInclusive ? 1 : -1 }

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
}

function addRange(ranges: number[], from: number, to: number) {
  let last = ranges.length - 1
  if (last < 0 || ranges[last] < from) ranges.push(from, to)
  else ranges[last] = Math.max(to, ranges[last])
}

// FIXME make sure empty sets are dropped by caller
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
  skip(node: Node, deco: readonly Decoration[]): void
  enter(tag: Tag, deco: readonly Decoration[]): void | boolean
  leave(): void
  widgets(widgets: readonly Widget[]): void
}

class HeapIterator<R, RS, P, PS> {
  active: RangeIterator<R, RS>[] = []
  rangeHeap: RangeIterator<R, RS>[]
  pointHeap: PointIterator<P, PS>[]

  from: number
  to: number
  points: PointIterator<P, PS>[] | null = null
  done = false

  constructor(ranges: RangeIterator<R, RS>[],
              points: PointIterator<P, PS>[],
              readonly start: number,
              readonly end: number) {
    this.rangeHeap = ranges.slice()
    this.pointHeap = points.slice()
    for (let i = ranges.length >> 1; i >= 0; i--) bubble(this.rangeHeap, i, cmpRangeFrom)
    for (let i = points.length >> 1; i >= 0; i--) bubble(this.pointHeap, i, cmpPoint)
    this.from = this.to = start
    this.next()
  }

  next() {
    if (this.done) return this
    let {rangeHeap, pointHeap, active} = this
    while (true) {
      let [startPos, startSide] = rangeHeap.length ? [rangeHeap[0].from, rangeHeap[0].startSide] : [1e9, 0]
      let [endPos, endSide] = active.length ? [active[0].to, active[0].endSide] : [1e9, 0]
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
  return a.from - b.from || a.startSide - b.startSide
}

function cmpRangeTo(a: RangeIterator<any, any>, b: RangeIterator<any, any>) {
  return a.to - b.to || a.endSide - b.endSide
}

function cmpPoint(a: PointIterator<any, any>, b: PointIterator<any, any>) {
  return a.pos - b.pos
}

function computeDeco(
  tag: Tag<any>,
  active: readonly RangeIterator<any, RangeDecorationSource<any>>[],
  global: readonly TagDecorationSource[]
) {
  let deco: Decoration[] = []
  let scope = DecorationScope.All |
    (tag.isLeaf() ? DecorationScope.Leaf | (tag.isInline() ? DecorationScope.InlineLeaf : 0) : 0)
  for (let elt of active) {
    let {source} = elt
    if ((source.scope & scope) && source.tag(tag)) {
      let add = source.deco(elt.value!)
      if (add) deco.push(add)
    }
  }
  for (let src of global) if (src.tag(tag)) {
    let add = src.deco(tag)
    if (!add) continue
    deco.push(add)
  }
  // FIXME sort, somehow
  return deco
}

export function iterateDeco(pos: Pos, state: EditorState, from: number, to: number, walker: DecoWalker) {
  let globalWidgets = state.facet(tagWidgets)
  let globalDeco = state.facet(tagDecorations)
  let points = state.facet(widgets)
  let ranges = state.facet(rangeDecorations)

  // FIXME drop empty
  let iter = new HeapIterator<any, RangeDecorationSource<any>, any, WidgetSource<any>>(
    ranges.map(s => s.set(state).iter(from, s)),
    points.map(s => s.set(state).iter(from, s)),
    from, to)

  let mkWidgets = (tag: Tag, place: WidgetPlace) => {
    let found: Widget[] | undefined
    for (let src of globalWidgets) {
      if (src.place == place && src.tag(tag)) {
        let widget = src.widget(tag)
        if (widget) {
          if (!found) found = []
          found.splice(rankIndex(found, widget), 0, widget)
        }
      }
    }
    if (found) walker.widgets(found)
  }

  let wrap: Walker = {
    skip(node) {
      mkWidgets(node.tag, WidgetPlace.Before)
      walker.skip(node, computeDeco(node.tag, iter.active, globalDeco))
      mkWidgets(node.tag, WidgetPlace.After)
    },
    enter(tag) {
      mkWidgets(tag, WidgetPlace.Before)
      walker.enter(tag, computeDeco(tag, iter.active, globalDeco))
      mkWidgets(tag, WidgetPlace.Start)
    },
    leave(tag) {
      mkWidgets(tag!, WidgetPlace.End)
      walker.leave()
      mkWidgets(tag!, WidgetPlace.After)
    }
  }

  let before = pos.nodeBefore
  if (before) mkWidgets(before.tag, WidgetPlace.After)
  else mkWidgets(pos.parent.node.tag, WidgetPlace.Start)

  for (; !iter.next().done;) {
    if (iter.points) {
      walker.widgets(iter.points.map(i => i.source.widget(i.value!)))
    } else {
      pos = pos.walk(iter.to - iter.from, wrap)
    }
  }

  let after = pos.nodeAfter
  if (after) mkWidgets(after!.tag, WidgetPlace.Before)
  else mkWidgets(pos.parent.node.tag, WidgetPlace.End)

  return pos
}

function rankIndex<T extends {rank: number}>(array: T[], value: T): number {
  let i = 0, {rank} = value
  while (i < array.length && array[i].rank < rank) i++
  return i
}
