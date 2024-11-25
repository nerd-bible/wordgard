import {ChangeDesc, MapMode} from "@willows/doc"

// FIXME see what features we don't use

/// Each span is associated with a label, which must inherit from
/// this class.
export abstract class SpanLabel {
  /// Compare this label with another label. Used when comparing
  /// spansets. The default implementation compares by identity.
  /// Unless you are only creating a fixed number of unique instances
  /// of your label type, it is a good idea to implement this
  /// properly.
  eq(other: SpanLabel) { return this == other }
  /// The bias value at the start of the span. Determines how the
  /// span is positioned relative to other spans starting at this
  /// position. Defaults to 0.
  get startSide() { return 0 }
  /// The bias value at the end of the span. Defaults to 0.
  get endSide() { return 0 }

  /// The mode with which the location of the span should be mapped
  /// when its `from` and `to` are the same, to decide whether a
  /// change deletes the span. Defaults to `MapMode.TrackDel`.
  get mapMode() { return MapMode.TrackDel } // FIXME see if this is necessary
  /// Determines whether this label marks a point span. Regular
  /// spans affect the part of the document they cover, and are
  /// meaningless when empty. Point spans have a meaning on their
  /// own. When non-empty, a point span is treated as atomic and
  /// shadows any spans contained in it.
  get point() { return false }

  /// Create a [span](#state.Span) with this label.
  span(from: number, to = from) { return Span.create(from, to, this) }
}

/// A span associates a label with a range of positions.
export class Span<T extends SpanLabel> {
  private constructor(
    /// The span's start position.
    readonly from: number,
    /// Its end position.
    readonly to: number,
    /// The label associated with this span.
    readonly label: T) {}

  /// @internal
  static create<T extends SpanLabel>(from: number, to: number, label: T) {
    return new Span<T>(from, to, label)
  }
}

function cmpSpan<T extends SpanLabel>(a: Span<T>, b: Span<T>) {
  return a.from - b.from || a.label.startSide - b.label.startSide
}

/// Collection of methods used when comparing span sets.
export interface SpanComparator<T extends SpanLabel> {
  /// Notifies the comparator that a span (in positions in the new
  /// document) has the given sets of labels associated with it, which
  /// are different in the old (A) and new (B) sets.
  compareSpan(from: number, to: number, activeA: T[], activeB: T[]): void
  /// Notification for a changed (or inserted, or deleted) point span.
  comparePoint(from: number, to: number, pointA: T | null, pointB: T | null): void
}

/// Methods used when iterating over the spans created by a set of
/// spans. The entire iterated span will be covered with either
/// `span` or `point` calls.
export interface SpanIterator<T extends SpanLabel> {
  /// Called for any spans not covered by point decorations. `active`
  /// holds the labels that the span is marked with (and may be
  /// empty).
  span(from: number, to: number, active: readonly T[]): void
  /// Called when going over a point decoration. The active span
  /// decorations that cover the point and have a higher precedence
  /// are provided in `active`.
  point(from: number, to: number, label: T, active: readonly T[], index: number): void
}

const enum C {
  // The maximum amount of spans to store in a single chunk
  ChunkSize = 100,
  // A large (fixnum) value to use for max/min values.
  Far = 1e9
}

class Chunk<T extends SpanLabel> {
  constructor(readonly from: readonly number[],
              readonly to: readonly number[],
              readonly label: readonly T[]) {}

  get length() { return this.to[this.to.length - 1] }

  // Find the index of the given position and side. Use the spans'
  // `from` pos when `end == false`, `to` when `end == true`.
  findIndex(pos: number, side: number, end: boolean, startAt = 0) {
    let arr = end ? this.to : this.from
    for (let lo = startAt, hi = arr.length;;) {
      if (lo == hi) return lo
      let mid = (lo + hi) >> 1
      let diff = arr[mid] - pos || (end ? this.label[mid].endSide : this.label[mid].startSide) - side
      if (mid == lo) return diff >= 0 ? lo : hi
      if (diff >= 0) hi = mid
      else lo = mid + 1
    }
  }

  between(offset: number, from: number, to: number, f: (from: number, to: number, label: T) => void | false): void | false {
    for (let i = this.findIndex(from, -C.Far, true), e = this.findIndex(to, C.Far, false, i); i < e; i++)
      if (f(this.from[i] + offset, this.to[i] + offset, this.label[i]) === false) return false
  }

