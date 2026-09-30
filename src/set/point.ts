import {ChangeSet} from "wordgard/doc"
import {findAbove, heapSink, heapBubble, heapPop, addReplacements} from "./util"

const enum ChunkSize { Max = 512 }

class Chunk<T extends PointSet.Value> {
  constructor(
    readonly start: number,
    readonly pos: number[],
    readonly value: T[]
  ) {}

  get end() {
    return this.start + this.pos[this.pos.length - 1]
  }

  get startSide() { 
    return this.value[0].side
  }

  get endSide() {
    return this.value[this.value.length - 1].side
  }

  move(start: number) {
    return start == this.start ? this : new Chunk(start, this.pos, this.value)
  }
}

class SetBuilder<T extends PointSet.Value> {
  chunks: Chunk<T>[] = []
  lastPos = -1
  lastSide = -1

  addChunk(chunk: Chunk<T>) {
    this.chunks.push(chunk)
    this.lastPos = chunk.end
    this.lastSide = chunk.endSide
  }

  add(source: PointSet.Source<T>, pre?: (pos: number, value: T) => void) {
    if (typeof source != "function") {
      let array = source
      source = add => { for (let [pos, value] of array) add(pos, value) }
    }
    source((pos, value) => {
      if (pre) pre(pos, value)
      this.addPoint(pos, value)
    })
  }

  addPoint(pos: number, value: T) {
    let chunk: Chunk<T> | undefined
    if (this.chunks.length) {
      chunk = this.chunks[this.chunks.length - 1]
      if (chunk.value.length >= ChunkSize.Max) chunk = undefined
    }
    if (!chunk) {
      this.chunks.push(chunk = new Chunk(pos, [], []))
    }
    chunk.pos.push(pos - chunk.start)
    chunk.value.push(value)
    if ((pos - this.lastPos || value.side || this.lastSide) >= 0) {
      this.lastPos = pos
      this.lastSide = value.side
    } else {
      // Move down until sorted
      for (let i = chunk.value.length - 1, chunkI = this.chunks.length - 1;;) {
        let nextI = i - 1, nextChunk: Chunk<T> = chunk
        if (nextI < 0) {
          if (!chunkI) break
          nextChunk = this.chunks[--chunkI]
          nextI = nextChunk.value.length - 1
        }
        if ((pos - nextChunk.pos[nextI] || value.side - nextChunk.value[nextI].side) >= 0) break
        chunk.pos[i] = nextChunk.pos[nextI]
        chunk.value[i] = nextChunk.value[nextI]
        nextChunk.pos[nextI] = pos
        nextChunk.value[nextI] = value
        i = nextI
        chunk = nextChunk
      }
    }
  }

  finish(): PointSet<T> {
    return this.chunks.length ? new PointSet(this.chunks) : PointSet.empty
  }
}

export class PointSet<T extends PointSet.Value> {
  constructor(readonly chunks: readonly Chunk<T>[]) {}

  static create<T extends PointSet.Value>(
    source: PointSet.Source<T>
  ): PointSet<T> {
    let build = new SetBuilder<T>()
    build.add(source, (from, value) => {
      if ((from - build.lastPos || value.side - build.lastSide) < 0)
        throw new Error("Points must be added in order")
    })
    return build.finish()
  }

  get length(): number {
    return this.chunks.length ? this.chunks[this.chunks.length - 1].end : 0
  }

  get empty() {
    return this == PointSet.empty
  }

  cursor(from = 0): PointSet.Cursor<T> {
    return new PointCursor(this.chunks, from)
  }

  map(map: ChangeSet, replace: readonly PointSet.Replacement<T>[] = []) {
    let {sections} = map
    if (replace.length) sections = addReplacements(map, replace)
    else if (map.empty) return this
    return this.mapInner(sections, map, replace)
  }

