import {GardState, Facet, GardSelection} from "wordgard/state"
import {Mark, Pos, Plot, Leaf, Node, ChangeSet, MapMode, Schema, Elt, Attributes} from "wordgard/doc"
import {Attrs, attrsEq} from "./attributes"
import {type Wordgard} from "./editorview"

export class Widget<T = unknown> {
  readonly type: Widget.Type<unknown extends T ? any : Widget.Type<T>>

  constructor(type: Widget.Type<T>, readonly value: T) { this.type = type as any }

  eq(other: any) {
    return other instanceof Widget && other.type == this.type && this.type.eq(this.value as any, other.value)
  }

  static define<T>(spec: Widget.Spec<T>) {
    return new Widget.Type(spec)
  }

  static create(spec: Widget.Spec<null>) {
    return new Widget.Type<null>(spec).of(null)
  }

  get hasContent() { return false }
}

export namespace Widget {
  export type Spec<T> = {
    render: (value: T) => Element | Text
    eq?: (a: T, b: T) => boolean
    destroy?: (value: T) => void
    handleEvent?: (event: Event, view: Wordgard) => boolean
  }

  export class Type<T> {
    render: (value: T) => Element | Text
    eq: (a: T, b: T) => boolean
    handleEvent: (event: Event, view: Wordgard) => boolean
    destroy: (value: T) => void

    constructor(spec: Widget.Spec<T>) {
      this.render = spec.render
      this.eq = spec.eq || ((a, b) => a === b)
      this.handleEvent = spec.handleEvent || (() => false)
      this.destroy = spec.destroy || (() => {})
    }

    of(value: T) { return new Widget(this, value) }
  }

  export const Text = Widget.define<string>({
    render: s => document.createTextNode(s)
  })

  export const EditableText = Widget.define<string>({
    render: s => document.createTextNode(s)
  })
}

export type DecoElt = Elt<Widget | string>

export type Shape = Widget | DecoElt

// FIXME support some kind of dependency tracking on decoration
// sources

enum WidgetPlace { Before, After, Start, End }

export function tagShape(spec: {
  tag: Node.Type<any> | Node.Tag,
  shape: Shape | ((tag: Node.Tag) => Shape),
  atom?: boolean
}): GardState.Extension {
  let {tag, shape, atom} = spec, shapeFunc: (tag: Node.Tag) => Shape
  let type = tag instanceof Node.Type.Base ? tag : tag.type
  if (typeof shape == "function") {
    if (atom == null) {
      if (type.isLeaf) atom = true
      else throw new Error("Dynamic tag shapes must provide an 'atom' field")
    }
    shapeFunc = tag => addMarkAttributes(shape(tag), tag)
  } else {
    if (atom == null) atom = !shape.hasContent
    else if (atom != !shape.hasContent) throw new Error("'atom' and 'shape' field disagree on atomicity")
    shapeFunc = tag => addMarkAttributes(shape, tag)
  }
  if (atom != type.isAtom) throw new Error("Tag shape atomiticy must match the tag type")
  return new TagShape(type, memo(shapeFunc))
}

class TagShape {
  extension: GardState.Extension

  constructor(readonly type: Node.Type<any>,
              readonly shape: (tag: Node.Tag) => Shape) {
    this.extension = tagShapes.of(this)
  }
}

const tagShapes = Facet.define<TagShape>()

export type WrapperSpec = {
  element: string
  attributes?: Attrs | ((param: Node.Tag) => Attrs)
  rank?: number
  spanning?: boolean
}

export type AttributeSpec = {
  attribute: string
  value: string | ((param: Node.Tag) => string)
}

export type WidgetSpec = {
  widget: Widget | ((param: Node.Tag) => Widget)
  place: keyof typeof WidgetPlace | WidgetPlace
}