  map(offset: number, changes: ChangeDesc) {
    let label: T[] = [], from = [], to = [], newPos = -1
    for (let i = 0; i < this.label.length; i++) {
      let val = this.label[i], curFrom = this.from[i] + offset, curTo = this.to[i] + offset, newFrom, newTo
      if (curFrom == curTo) {
        let mapped = changes.mapPos(curFrom, val.startSide, val.mapMode)
        if (mapped == null) continue
        newFrom = newTo = mapped
        if (val.startSide != val.endSide) {
          newTo = changes.mapPos(curFrom, val.endSide)
          if (newTo < newFrom) continue
        }
      } else {
        newFrom = changes.mapPos(curFrom, val.startSide)
        newTo = changes.mapPos(curTo, val.endSide)
        if (newFrom > newTo || newFrom == newTo && val.startSide > 0 && val.endSide <= 0) continue
      }
      if ((newTo - newFrom || val.endSide - val.startSide) < 0) continue
      if (newPos < 0) newPos = newFrom
      label.push(val)
      from.push(newFrom - newPos)
      to.push(newTo - newPos)
    }
    return {mapped: label.length ? new Chunk(from, to, label) : null, pos: newPos}
  }
}

/// A span cursor is an object that moves to the next span every
/// time you call `next` on it. Note that, unlike ES6 iterators, these
/// start out pointing at the first element, so you should call `next`
/// only after reading the first span (if any).
export interface SpanCursor<T> {
  /// Move the iterator forward.
  next: () => void
  /// The next span's label. Holds `null` when the cursor has reached
  /// its end.
  label: T | null
  /// The next span's start position.
  from: number
  /// The next end position.
  to: number
}

type SpanSetUpdate<T extends SpanLabel> = {
  /// An array of spans to add. If given, this should be sorted by
  /// `from` position and `startSide` unless
  /// [`sort`](#state.SpanSet.update^updateSpec.sort) is given as
  /// `true`.
  add?: readonly Span<T>[]
  /// Indicates whether the library should sort the spans in `add`.
  /// Defaults to `false`.
  sort?: boolean
  /// Filter the spans already in the set. Only those for which this
  /// function returns `true` are kept.
  filter?: (from: number, to: number, label: T) => boolean,
  /// Can be used to limit the rane on which the filter is applied.
  /// Filtering only a small range, as opposed to the entire set, will
  /// make updates cheaper.
  filterRange?: {from: number, to: number}
}

/// A span set stores a collection of [spans](#state.Span) in a
/// way that makes them efficient to [map](#state.SpanSet.map) and
/// [update](#state.SpanSet.update). This is an immutable data
/// structure.
export class SpanSet<T extends SpanLabel> {
  private constructor(
    /// @internal
    readonly chunkPos: readonly number[],
    /// @internal
    readonly chunk: readonly Chunk<T>[],
    /// @internal
    readonly nextLayer: SpanSet<T>
  ) {}

  /// @internal
  static create<T extends SpanLabel>(
    chunkPos: readonly number[], chunk: readonly Chunk<T>[], nextLayer: SpanSet<T>
  ) {
    return new SpanSet<T>(chunkPos, chunk, nextLayer)
  }

  /// @internal
  get length(): number {
    let last = this.chunk.length - 1
    return last < 0 ? 0 : Math.max(this.chunkEnd(last), this.nextLayer.length)
  }

  /// The number of spans in the set.
  get size(): number {
    if (this.isEmpty) return 0
    let size = this.nextLayer.size
    for (let chunk of this.chunk) size += chunk.label.length
    return size
  }

  /// @internal
  chunkEnd(index: number) {
    return this.chunkPos[index] + this.chunk[index].length
  }