  /// @internal
  mapInner(sections: ChangeSet.Sections, map: ChangeSet, replace: readonly PointSet.Replacement<T>[]): PointSet<T> {
    let cursor = new PointCursor(this.chunks, 0)
    let replI = 0, posA = 0, posB = 0
    let build = new SetBuilder<T>()
    for (let i = 0; i < sections.length;) {
      let len = sections[i++], ins = sections[i++]
      if (ins < 0) {
        while (i < sections.length && sections[i + 1] < 0) {
          len += sections[i]
          i += 2
        }
        let upto = i == sections.length ? 1e9 : posA + len, off = posB - posA
        // Unchanged range. Copy over ranges and chunks entirely inside.
        while (cursor.cur) {
          let chunk = cursor.cur
          if (cursor.rangeI == 0 && chunk.end < upto) {
            build.addChunk(chunk.move(chunk.start + off))
            cursor.next(true)
          } else if (cursor.pos < upto) {
            build.addPoint(cursor.pos + off, cursor.value!)
            cursor.next()
          } else {
            break
          }
        }
        posB += len
      } else {
        // Iterate over replacements in this change's range, copy over
        // mapped version of ranges covering its start and end before
        // and after.
        let replStartI = replI, endB = posB + ins
        copyMappedUpto(cursor, posA, map, build, replace, replStartI)
        while (replI < replace.length && replace[replI].from < endB) {
          let repl = replace[replI++]
          if (repl.add) build.add(repl.add)
        }
        if (len) cursor.goto(posA + len)
        copyMappedUpto(cursor, posA + len, map, build, replace, replStartI)
        posB = endB
      }
      posA += len
    }
    return build.finish()
  }


  modify(spec: {
    replace?: readonly PointSet.Replacement<T>[],
    add?: PointSet.Source<T>,
    filter?: (pos: number, value: T) => boolean
  }) {
    let {replace, add, filter} = spec
    let result: PointSet<T> = this
    if (replace && replace.length) {
      result = result.map(ChangeSet.empty(Math.max(result.length, replace[replace.length - 1].to)), replace)
    }
    return add || filter ? result.modifyInner(add, filter) : result
  }

  modifyInner(add: PointSet.Source<T> | undefined, filter?: (pos: number, value: T) => boolean): PointSet<T> {
    let build = new SetBuilder<T>()
    let cursor = new PointCursor(this.chunks, 0)
    let advance = (pos: number) => {
      for (;;) {
        let {cur} = cursor
        if (!cur) return
        if (cursor.rangeI == 0 && cur.end <= pos && !filter) {
          build.addChunk(cur)
          cursor.next(true)
        } else if (cursor.pos >= pos) {
          break
        } else {
          if (!filter || filter(cursor.pos, cursor.value!))
            build.addPoint(cursor.pos, cursor.value!)
          cursor.next()
        }
      }
    }
    if (add) build.add(add, advance)
    advance(1e9)
    return build.finish()
  }

  compareRange(fromA: number, b: PointSet<T>, fromB: number, len: number, change: (pos: number) => void) {
    if (this == b) return
    let curA = new PointCursor(this.chunks, fromA), curB = new PointCursor(b.chunks, fromB)
    let off = fromB - fromA, endB = fromB + len, reported = -1
    for (;;) {
      let nextA = curA.value ? curA.pos + off : 1e9, nextB = curB.value ? curB.pos : 1e9
      if (Math.min(nextA, nextB) > endB) break
      let cmp = nextA - nextB || curA.side - curB.side
      if (cmp == 0 && curA.cur!.value == curB.cur!.value) { // Identical chunk. Skip
        curA.next(true)
        curB.next(true)
      } else if (cmp == 0 && curA.value!.eq(curB.value!)) {
        curA.next()
        curB.next()
      } else if (cmp < 0) {
        if (reported < nextA) change(reported = nextA)
        curA.next()
      } else {
        if (reported < nextB) change(reported = nextB)
        curB.next()
      }
    }
  }

  static empty = new PointSet<any>([])
}

function copyMappedUpto<T extends PointSet.Value>(
  cursor: PointSet.Cursor<T>, upto: number,
  map: ChangeSet, build: SetBuilder<T>,
  replace: readonly PointSet.Replacement<T>[], replI: number
) {
  while (cursor.value && cursor.pos <= upto) {
    let value = cursor.value
    let pos = map.mapPos(cursor.pos, value.side < 0 ? -1 : 1, value.trackMode)
    if (pos != null) {
      let filtered = false
      for (let i = replI; !filtered && i < replace.length && replace[i].from <= pos; i++) {
        if (replace[i].to >= pos) filtered = true
      }
      if (!filtered) build.addPoint(pos, value)
    }
    cursor.next()
  }
}

