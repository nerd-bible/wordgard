import {EditorView} from "./editorview"
import {EditorState, Facet, Extension} from "@willows/state"
import {Pos, Node, Tag, TagType, Walker, ChangeDesc, MapMode} from "@willows/doc"

enum WidgetPlace { Before, After, Start, End }

// FIXME see if this can be an interface
export type DecorationSource = TagWidgetSource | TagDecorationSource | RangeDecorationSource<any> | WidgetSource<any>

export const decorations = Facet.define<DecorationSource>()

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
    this.extension = decorations.of(this)
  }
}

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
    this.extension = decorations.of(this)
  }
}

export class RangeDecorationSource<T> {
  tag: (tag: Tag) => boolean
  set: (state: EditorState) => RangeSet<T>
  deco: (value: T) => Decoration
  extension: Extension

  constructor(config: {
    tag?: TagSelector,
    set: (state: EditorState) => RangeSet<T>
  } & (T extends Decoration ? {} : {deco: (value: T) => Decoration})) {
    this.tag = tagPredicate(config.tag)
    this.set = config.set
    this.deco = (config as any).deco || (d => d)
    this.extension = decorations.of(this)
  }
}

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
    this.extension = decorations.of(this)
  }
}

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

  iter(from?: number): PointIterator<Value>
  iter<Result>(from: number, transform: (value: Value) => Result): PointIterator<Result>
  iter<Result>(from = 0, transform?: (value: Value) => Result): PointIterator<Result> {
    return new PointIterator<Result>(this, from, transform || ((a: any) => a))
  }

  static create<Value>(positions: readonly number[], values: readonly Value[], side: number = 0) {
    return new PointSet(positions, values, side)
  }

  static builder<Value>() { return new PointBuilder<Value>() }
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

interface DecoIterator<Result> { // FIXME name
  value: Result | null
  from: number
  to: number
  order: number
  endOrder: number
  next(): void
}

export class PointIterator<Result> implements DecoIterator<Result> {
  value!: Result | null
  from!: number
  i!: number

  get to() { return this.from }
  get order() { return 0 }
  get endOrder() { return 0 }

  constructor(readonly set: PointSet<any>, from: number, readonly transform: (value: any) => Result) {
    this.fill(findAbove(set.positions, 0, from - 1))
  }