  /// Update the span set, optionally adding new spans or filtering
  /// out existing ones.
  ///
  /// (Note: The type parameter is just there as a kludge to work
  /// around TypeScript variance issues that prevented `SpanSet<X>`
  /// from being a subtype of `SpanSet<Y>` when `X` is a subtype of
  /// `Y`.)
  update<U extends T>(updateSpec: SpanSetUpdate<U>): SpanSet<T> {
    let {add = [], sort = false, filterRange} = updateSpec
    let filterFrom = filterRange ? filterRange.from : 0, filterTo = filterRange ? filterRange.to : this.length
    let filter = updateSpec.filter as undefined | ((from: number, to: number, label: T) => boolean)
    if (add.length == 0 && !filter) return this
    if (sort) add = add.slice().sort(cmpSpan)
    if (this.isEmpty) return add.length ? SpanSet.of(add) : this

    let cur = new LayerCursor(this, null).goto(0), i = 0, spill: Span<T>[] = []
    let builder = new SpanSetBuilder<T>()
    while (cur.label || i < add.length) {
      if (i < add.length && (cur.from - add[i].from || cur.startSide - add[i].label.startSide) >= 0) {
        let span = add[i++]
        if (!builder.addInner(span.from, span.to, span.label)) spill.push(span)
      } else if (cur.spanIndex == 1 && cur.chunkIndex < this.chunk.length &&
                 (i == add.length || this.chunkEnd(cur.chunkIndex) < add[i].from) &&
                 (!filter || filterFrom > this.chunkEnd(cur.chunkIndex) || filterTo < this.chunkPos[cur.chunkIndex]) &&
                 builder.addChunk(this.chunkPos[cur.chunkIndex], this.chunk[cur.chunkIndex])) {
        cur.nextChunk()
      } else {
        if (!filter || filterFrom > cur.to || filterTo < cur.from || filter(cur.from, cur.to, cur.label!)) {
          if (!builder.addInner(cur.from, cur.to, cur.label!))
            spill.push(Span.create(cur.from, cur.to, cur.label!))
        }
        cur.next()
      }
    }

    return builder.finishInner(this.nextLayer.isEmpty && !spill.length ? SpanSet.empty
                               : this.nextLayer.update<T>({add: spill, filter, filterRange}))
  }

  /// Map this span set through a set of changes, return the new set.
  map(changes: ChangeDesc): SpanSet<T> {
    if (changes.empty || this.isEmpty) return this

    let chunks = [], chunkPos = []
    for (let i = 0; i < this.chunk.length; i++) {
      let start = this.chunkPos[i], chunk = this.chunk[i]
      let touch = changes.touchesRange(start, start + chunk.length)
      if (touch === false) {
        chunks.push(chunk)
        chunkPos.push(changes.mapPos(start))
      } else if (touch === true) {
        let {mapped, pos} = chunk.map(start, changes)
        if (mapped) {
          chunks.push(mapped)
          chunkPos.push(pos)
        }
      }
    }
    let next = this.nextLayer.map(changes)
    return chunks.length == 0 ? next : new SpanSet(chunkPos, chunks, next || SpanSet.empty)
  }

  /// Iterate over the spans that touch the region `from` to `to`,
  /// calling `f` for each. There is no guarantee that the spans will
  /// be reported in any specific order. When the callback returns
  /// `false`, iteration stops.
  between(from: number, to: number, f: (from: number, to: number, label: T) => void | false): void {
    if (this.isEmpty) return
    for (let i = 0; i < this.chunk.length; i++) {
      let start = this.chunkPos[i], chunk = this.chunk[i]
      if (to >= start && from <= start + chunk.length &&
          chunk.between(start, from - start, to - start, f) === false) return
    }
    this.nextLayer.between(from, to, f)
  }

  /// Iterate over the spans in this set, in order, including all
  /// spans that end at or after `from`.
  iter(from: number = 0): SpanCursor<T> {
    return HeapCursor.from([this]).goto(from)
  }

  /// @internal
  get isEmpty() { return this.nextLayer == this }

  /// Iterate over the spans in a collection of sets, in order,
  /// starting from `from`.
  static iter<T extends SpanLabel>(sets: readonly SpanSet<T>[], from: number = 0): SpanCursor<T> {
    return HeapCursor.from(sets).goto(from)
  }

  /// Iterate over two groups of sets, calling methods on `comparator`
  /// to notify it of possible differences.
  static compare<T extends SpanLabel>(
    oldSets: readonly SpanSet<T>[], newSets: readonly SpanSet<T>[],
    /// This indicates how the underlying document changed between
    /// these spans, and is needed to synchronize the iteration.
    changes: ChangeDesc,
    comparator: SpanComparator<T>
  ) {
    let a = oldSets.filter(set => !set.isEmpty)
    let b = newSets.filter(set => !set.isEmpty)
    let sharedChunks = findSharedChunks(a, b, changes)

    let sideA = new FragmentCursor(a, sharedChunks)
    let sideB = new FragmentCursor(b, sharedChunks)

    changes.iterGaps((fromA, fromB, length) => compare(sideA, fromA, sideB, fromB, length, comparator))
    if (changes.empty && changes.length == 0) compare(sideA, 0, sideB, 0, 0, comparator)
  }