class PointCursor<T extends PointSet.Value> implements PointSet.Cursor<T> {
  chunkI = 0
  rangeI = 0

  declare cur: Chunk<T> | null
  pos = -1
  declare value: T | null

  constructor(readonly chunks: readonly Chunk<T>[], start: number) {
    this.goto(start)
  }

  get side() { return this.value ? this.value.side : 1e8 }

  goto(pos: number) {
    let {chunks} = this
    if (pos <= this.pos) this.chunkI = this.rangeI = 0
    for (;; this.chunkI++, this.rangeI = 0) {
      if (this.chunkI == chunks.length) {
        this.pos = 1e9
        this.cur = this.value = null
        return
      }
      if (this.chunks[this.chunkI].end >= pos) break
    }
    let chunk = this.cur = chunks[this.chunkI]
    let i = this.rangeI = findAbove(chunk.pos, this.rangeI, pos - chunk.start - 1)
    this.pos = chunk.pos[i] + chunk.start
    this.value = chunk.value[i]
  }

  next(chunk?: boolean) {
    let {cur} = this
    if (!cur) return
    if (!chunk && this.rangeI < cur.value.length - 1) {
      this.rangeI++
    } else {
      this.chunkI++
      this.rangeI = 0
      if (this.chunkI == this.chunks.length) {
        this.value = this.cur = null
        return
      } else {
        cur = this.cur = this.chunks[this.chunkI]
      }
    }
    this.pos = cur.pos[this.rangeI] + cur.start
    this.value = cur.value[this.rangeI]
  }
}

let cmpCursor = (a: PointSet.Cursor<PointSet.Value>, b: PointSet.Cursor<PointSet.Value>): number => {
  return a.pos - b.pos || a.value!.side - b.value!.side
}

export class HeapCursor<T extends PointSet.Value> implements PointSet.Cursor<T> {
  heap: PointSet.Cursor<T>[] = []
  declare pos: number
  declare value: T | null

  constructor(readonly cursors: readonly PointSet.Cursor<T>[]) {
    for (let cur of cursors) if (cur.value) {
      this.heap.push(cur)
      heapSink(this.heap, this.heap.length - 1, cmpCursor)
    }
    this.fill()
  }

  get side() {
    return this.value ? this.value.side : 1e9
  }

  fill() {
    if (this.heap.length) {
      ;({pos: this.pos, value: this.value} = this.heap[0])
    } else {
      this.pos = 1e9
      this.value = null
    }
  }

  goto(pos: number) {
    this.heap = []
    for (let cur of this.cursors) {
      cur.goto(pos)
      if (cur.value) {
        this.heap.push(cur)
        heapSink(this.heap, this.heap.length - 1, cmpCursor)
      }
    }
  }

  next() {
    if (this.heap.length) {
      this.heap[0].next()
      if (this.heap[0].value) heapBubble(this.heap, 0, cmpCursor)
      else heapPop(this.heap, cmpCursor)
      this.fill()
    }
  }
}

export namespace PointSet {
  /// Objects stored in a point set must conform to this interface.
  export interface Value {
    /// The side of the point. Used to provide a sorting of points at
    /// the same position, and to determine cursor position relative to
    /// the points. Points with side < 0 are always displayed before a
    /// cursor at their position, those with side > 0 always after, and
    /// those with side == 0 before or after depending on the cursor's
    /// side.
    side: number
    /// Configures whether the point should be deleted when content next
    /// to it is deleted. See {@link ChangeSet.mapPos}.
    trackMode: ChangeSet.TrackMode | undefined
    /// Method to compare this value to another.
    eq(other: Value): boolean
  }

  export type Source<T extends Value> = Iterable<[number, T]> | ((add: (pos: number, value: T) => void) => void)

  export type Replacement<T extends Value> = {
    from: number,
    to: number,
    add?: PointSet.Source<T>
  }

  export interface Cursor<T extends Value> {
    pos: number
    side: number
    value: T | null
    goto(pos: number): void
    next(): void
  }
}