  fill(i: number) {
    this.i = i
    if (i < this.set.positions.length) {
      this.from = this.set.positions[i]
      this.value = this.transform(this.set.values[i])
    } else {
      this.from = 1e8
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
    readonly side: RangeSide
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

  iter(from?: number): RangeIterator<Value>
  iter<Result>(from: number, transform: (value: Value) => Result): RangeIterator<Result>
  iter<Result>(from = 0, transform?: (value: Value) => Result): RangeIterator<Result> {
    return new RangeIterator<Result>(this, from, transform || ((a: any) => a))
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

export class RangeIterator<Result> implements DecoIterator<Result> {
  value!: Result | null
  from!: number
  to!: number
  i!: number

  constructor(readonly set: RangeSet<any>, from: number, readonly transform: (value: any) => Result) {
    this.fill(findAbove(set.to, 0, from))
  }

  get order() { return this.set.side & RangeSide.StartInclusive ? -1 : 1 }
  get endOrder() { return this.set.side & RangeSide.EndInclusive ? 1 : -1 }

  fill(i: number) {
    this.i = i
    if (i < this.set.from.length) {
      this.from = this.set.from[i]
      this.to = this.set.to[i]
      this.value = this.transform(this.set.values[i])
    } else {
      this.from = this.to = 1e8
      this.value = null
    }
  }

  next() {
    if (this.value) this.fill(this.i + 1)
  }
}

export interface DecoWalker {
  skip(node: Node, deco: readonly Decoration[]): void
  enter(tag: Tag, deco: readonly Decoration[]): void | boolean
  leave(): void
  widgets(widgets: readonly Widget[], deco: readonly Decoration[]): void
}

const EmptyIterator: DecoIterator<any> = {
  value: null,
  from: 1e9, to: 1e9,
  order: 0,
  endOrder: 0,
  next: () => {}
}

class HeapIterator<Value> implements DecoIterator<Value> {
  constructor(readonly heap: DecoIterator<Value>[]) {
    for (let i = heap.length >> 1; i >= 0; i--) this.bubble(i)
  }

  get value() { return this.heap[0].value }
  get from() { return this.heap[0].from }
  get to() { return this.heap[0].to }
  get order() { return this.heap[0].order }
  get endOrder() { return this.heap[0].endOrder }

  next() {
    if (this.value) {
      this.heap[0].next()
      this.bubble(0)
    }
  }

  bubble(index: number) {
    for (let {heap} = this, cur = heap[index];;) {
      let childIndex = (index << 1) + 1
      if (childIndex >= heap.length) break
      let child = heap[childIndex]
      if (childIndex + 1 < heap.length && HeapIterator.cmp(child, heap[childIndex + 1]) >= 0) {
        child = heap[childIndex + 1]
        childIndex++
      }
      if (HeapIterator.cmp(cur, child) < 0) break
      heap[childIndex] = cur
      heap[index] = child
      index = childIndex
    }
  }

  static cmp(a: DecoIterator<any>, b: DecoIterator<any>) {
    return a.from - b.from || a.order - b.order
  }
}

function addGlobalDeco(deco: readonly Decoration[], tag: Tag<any>, global: TagDecorationSource[]) {
  let copy: Decoration[] | undefined
  for (let src of global) if (src.tag(tag)) {
    if (!copy) copy = deco.slice()
    let i = 0, add = src.deco(tag)
    if (!add) continue
    while (i < deco.length && deco[i].rank < add.rank) i++
    copy.splice(i, 0, add)
  }
  return copy || deco
}

export function iterateDeco(pos: Pos, state: EditorState, from: number, to: number, walker: DecoWalker) {
  let iters: DecoIterator<Decoration | Widget>[] = []
  let globalDeco: TagDecorationSource[] = [], globalWidgets: TagWidgetSource[] = []
  // FIXME should put these in different facets rather than collecting them here
  for (let d of state.facet(decorations)) {
    if (d instanceof TagWidgetSource) {
      globalWidgets.push(d)
    } else if (d instanceof TagDecorationSource) {
      globalDeco.push(d)
    } else if (d instanceof RangeDecorationSource) {
      iters.push(d.set(state).iter<Decoration>(from, d.deco))
    } else {
      iters.push(d.set(state).iter<Widget>(from, d.widget))
    }
  }

  let widgets = (tag: Tag, place: WidgetPlace) => {
    let found: Widget[] | undefined
    for (let src of globalWidgets) {
      if (src.place == place && src.tag(tag)) {
        let i = 0, widget = src.widget(tag)
        if (widget) {
          if (!found) found = []
          while (i < found.length && found[i].rank < widget.rank) i++
          found.splice(i, 0, widget)
        }
      }
    }
    if (found) walker.widgets(found, active)
  }

  let iter = !iters.length ? EmptyIterator : iters.length == 1 ? iters[0] : new HeapIterator<Decoration | Widget>(iters)
  let active: Decoration[] = [], activeTo: number[] = [], nextActiveEnd = 1e9
  let wrap: Walker = {
    skip(node) {
      widgets(node.tag, WidgetPlace.Before)
      walker.skip(node, addGlobalDeco(active, node.tag, globalDeco))
      widgets(node.tag, WidgetPlace.After)
    },
    enter(tag) {
      widgets(tag, WidgetPlace.Before)
      walker.enter(tag, addGlobalDeco(active, tag, globalDeco))
      widgets(tag, WidgetPlace.Start)
    },
    leave(tag) {
      widgets(tag!, WidgetPlace.End)
      walker.leave()
      widgets(tag!, WidgetPlace.After)
    }
  }

  let before = pos.nodeBefore
  if (before) widgets(before.tag, WidgetPlace.After)
  else widgets(pos.parent.node.tag, WidgetPlace.Start)

  for (;;) {
    let next = Math.min(iter.from, to, nextActiveEnd >> 1)
    if (next > pos.pos) {
      pos = pos.walk(next - pos.pos, wrap)
    } else if (next == (nextActiveEnd >> 1) && !((nextActiveEnd & 1) && iter.value instanceof Widget)) {
      let nextEnd = 1e9
      for (let i = 0; i < active.length; i++) {
        if (activeTo[i] == nextActiveEnd) {
          active.splice(i, 1)
          activeTo.splice(i--, 1)
        } else {
          nextEnd = Math.min(nextEnd, activeTo[i])
        }
      }
      nextActiveEnd = nextEnd
    } else if (iter.value instanceof Widget) { // FIXME handle point decorations
      let widgets = [iter.value]
      for (;;) {
        iter.next()
        if (iter.from > pos.pos || !(iter.value instanceof Widget)) break
        let i = 0
        while (i < widgets.length && widgets[i].rank < iter.value.rank) i++
        widgets.splice(i, 0, iter.value)
        walker.widgets(widgets, active)
      }
    } else {
      let i = 0
      while (i < active.length && active[i].rank < iter.value.rank) i++
      active.splice(i, 0, iter.value as Decoration)
      let to = (iter.to << 1) + (iter.endOrder < 0 ? 0 : 1)
      activeTo.splice(i, 0, to)
      nextActiveEnd = Math.min(nextActiveEnd, to)
      iter.next()
    }
  }

  let after = pos.nodeAfter
  if (after) widgets(after!.tag, WidgetPlace.Before)
  else widgets(pos.parent.node.tag, WidgetPlace.End)

  return pos
}