  /// Compare the contents of two groups of span sets, returning true
  /// if they are equivalent in the given span.
  static eq<T extends SpanLabel>(
    oldSets: readonly SpanSet<T>[], newSets: readonly SpanSet<T>[],
    from = 0, to?: number
  ) {
    if (to == null) to = C.Far - 1
    let a = oldSets.filter(set => !set.isEmpty && newSets.indexOf(set) < 0)
    let b = newSets.filter(set => !set.isEmpty && oldSets.indexOf(set) < 0)
    if (a.length != b.length) return false
    if (!a.length) return true
    let sharedChunks = findSharedChunks(a, b)
    let sideA = new FragmentCursor(a, sharedChunks).goto(from), sideB = new FragmentCursor(b, sharedChunks).goto(from)
    for (;;) {
      if (sideA.to != sideB.to ||
          !sameLabels(sideA.active, sideB.active) ||
          sideA.point && (!sideB.point || !sideA.point.eq(sideB.point)))
        return false
      if (sideA.to > to) return true
      sideA.next(); sideB.next()
    }
  }

  /// Iterate over a group of span sets at the same time, notifying
  /// the iterator about the spans covering every given piece of
  /// content.
  static fragments<T extends SpanLabel>(
    sets: readonly SpanSet<T>[], from: number, to: number,
    iterator: SpanIterator<T>
  ) {
    let cursor = new FragmentCursor(sets, null).goto(from), pos = from
    for (;;) {
      let curTo = Math.min(cursor.to, to)
      if (cursor.point) {
        let active = cursor.activeForPoint(cursor.to)
        iterator.point(pos, curTo, cursor.point, active, cursor.pointRank)
      } else if (curTo > pos) {
        iterator.span(pos, curTo, cursor.active)
      }
      if (cursor.to > to) break
      pos = cursor.to
      cursor.next()
    }
  }

  /// Create a span set for the given span or array of spans. By
  /// default, this expects the spans to be _sorted_ (by start
  /// position and, if two start at the same position,
  /// `label.startSide`). You can pass `true` as second argument to
  /// cause the method to sort them.
  static of<T extends SpanLabel>(spans: readonly Span<T>[] | Span<T>, sort = false): SpanSet<T> {
    let build = new SpanSetBuilder<T>()
    for (let span of spans instanceof Span ? [spans] : sort ? lazySort(spans) : spans)
      build.add(span.from, span.to, span.label)
    return build.finish()
  }

  /// Join an array of span sets into a single set.
  static join<T extends SpanLabel>(sets: readonly SpanSet<T>[]): SpanSet<T> {
    if (!sets.length) return SpanSet.empty
    let result = sets[sets.length - 1]
    for (let i = sets.length - 2; i >= 0; i--) {
      for (let layer = sets[i]; layer != SpanSet.empty; layer = layer.nextLayer)
        result = new SpanSet(layer.chunkPos, layer.chunk, result)
    }
    return result
  }

  /// The empty set of spans.
  static empty = new SpanSet<any>([], [], null as any)
}

function lazySort<T extends SpanLabel>(spans: readonly Span<T>[]): readonly Span<T>[] {
  if (spans.length > 1) for (let prev = spans[0], i = 1; i < spans.length; i++) {
    let cur = spans[i]
    if (cmpSpan(prev, cur) > 0) return spans.slice().sort(cmpSpan)
    prev = cur
  }
  return spans
}

// Awkward patch-up to create a cyclic structure.
;(SpanSet.empty as any).nextLayer = SpanSet.empty

/// A span set builder is a data structure that helps build up a
/// [span set](#state.SpanSet) directly, without first allocating
/// an array of [`Span`](#state.Span) objects.
export class SpanSetBuilder<T extends SpanLabel> {
  private chunks: Chunk<T>[] = []
  private chunkPos: number[] = []
  private chunkStart = -1
  private last: T | null = null
  private lastFrom = -C.Far
  private lastTo = -C.Far
  private from: number[] = []
  private to: number[] = []
  private label: T[] = []
  private nextLayer: SpanSetBuilder<T> | null = null

  private finishChunk(newArrays: boolean) {
    this.chunks.push(new Chunk(this.from, this.to, this.label))
    this.chunkPos.push(this.chunkStart)
    this.chunkStart = -1
    if (newArrays) { this.from = []; this.to = []; this.label = [] }
  }

