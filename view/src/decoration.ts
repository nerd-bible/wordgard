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
    this.widget = typeof widget == "function" ? widget : () => widget
    this.extension = decorations.of(this)
  }
}

export class TagDecorationSource {
  tag: (tag: Tag) => boolean
  deco: (tag: Tag) => Decoration | null
  extension: Extension

  constructor(config: {
    tag?: TagSelector,
    deco: Decoration | ((tag: Tag) => Decoration | null)
  }) {
    let {tag, deco} = config
    this.tag = tagPredicate(tag)
    this.deco = typeof deco == "function" ? deco : () => deco
    this.extension = decorations.of(this)
  }
}

export class RangeDecorationSource<T> {
  tag: (tag: Tag) => boolean
  ranges: (state: EditorState) => RangeSet<T>
  deco: (value: T) => Decoration
  extension: Extension

  constructor(config: {
    tag?: TagSelector,
    ranges: (state: EditorState) => RangeSet<T>
  } & (T extends Decoration ? {} : {deco: (value: T) => Decoration})) {
    this.tag = tagPredicate(config.tag)
    this.ranges = config.ranges
    this.deco = (config as any).deco || (d => d)
    this.extension = decorations.of(this)
  }
}

export class WidgetSource<T> {
  // FIXME names
  widgets: (state: EditorState) => PointSet<T>
  widget: (value: T) => Widget
  extension: Extension

  constructor(config: {
    widgets: (state: EditorState) => PointSet<T>,
  } & (T extends Widget ? {} : {widget: (value: T) => Widget})) {
    this.widgets = config.widgets
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

export class PointSet<Value> {
  private constructor(readonly positions: readonly number[],
                      readonly values: readonly Value[],
                      readonly side: number) {}

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

  static create<Value>(positions: readonly number[], values: readonly Value[], side: number = 0) {
    return new PointSet(positions, values, side)
  }

  static builder<Value>() { return new PointBuilder<Value>() }
}

export class PointBuilder<Value> {
  positions: number[] = []
  values: Value[] = []

  add(pos: number, value: Value) {
    this.positions.push(pos)
    this.values.push(value)
  }

  finish(side = 0) { return PointSet.create(this.positions, this.values, side) }
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

  add(from: number, to: number, value: Value) {
    this.from.push(from)
    this.to.push(to)
    this.values.push(value)
  }

  finish(startSide: number = 1, endSide: number = -1) {
    return RangeSet.create<Value>(this.from, this.to, this.values, startSide, endSide)
  }
}

export interface DecoWalker {
  skip(node: Node, deco: readonly Decoration[]): void
  enter(tag: Tag, deco: readonly Decoration[]): void | boolean
  leave(): void
  widgets(widgets: readonly Widget[], deco: readonly Decoration[]): void
}

export function iterateDeco(pos: Pos, deco: readonly DecorationSource[], from: number, to: number, walker: DecoWalker) {
  let active: readonly Decoration[] = []
  let wrap: Walker = {
    skip(node) { walker.skip(node, active) },
    enter(tag) { walker.enter(tag, active) },
    leave() { walker.leave() }
  }
  SpanSet.fragments(deco, from, to, {
    point(from, to, label, active) {
      if (label instanceof Widget) walker.widget(label, active as Decoration[])
      pos = pos.advance(to - from)
    },
    fragment(from, to, local) {
      active = local as Decoration[]
      pos = pos.walk(to - from, wrap)
    }
  })
  return pos
}