export function tagDecoration(spec: {query: Node.Query} &
  (WrapperSpec | AttributeSpec | WidgetSpec)): GardState.Extension {
  if ("element" in spec) {
    return new TagWrapperSource(spec.query, spec)
  } else if ("widget" in spec) {
    return new TagWidgetSource(spec.query, spec)
  } else {
    return new TagAttributeSource(spec.query, spec)
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
  let attrs: readonly string[] | undefined
  for (let mark of tag.marks) {
    if (mark.type.attribute && (mark.spanning || !tag.isText)) {
      let {get, target} = mark.type.attribute
      let markAttrs = get(mark.value)
      if (markAttrs.length) {
        if (target && shape instanceof Elt) shape = shape.addAttrs(markAttrs, target)
        else attrs = attrs ? Attributes.merge(attrs, markAttrs) : markAttrs
      }
    }
  }
  return attrs ? addAttrs(shape, attrs, tag.isInline) : shape
}

function addAttrs(shape: Shape, attrs: Attributes, inline: boolean) {
  return shape instanceof Elt ? shape.addAttrs(attrs) : Elt.new(inline ? "span" : "div", attrs, [shape])
}

function applyDeco(shape: Shape, deco: Decoration, tag: Node.Tag) {
  if (deco instanceof AttributeDecoration) {
    let attrs: Attributes = [deco.attribute, deco.value]
    return deco.selector && shape instanceof Elt ? shape.addAttrs(attrs, deco.selector) : addAttrs(shape, attrs, tag.isInline)
  } else if (deco instanceof WrapperDecoration) {
    return deco.selector && shape instanceof Elt ? shape.wrap(deco.elt, deco.selector) : deco.elt.fill([shape])
  }
  return shape
}

const baseTagShape = memo((tag: Node.Tag): Shape => {
  return addMarkAttributes(tag.is(Leaf.Text) ? Widget.EditableText.of(tag.param as string)
    : tag.type.shape.create(tag.param), tag)
})

class TagWidgetSource {
  place: WidgetPlace
  widget: (tag: Node.Tag) => Widget
  extension: GardState.Extension

  constructor(readonly query: Node.Query, deco: WidgetSpec) {
    let {place, widget} = deco
    this.place = typeof place == "string" ? WidgetPlace[place] : place
    this.widget = typeof widget == "function" ? memo(widget) : () => widget
    this.extension = tagWidgets.of(this)
  }
}

export const tagWidgets = Facet.define<TagWidgetSource>()

export class TagWrapperSource {
  wrapper: (tag: Node.Tag) => DecoElt
  rank: number
  spanning: boolean
  extension: GardState.Extension

  constructor(readonly query: Node.Query, deco: WrapperSpec) {
    const {element, attributes, rank, spanning} = deco
    if (typeof attributes != "function") {
      let elt = Elt.new(element, Attributes.read(attributes), Elt.hole)
      this.wrapper = () => elt
    } else {
      this.wrapper = memo(tag => Elt.new(deco.element, Attributes.read(attributes(tag)), Elt.hole))
    }
    this.rank = rank ?? 50
    this.spanning = !!spanning
    this.extension = tagWrappers.of(this)
  }
}

export const tagWrappers = Facet.define<TagWrapperSource>()

export class TagAttributeSource {
  attribute: string
  value: string | ((tag: Node.Tag) => string)
  extension: GardState.Extension

  constructor(readonly query: Node.Query, deco: AttributeSpec) {
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

const enum Inc { None = 0, Start = 1, End = 2 }

// FIXME Data parameter worth it?
export abstract class RangeDecoration<Data = unknown> implements RangeSet.Value {
  readonly query: Node.Query | null
  readonly scope: DecorationScope
  readonly inc: Inc

  constructor(spec: RangeDecoration.Spec, readonly data: Data) {
    let {query, inclusive} = spec
    this.query = query || null
    this.scope = spec.scope ?? DecorationScope.Atom
    this.inc = inclusive === "start" ? Inc.Start : inclusive === "end" ? Inc.End : inclusive ? Inc.Start | Inc.End : Inc.None
  }

  get inclusiveStart() { return (this.inc & Inc.Start) > 0 }
  get inclusiveEnd() { return (this.inc & Inc.End) > 0 }

  abstract eq(other: RangeSet.Value): boolean

  static wrapper(spec: RangeDecoration.Spec & WrapperSpec): RangeDecoration<undefined>
  static wrapper<Data>(spec: RangeDecoration.Spec & WrapperSpec & {data: Data}): RangeDecoration<Data>
  static wrapper<Data>(spec: RangeDecoration.Spec & WrapperSpec & {data?: Data}): RangeDecoration<Data> {
    return new WrapperRangeDecoration<Data>(spec, spec.data!)
  }

  static attribute(spec: RangeDecoration.Spec & AttributeSpec): RangeDecoration<undefined>
  static attribute<Data>(spec: RangeDecoration.Spec & AttributeSpec & {data: Data}): RangeDecoration<Data>
  static attribute<Data>(spec: RangeDecoration.Spec & AttributeSpec & {data?: Data}): RangeDecoration<Data> {
    return new AttributeRangeDecoration<Data>(spec, spec.data!)
  }
}

export namespace RangeDecoration {
  export type Spec = {
    inclusive?: boolean | "start" | "end"
    scope?: DecorationScope
    query?: Node.Query
  }

  export const source = Facet.define<(state: GardState) => RangeSet<RangeDecoration>>()
}

class AttributeRangeDecoration<Data> extends RangeDecoration<Data> {
  readonly attribute: string
  readonly value: string | ((tag: Node.Tag) => string)

  constructor(readonly spec: RangeDecoration.Spec & AttributeSpec, data: Data) {
    super(spec, data)
    this.attribute = spec.attribute
    this.value = spec.value
  }

  eq(other: RangeSet.Value): boolean {
    return this == other ||
      other instanceof AttributeRangeDecoration && other.attribute == this.attribute && other.value == this.value &&
      other.inc == this.inc && other.data === this.data
  }
}

class WrapperRangeDecoration<Data> extends RangeDecoration<Data> {
  readonly elt: (tag: Node.Tag) => Elt
  readonly element: string
  readonly attrs: Attrs | ((tag: Node.Tag) => Attrs) | null
  readonly rank: number
  readonly spanning: boolean

  constructor(spec: RangeDecoration.Spec & WrapperSpec, data: Data) {
    super(spec, data)
    let {element, attributes} = spec
    this.element = element
    this.attrs = attributes || null
    this.rank = spec.rank || 0
    this.spanning = spec.spanning !== false
    if (typeof attributes == "function") {
      this.elt = tag => Elt.new(element, Attributes.read(attributes(tag)), Elt.hole)
    } else {
      let elt = Elt.new(element, Attributes.read(attributes), Elt.hole)
      this.elt = () => elt
    }
  }

  eq(other: RangeSet.Value): boolean {
    return this == other ||
      other instanceof WrapperRangeDecoration && other.element == this.element &&
      (typeof this.attrs == "function" || typeof other.attrs == "function" ? this.attrs == other.attrs :
        attrsEq(other.attrs, this.attrs)) &&
      other.rank == this.rank && other.spanning == this.spanning && other.inc == this.inc && other.data == this.data
  }
}

// FIXME support value parameter?
export abstract class Decoration implements PointSet.Value {
  abstract eq(other: PointSet.Value): boolean
  abstract side: number
  abstract mapMode: MapMode

  static widget(widget: Widget, spec?: {side?: number, mapMode?: MapMode}) {
    return new WidgetDecoration(widget, spec?.side || 0, spec?.mapMode ?? MapMode.TrackDel)
  }

  static attribute(attribute: string, value: string, spec?: {target?: string}) {
    return new AttributeDecoration(attribute, value, spec?.target ? Elt.Selector.parse(spec.target) : null)
  }

  static shape(shape: Shape) {
    return new ShapeDecoration(shape)
  }

  static wrapper(wrapper: DecoElt, spec?: {target?: string}) {
    if (!wrapper.hasContent) throw new Error("Wrapper decoration elements must have a content hole")
    return new WrapperDecoration(wrapper, spec?.target ? Elt.Selector.parse(spec.target) : null)
  }

  static source = Facet.define<(state: GardState) => PointSet<Decoration>>({
    combine: sources => sources.concat(nodeSelection)
  })
}

class ShapeDecoration extends Decoration {
  constructor(readonly shape: Shape) { super() }

  eq(other: PointSet.Value): boolean {
    return this == other || other instanceof ShapeDecoration && other.shape.eq(this.shape)
  }

  get mapMode() { return MapMode.TrackAfter }
  get side() { return 1e9 }
}

class WidgetDecoration extends Decoration {
  constructor(readonly widget: Widget, readonly side: number, readonly mapMode: MapMode) {
    super()
    if (side >= 1e9) throw new Error("Invalid widget side")
  }

  eq(other: PointSet.Value): boolean {
    return this == other || other instanceof WidgetDecoration && other.widget.eq(this.widget) &&
      other.side == this.side && other.mapMode == this.mapMode
  }
}

class AttributeDecoration extends Decoration {
  constructor(readonly attribute: string, readonly value: string, readonly selector: Elt.Selector | null) { super() }

  eq(other: PointSet.Value): boolean {
    return this == other || other instanceof AttributeDecoration && other.attribute == this.attribute &&
      other.value == this.value && other.selector == this.selector
  }

  get mapMode() { return MapMode.TrackAfter }
  get side() { return 1e9 }
}

class WrapperDecoration extends Decoration {
  constructor(readonly elt: DecoElt, readonly selector: Elt.Selector | null) { super() }

  eq(other: PointSet.Value): boolean {
    return this == other || other instanceof WrapperDecoration && other.elt.eq(this.elt) && other.selector == this.selector
  }

  get mapMode() { return MapMode.TrackAfter }
  get side() { return 1e9 }
}

const nodeSelectionDeco = Decoration.attribute("class", "wg-selected-node")

function nodeSelection(state: GardState) {
  if (state.selection instanceof GardSelection.Node) {
    let {node, from} = state.selection
    if (node.isLeaf && node.type.isSelectable) return PointSet.create([[from, nodeSelectionDeco]])
  }
  return PointSet.empty
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

const none: readonly any[] = []

export class PointSet<Value extends PointSet.Value = PointSet.Value> {
  constructor(readonly positions: readonly number[],
              readonly values: readonly Value[]) {}

  get length() { return this.positions.length }

  map(changes: ChangeSet) {
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
    }, (_fromA, toA) => {
      let nextI = findAbove(positions, i, toA + 1)
      for (; i < nextI; i++) {
        let mapped = changes.mapPos(positions[i], this.values[i].side < 0 ? -1 : 1, this.values[i].mapMode)
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
      let cmp = nextA - nextB || this.values[a].side - other.values[b].side
      if (cmp < 0) {
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

  compareRange(fromA: number, b: PointSet<Value>, fromB: number, len: number, change: (pos: number, val: Value) => void) {
    let a = this, endB = fromB + len
    if (a != b || fromA != fromB) {
      let iA = findAbove(a.positions, 0, fromA - 1), lA = a.positions.length
      let iB = findAbove(b.positions, 0, fromB - 1), lB = b.positions.length
      let off = fromB - fromA
      let sameVal = a.values == b.values
      for (;;) {
        let nextA = iA < lA ? a.positions[iA] + off : 1e9
        let nextB = iB < lB ? b.positions[iB] : 1e9
        let next = Math.min(nextA, nextB)
        if (next > endB) break
        if (nextA == nextB) {
          if (!sameVal && !a.values[iA].eq(b.values[iB])) change(next, a.values[iA])
          iA++
          iB++
        } else if (nextA < nextB) {
          change(nextA, a.values[iA++])
        } else {
          change(nextB, b.values[iB++])
        }
      }
    }
  }

  iter<Source>(): PointIterator<Value> {
    return new PointIterator<Value>(this)
  }

  at(pos: number): Value | undefined {
    let index = findAbove(this.positions, 0, pos - 1)
    return index < this.positions.length && this.positions[index] == pos ? this.values[index] : undefined
  }

  static create<Value extends PointSet.Value>(
    source: Iterable<[number, Value]> | ((add: (pos: number, value: Value) => void) => void)
  ): PointSet<Value> {
    if (typeof source != "function") {
      let array = source
      source = add => { for (let [pos, value] of array) add(pos, value) }
    }
    let positions: number[] = [], values: Value[] = [], curPos = -1, curVal: Value | undefined
    source((pos: number, value: Value) => {
      if (curPos > pos || curPos == pos && curVal!.side > value.side) {
        for (let i = positions.length;;) {
          positions[i] = positions[i - 1]
          values[i] = values[i - 1]
          if (--i < 0) break
          if (!i-- || (positions[i] - pos || values[i].side - value.side) <= 0) {
            positions[i] = pos
            values[i] = value
            break
          }
        }
      } else {
        positions.push(pos)
        values.push(value)
        curPos = pos
        curVal = value
      }
    })
    return new PointSet(positions, values)
  }

  static empty: PointSet<any> = new PointSet(none, none)
}

export namespace PointSet {
  export interface Value {
    side: number
    mapMode: MapMode
    eq(other: PointSet.Value): boolean
  }
}

export class PointIterator<Value extends PointSet.Value> {
  declare value: Value | null
  done = false
  declare pos: number
  declare i: number

  constructor(readonly set: PointSet<Value>) {
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
    return this.done ? 1 : this.value!.side
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

export type DecoSet = {points: Map<(state: GardState) => PointSet<Decoration>, PointSet<Decoration>>,
                       ranges: Map<(state: GardState) => RangeSet<RangeDecoration>, RangeSet<RangeDecoration>>}

export function getDecoSet(state: GardState) {
  let set: DecoSet = {points: new Map, ranges: new Map}
  for (let src of state.facet(Decoration.source)) set.points.set(src, src(state))
  for (let src of state.facet(RangeDecoration.source)) set.ranges.set(src, src(state))
  return set
}

export class RangeSet<Value extends RangeSet.Value = RangeSet.Value> {
  constructor(
    readonly from: readonly number[],
    readonly to: readonly number[],
    readonly values: readonly Value[],
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
    }, (_fromA, toA) => {
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

  iter(): RangeIterator<Value> {
    return new RangeIterator<Value>(this)
  }

  compareRange(fromA: number, b: RangeSet<Value>, fromB: number, len: number, change: (from: number, to: number) => void) {
    let a = this, toB = fromB + len
    if (a != b || fromA != fromB) {
      let iA = findAbove(a.from, 0, fromA - 1), lA = a.from.length
      let iB = findAbove(b.from, 0, fromB - 1), lB = b.from.length
      let off = fromB - fromA
      let sameVals = a.values == b.values
      for (;;) {
        let [startA, endA] = iA < lA ? [a.from[iA] + off, a.to[iA] + off] : [1e9, 1e9]
        let [startB, endB] = iB < lB ? [b.from[iB], b.to[iB]] : [1e9, 1e9]
        let start = Math.min(startA, startB)
        if (start > toB) break
        if (startA == startB) {
          if (endA != endB || !sameVals && !a.values[iA].eq(b.values[iB])) change(start, Math.max(endA, endB))
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

  static create<Value extends RangeSet.Value>(
    source: Iterable<[number, number, Value]> | ((add: (from: number, to: number, value: Value) => void) => void)
  ): RangeSet<Value> {
    if (typeof source != "function") {
      let array = source
      source = add => { for (let [from, to, value] of array) add(from, to, value) }
    }
    let from: number[] = [], to: number[] = [], values: Value[] = [], curPos = -1
    source((f, t, value) => {
      if (f >= t) throw new Error("Ranges cannot be empty")
      if (f < curPos) throw new Error("Ranges must be added in order and cannot overlap")
      from.push(f)
      to.push(t)
      values.push(value)
    })
    return new RangeSet<Value>(from, to, values)
  }

  static empty: RangeSet<any> = new RangeSet(none, none, none)
}

export namespace RangeSet {
  export interface Value {
    inclusiveStart: boolean
    inclusiveEnd: boolean
    eq(other: Value): boolean
  }
}

export class RangeIterator<Value extends RangeSet.Value> {
  declare value: Value | null
  declare from: number
  declare to: number
  done = false
  declare i: number

  constructor(readonly set: RangeSet<Value>) {
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

function compareDecoSet<T>(setA: Map<(state: GardState) => T, T>, setB: Map<(state: GardState) => T, T>,
                           cmp: (a: T | null, b: T | null) => void) {
  for (let [srcA, valA] of setA) cmp(valA, setB.get(srcA) || null)
  for (let [srcB, valB] of setB) if (!setA.has(srcB)) cmp(null, valB)
}

function compareGlobal(stateA: GardState, stateB: GardState, facet: Facet<any>) {
  return stateA.facet(facet) != stateB.facet(facet)
}

// Compare ranges and points in decoration facets for unchanged ranges
// in the given change desc. Returns an array using the section format
// used in change descs.
export function findChangedRanges(prevState: GardState, prevDeco: DecoSet,
                                  state: GardState, deco: DecoSet,
                                  sections: ChangeSet.Sections) {
  let result: number[] = []
  let globalChange = compareGlobal(prevState, state, tagShapes) || compareGlobal(prevState, state, tagWidgets) ||
    compareGlobal(prevState, state, tagWrappers) || compareGlobal(prevState, state, tagAttributes)
  // When node shapes change, we need a separate pass to see whether
  // their atomicity changed, and mark a replace for the whole node if
  // it did.
  let shapeChanges: number[] = []
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
      compareDecoSet(prevDeco.ranges, deco.ranges, (a, b) => {
        (a || RangeSet.empty).compareRange(posA, b || RangeSet.empty, posB, len, add)
      })
      compareDecoSet(prevDeco.points, deco.points, (a, b) => {
        (a || PointSet.empty).compareRange(posA, b || PointSet.empty, posB, len, (pos, val) => {
          add(pos, pos + 1)
          if (val instanceof ShapeDecoration) {
            if (!globalChange) shapeChanges.push(pos)
          }
        })
      })
      let joined = joinRanges(ranges), pos = posB, end = pos + len
      for (let i = 0; i < joined.length;) {
        let from = Math.max(pos, joined[i++]), to = Math.min(end, joined[i++])
        if (from > pos) addSection(result, from - pos, -1)
        if (from < to) addSection(result, to - from, -2)
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
  if (shapeChanges.length) return addAtomicityChanges(result, prevState, shapeChanges)
  return result
}

function addAtomicityChanges(
  sections: number[],
  prev: GardState,
  changes: number[]
): ChangeSet.Sections {
  let added: number[] = []
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
    added.push(posA, posA + node.length)
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
  widget(widget: Widget, side: number): void
}

class HeapIterator<R extends RangeSet.Value, P extends PointSet.Value> {
  active: RangeIterator<R>[] = []
  from: number
  to: number
  point: PointIterator<P> | null = null
  done = false

  constructor(readonly rangeHeap: RangeIterator<R>[],
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
        ? [rangeHeap[0].from, rangeHeap[0].value!.inclusiveStart ? -1 : 1]
        : [1e9, 0]
      let [endPos, endSide] = active.length ? [active[0].to, active[0].value!.inclusiveEnd ? 1 : -1] : [1e9, 0]
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
    let parent = (index - 1) >> 1
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

function cmpBool(a: boolean, b: boolean) {
  return a ? (b ? 0 : 1) : (b ? -1 : 0)
}

function cmpRangeFrom(a: RangeIterator<RangeSet.Value>, b: RangeIterator<RangeSet.Value>) {
  return a.from - b.from || cmpBool(b.value!.inclusiveStart, a.value!.inclusiveStart)
}

function cmpRangeTo(a: RangeIterator<RangeSet.Value>, b: RangeIterator<RangeSet.Value>) {
  return a.to - b.to || cmpBool(a.value!.inclusiveEnd, b.value!.inclusiveEnd)
}

function cmpPoint(a: PointIterator<PointSet.Value>, b: PointIterator<PointSet.Value>) {
  return a.pos - b.pos || a.side - b.side
}

export type WrapperSource = Mark<any> | TagWrapperSource | WrapperRangeDecoration<any>

// Enumerate all wrapper elements for a given node. Spanning wrappers
// are always moved to the front of the result. Within the
// spanning/non-spanning wrappers, the ordering is determined by rank.
//
// Note that the return value contains range iterators, and those will
// become invalid as soon as they are advanced further.
function nodeWrappers(
  schema: Schema,
  tag: Node.Tag,
  active: readonly RangeIterator<RangeDecoration<any>>[],
  global: readonly TagWrapperSource[],
  atom: boolean
): readonly WrapperSource[] {
  let wrappers: WrapperSource[] | undefined

  for (let mark of tag.marks) if (mark.type.element) (wrappers || (wrappers = [])).push(mark)
  for (let src of global) if (schema.matchNode(tag.type, src.query)) (wrappers || (wrappers = [])).push(src)
  if (active.length) {
    for (let cur of active) {
      let val = cur.value!
      if (val instanceof WrapperRangeDecoration && (tagScope(tag, atom) & val.scope) &&
          (!val.query || schema.matchNode(tag.type, val.query)))
        (wrappers || (wrappers = [])).push(val)
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
  if (src instanceof WrapperRangeDecoration) return src.elt(tag)
  return renderMarkWrapper(src)
}

export const renderMarkWrapper = memo((mark: Mark<any>) => {
  let shape = mark.type.element!
  return Elt.new<never>(shape.name, shape.attrs(mark.value), Elt.hole)
})

export class DecoIterator {
  globalWidgets: readonly TagWidgetSource[]
  globalWrappers: readonly TagWrapperSource[]
  globalAttrs: readonly TagAttributeSource[]
  schema: Schema
  tagShapes: readonly TagShape[]
  pos: Pos
  rangeIter: RangeIterator<RangeDecoration>[] = []
  pointIter: PointIterator<Decoration>[] = []

  constructor(readonly state: GardState, readonly decoSet: DecoSet) {
    this.globalWidgets = state.facet(tagWidgets)
    this.globalWrappers = state.facet(tagWrappers)
    this.globalAttrs = state.facet(tagAttributes)
    this.tagShapes = state.facet(tagShapes)
    this.pos = state.doc.resolve(0)
    this.schema = state.doc.schema
    for (let s of state.facet(RangeDecoration.source)) {
      let set = decoSet.ranges.get(s)
      if (set?.length) this.rangeIter.push(set.iter())
    }
    for (let s of state.facet(Decoration.source)) {
      let set = decoSet.points.get(s)
      if (set?.length) this.pointIter.push(set.iter())
    }
  }

  widgets(tag: Node.Tag, place: WidgetPlace, walker: DecoWalker) {
    for (let src of this.globalWidgets) {
      if (src.place == place && this.schema.matchNode(tag.type, src.query)) {
        let widget = src.widget(tag)
        if (widget) walker.widget(widget, place == WidgetPlace.Before || place == WidgetPlace.End ? 1 : -1)
      }
    }
  }

  walk(from: number, inclusiveStart: boolean, to: number, walker: DecoWalker) {
    for (let i of this.rangeIter) i.goto(from)
    for (let i of this.pointIter) i.goto(inclusiveStart ? from : from + 1)
    let iter = new HeapIterator<RangeDecoration, Decoration>(
      this.rangeIter.filter(i => !i.done), this.pointIter.filter(i => !i.done), from, to)
    let pos = this.pos.advance(from - this.pos.pos), started = inclusiveStart

    // Track points that may apply to the node at the start of the next range
    let pendingDeco: Decoration[] = [], pendingPos = -1
    let pendingShape: ShapeDecoration | null = null, pendingShapeSet: PointSet | null = null

    let wrap: Pos.Walker = {
      skip: (node, pos) => { // Only done for leaf nodes.
        if (started) this.widgets(node.tag, WidgetPlace.Before, walker)
        else started = true
        let hasPending = pendingPos == pos && !node.isText
        let shape = hasPending && pendingShape ? pendingShape.shape : this.tagShape(node.tag, iter.active)
        if (hasPending) for (let deco of pendingDeco) shape = applyDeco(shape, deco, node.tag)
        if (shape.hasContent) throw new Error("Leaf nodes shapes shouldn't have a content hole")
        walker.node(node, shape, nodeWrappers(this.schema, node.tag, iter.active, this.globalWrappers, true))
        this.widgets(node.tag, WidgetPlace.After, walker)
      },
      enterPlot: (node, pos) => {
        if (started) this.widgets(node.tag, WidgetPlace.Before, walker)
        else started = true
        let shape = pendingShape && pendingPos == pos ? pendingShape.shape : this.tagShape(node.tag, iter.active)
        if (pendingPos == pos) for (let deco of pendingDeco) shape = applyDeco(shape, deco, node.tag)
        let wrappers = nodeWrappers(this.schema, node.tag, iter.active, this.globalWrappers, !shape.hasContent)
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
        let value = iter.point.value!
        if (value instanceof WidgetDecoration) {
          walker.widget(value.widget, value.side)
        } else {
          if (pendingPos < pos.pos) {
            pendingDeco.length = 0
            pendingShape = null
            pendingPos = pos.pos
          }
          if (value instanceof ShapeDecoration &&
              (!pendingShape || compareSetPrec(pendingShapeSet!, iter.point.set, this.pointIter))) {
            pendingShape = value
            pendingShapeSet = iter.point.set
          } else {
            pendingDeco.push(value)
          }
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

  tagShape(tag: Node.Tag, active: RangeIterator<RangeDecoration<any>>[]) {
    let shape
    if (!tag.is(Leaf.Text)) for (let src of this.tagShapes) if (src.type == tag.type) {
      shape = src.shape(tag)
      break
    }
    if (!shape) shape = baseTagShape(tag)
    let add: string[] | undefined
    for (let src of this.globalAttrs) {
      if (this.schema.matchNode(tag.type, src.query))
        Attributes.push(add || (add = []), src.attribute, typeof src.value == "function" ? src.value(tag) : src.value)
    }
    let scope = tagScope(tag, !shape.hasContent)
    for (let iter of active) {
      let deco = iter.value!
      if (deco instanceof AttributeRangeDecoration && (scope & deco.scope) &&
          (!deco.query || this.schema.matchNode(tag.type, deco.query)))
        Attributes.push(add || (add = []), deco.attribute, typeof deco.value == "function" ? deco.value(tag) : deco.value)
    }
    if (add) {
      if (shape instanceof Elt) shape = Elt.new(shape.tagName, Attributes.merge(shape.attrs, add), shape.children)
      else shape = Elt.new(tag.isBlock ? "div" : "span", add, [shape])
    }
    return shape
  }
}

function compareSetPrec(setA: PointSet, setB: PointSet, array: readonly PointIterator<PointSet.Value>[]) {
   if (setA != setB) for (let i of array) {
     if (i.set == setA) return -1
     if (i.set == setB) return 1
  }
  return 0
}