  /// Create an empty builder.
  constructor() {}

  /// Add a span. Spans should be added in sorted (by `from` and
  /// `label.startSide`) order.
  add(from: number, to: number, label: T) {
    if (!this.addInner(from, to, label))
      (this.nextLayer || (this.nextLayer = new SpanSetBuilder)).add(from, to, label)
  }

  /// @internal
  addInner(from: number, to: number, label: T) {
    let diff = from - this.lastTo || label.startSide - this.last!.endSide
    if (diff <= 0 && (from - this.lastFrom || label.startSide - this.last!.startSide) < 0)
      throw new Error("Spans must be added sorted by `from` position and `startSide`")
    if (diff < 0) return false
    if (this.from.length == C.ChunkSize) this.finishChunk(true)
    if (this.chunkStart < 0) this.chunkStart = from
    this.from.push(from - this.chunkStart)
    this.to.push(to - this.chunkStart)
    this.last = label
    this.lastFrom = from
    this.lastTo = to
    this.label.push(label)
    return true
  }

  /// @internal
  addChunk(from: number, chunk: Chunk<T>) {
    if ((from - this.lastTo || chunk.label[0].startSide - this.last!.endSide) < 0) return false
    if (this.from.length) this.finishChunk(true)
    this.chunks.push(chunk)
    this.chunkPos.push(from)
    let last = chunk.label.length - 1
    this.last = chunk.label[last]
    this.lastFrom = chunk.from[last] + from
    this.lastTo = chunk.to[last] + from
    return true
  }

  /// Finish the span set. Returns the new set. The builder can't be
  /// used anymore after this has been called.
  finish() { return this.finishInner(SpanSet.empty) }

  /// @internal
  finishInner(next: SpanSet<T>): SpanSet<T> {
    if (this.from.length) this.finishChunk(false)
    if (this.chunks.length == 0) return next
    let result = SpanSet.create(this.chunkPos, this.chunks,
                                 this.nextLayer ? this.nextLayer.finishInner(next) : next)
    this.from = null as any // Make sure further `add` calls produce errors
    return result
  }
}

function findSharedChunks(a: readonly SpanSet<any>[], b: readonly SpanSet<any>[], textDiff?: ChangeDesc) {
  let inA = new Map<Chunk<any>, number>()
  for (let set of a) for (let i = 0; i < set.chunk.length; i++)
    inA.set(set.chunk[i], set.chunkPos[i])
  let shared = new Set<Chunk<any>>()
  for (let set of b) for (let i = 0; i < set.chunk.length; i++) {
    let known = inA.get(set.chunk[i])
    if (known != null && (textDiff ? textDiff.mapPos(known) : known) == set.chunkPos[i] &&
        !textDiff?.touchesRange(known, known + set.chunk[i].length))
      shared.add(set.chunk[i])
  }
  return shared
}

class LayerCursor<T extends SpanLabel> {
  from!: number
  to!: number
  label!: T | null

  chunkIndex!: number
  spanIndex!: number

  constructor(readonly layer: SpanSet<T>,
              readonly skip: Set<Chunk<T>> | null,
              readonly rank = 0) {}

  get startSide() { return this.label ? this.label.startSide : 0 }
  get endSide() { return this.label ? this.label.endSide : 0 }

  goto(pos: number, side: number = -C.Far) {
    this.chunkIndex = this.spanIndex = 0
    this.gotoInner(pos, side, false)
    return this
  }

  gotoInner(pos: number, side: number, forward: boolean) {
    while (this.chunkIndex < this.layer.chunk.length) {
      let next = this.layer.chunk[this.chunkIndex]
      if (!(this.skip && this.skip.has(next) ||
            this.layer.chunkEnd(this.chunkIndex) < pos)) break
      this.chunkIndex++
      forward = false
    }
    if (this.chunkIndex < this.layer.chunk.length) {
      let spanIndex = this.layer.chunk[this.chunkIndex].findIndex(pos - this.layer.chunkPos[this.chunkIndex], side, true)
      if (!forward || this.spanIndex < spanIndex) this.setSpanIndex(spanIndex)
    }
    this.next()
  }

  forward(pos: number, side: number) {
    if ((this.to - pos || this.endSide - side) < 0)
      this.gotoInner(pos, side, true)
  }

  next() {
    if (this.chunkIndex == this.layer.chunk.length) {
      this.from = this.to = C.Far
      this.label = null
    } else {
      let chunkPos = this.layer.chunkPos[this.chunkIndex], chunk = this.layer.chunk[this.chunkIndex]
      let from = chunkPos + chunk.from[this.spanIndex]
      this.from = from
      this.to = chunkPos + chunk.to[this.spanIndex]
      this.label = chunk.label[this.spanIndex]
      this.setSpanIndex(this.spanIndex + 1)
    }
  }

  setSpanIndex(index: number) {
    if (index == this.layer.chunk[this.chunkIndex].label.length) {
      this.chunkIndex++
      if (this.skip) {
        while (this.chunkIndex < this.layer.chunk.length && this.skip.has(this.layer.chunk[this.chunkIndex]))
          this.chunkIndex++
      }
      this.spanIndex = 0
    } else {
      this.spanIndex = index
    }
  }

  nextChunk() {
    this.chunkIndex++
    this.spanIndex = 0
    this.next()
  }

  compare(other: LayerCursor<T>) {
    return this.from - other.from || this.startSide - other.startSide || this.rank - other.rank ||
      this.to - other.to || this.endSide - other.endSide
  }
}

class HeapCursor<T extends SpanLabel> {
  from!: number
  to!: number
  label!: T | null
  rank!: number
  
  constructor(readonly heap: LayerCursor<T>[]) {}

  static from<T extends SpanLabel>(
    sets: readonly SpanSet<T>[],
    skip: Set<Chunk<T>> | null = null
  ): HeapCursor<T> | LayerCursor<T> {
    let heap = []
    for (let i = 0; i < sets.length; i++) {
      for (let cur = sets[i]; !cur.isEmpty; cur = cur.nextLayer) {
        heap.push(new LayerCursor(cur, skip, i))
      }
    }
    return heap.length == 1 ? heap[0] : new HeapCursor(heap)
  }

  get startSide() { return this.label ? this.label.startSide : 0 }

  goto(pos: number, side: number = -C.Far) {
    for (let cur of this.heap) cur.goto(pos, side)
    for (let i = this.heap.length >> 1; i >= 0; i--) heapBubble(this.heap, i)
    this.next()
    return this
  }

  forward(pos: number, side: number) {
    for (let cur of this.heap) cur.forward(pos, side)
    for (let i = this.heap.length >> 1; i >= 0; i--) heapBubble(this.heap, i)
    if ((this.to - pos || this.label!.endSide - side) < 0) this.next()
  }    

  next() {
    if (this.heap.length == 0) {
      this.from = this.to = C.Far
      this.label = null
      this.rank = -1
    } else {
      let top = this.heap[0]
      this.from = top.from
      this.to = top.to
      this.label = top.label
      this.rank = top.rank
      if (top.label) top.next()
      heapBubble(this.heap, 0)
    }
  }
}

function heapBubble<T extends SpanLabel>(heap: LayerCursor<T>[], index: number) {
  for (let cur = heap[index];;) {
    let childIndex = (index << 1) + 1
    if (childIndex >= heap.length) break
    let child = heap[childIndex]
    if (childIndex + 1 < heap.length && child.compare(heap[childIndex + 1]) >= 0) {
      child = heap[childIndex + 1]
      childIndex++
    }
    if (cur.compare(child) < 0) break
    heap[childIndex] = cur
    heap[index] = child
    index = childIndex
  }
}

class FragmentCursor<T extends SpanLabel> {
  cursor: HeapCursor<T> | LayerCursor<T>

  active: T[] = []
  activeTo: number[] = []
  activeRank: number[] = []
  minActive = -1

  // A currently active point span, if any
  point: T | null = null
  pointFrom = 0
  pointRank = 0

  to = -C.Far
  endSide = 0

  constructor(sets: readonly SpanSet<T>[],
              skip: Set<Chunk<T>> | null) {
    this.cursor = HeapCursor.from(sets, skip)
  }

  goto(pos: number, side: number = -C.Far) {
    this.cursor.goto(pos, side)
    this.active.length = this.activeTo.length = this.activeRank.length = 0
    this.minActive = -1
    this.to = pos
    this.endSide = side
    this.next()
    return this
  }

  forward(pos: number, side: number) {
    while (this.minActive > -1 && (this.activeTo[this.minActive] - pos || this.active[this.minActive].endSide - side) < 0)
      this.removeActive(this.minActive)
    this.cursor.forward(pos, side)
  }

  removeActive(index: number) {
    remove(this.active, index)
    remove(this.activeTo, index)
    remove(this.activeRank, index)
    this.minActive = findMinIndex(this.active, this.activeTo)
  }

  addActive() {
    let i = 0, {label, to, rank} = this.cursor
    // Organize active marks by rank first, then by size
    while (i < this.activeRank.length && (rank - this.activeRank[i] || to - this.activeTo[i]) > 0) i++
    insert(this.active, i, label)
    insert(this.activeTo, i, to)
    insert(this.activeRank, i, rank)
    this.minActive = findMinIndex(this.active, this.activeTo)
  }

  // After calling this, if `this.point` != null, the next span is a
  // point. Otherwise, it's a regular span, covered by `this.active`.
  next() {
    let from = this.to, wasPoint = this.point
    this.point = null
    for (;;) {
      let a = this.minActive
      if (a > -1 && (this.activeTo[a] - this.cursor.from || this.active[a].endSide - this.cursor.startSide) < 0) {
        if (this.activeTo[a] > from) {
          this.to = this.activeTo[a]
          this.endSide = this.active[a].endSide
          break
        }
        this.removeActive(a)
      } else if (!this.cursor.label) {
        this.to = this.endSide = C.Far
        break
      } else if (this.cursor.from > from) {
        this.to = this.cursor.from
        this.endSide = this.cursor.startSide
        break
      } else {
        let nextVal = this.cursor.label
        if (!nextVal.point) { // Opening a span
          this.addActive()
          this.cursor.next()
        } else if (wasPoint && this.cursor.to == this.to && this.cursor.from < this.cursor.to) {
          // Ignore any non-empty points that end precisely at the end of the prev point
          this.cursor.next()
        } else { // New point
          this.point = nextVal
          this.pointFrom = this.cursor.from
          this.pointRank = this.cursor.rank
          this.to = this.cursor.to
          this.endSide = nextVal.endSide
          this.cursor.next()
          this.forward(this.to, this.endSide)
          break
        }
      }
    }
  }

  activeForPoint(to: number) {
    if (!this.active.length) return this.active
    let active = []
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.activeRank[i] < this.pointRank) break
      if (this.activeTo[i] > to || this.activeTo[i] == to && this.active[i].endSide >= this.point!.endSide)
        active.push(this.active[i])
    }
    return active.reverse()
  }
}

function compare<T extends SpanLabel>(a: FragmentCursor<T>, startA: number,
                                      b: FragmentCursor<T>, startB: number,
                                      length: number,
                                      comparator: SpanComparator<T>) {
  a.goto(startA)
  b.goto(startB)
  let endB = startB + length
  let pos = startB, dPos = startB - startA
  for (;;) {
    let diff = (a.to + dPos) - b.to || a.endSide - b.endSide
    let end = diff < 0 ? a.to + dPos : b.to, clipEnd = Math.min(end, endB)
    if (a.point || b.point) {
      if (!(a.point && b.point && (a.point == b.point || a.point.eq(b.point)) &&
            sameLabels(a.activeForPoint(a.to), b.activeForPoint(b.to))))
        comparator.comparePoint(pos, clipEnd, a.point, b.point)
    } else {
      if (clipEnd > pos && !sameLabels(a.active, b.active)) comparator.compareSpan(pos, clipEnd, a.active, b.active)
    }
    if (end > endB) break
    pos = end
    if (diff <= 0) a.next()
    if (diff >= 0) b.next()
  }
}

function sameLabels<T extends SpanLabel>(a: T[], b: T[]) {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] != b[i] && !a[i].eq(b[i])) return false
  return true
}

function remove<T>(array: T[], index: number) {
  for (let i = index, e = array.length - 1; i < e; i++) array[i] = array[i + 1]
  array.pop()
}

function insert<T>(array: T[], index: number, label: T) {
  for (let i = array.length - 1; i >= index; i--) array[i + 1] = array[i]
  array[index] = label
}

function findMinIndex(label: SpanLabel[], array: number[]) {
  let found = -1, foundPos = C.Far
  for (let i = 0; i < array.length; i++)
    if ((array[i] - foundPos || label[i].endSide - label[found].endSide) < 0) {
    found = i
    foundPos = array[i]
  }
  return found
}
