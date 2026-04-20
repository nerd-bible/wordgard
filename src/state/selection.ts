import {Schema, Plot, Node, Leaf, ChangeSet, Mark, Pos, ValidationError} from "wordgard/doc"
import {findClusterBreak} from "@marijn/find-cluster-break"
import {TextblockMap} from "./textblock"
import {Direction} from "./bidi"
import type {GardState, Facet} from "./state"

interface SelectionContext {
  doc: Plot.Doc
  textDirection?: (tag?: Plot.Tag.Any) => Direction
  visualCursorMotion?: boolean
}

function alwaysLTR() { return Direction.LTR }

/// An editor selection holds one or more selection ranges.
export class GardSelection {
  private constructor(
    /// The anchor of the range—the side that doesn't move when you
    /// extend it.
    readonly anchor: number,
    /// The head of the range, which is moved when the range is
    /// [extended](#state.EditorSelection.extend).
    readonly head: number,
    /// If this is a cursor that is explicitly associated with the
    /// element before or after it, this holds the side. -1 means
    /// the element before its position, 1 the element after, and 0
    /// means no association.
    readonly assoc: -1 | 0 | 1,
    /// The goal column (stored vertical offset) associated with a
    /// cursor. This is used to preserve the vertical position when
    /// moving across lines of different length.
    readonly goalColumn: number | undefined,
    /// The ranges in the selection, for selections that cover more
    /// than one range. Includes the main range.
    private _ranges: readonly {from: number, to: number}[] | undefined,
    /// A set of active marks that should be applied to content
    /// inserted at this selection (replacing the contextual marks).
    /// Used mostly for making the effect of toggling inline styles
    /// stick until something is inserted. Marks that aren't valid for
    /// the inserted content will be ignored.
    readonly marks: readonly Mark[] | undefined,
    /// The type of this selection, if there's a special type
    /// associated with it.
    readonly type: GardSelection.Type | undefined
  ) {}

  /// The lower boundary of the selected range.
  get from() { return Math.min(this.anchor, this.head) }

  /// The upper boundary of the range.
  get to() { return Math.max(this.anchor, this.head) }

  /// True when `anchor` and `head` are at the same position.
  get empty(): boolean { return this.anchor == this.head }

  /// The set of ranges covered by this selection, sorted.
  get ranges() {
    return this._ranges || (this._ranges = [{from: this.from, to: this.to}])
  }

  /// Returns true if this selection has the same head and anchor as
  /// the given selection.
  eqPos(other: GardSelection) {
    return this.anchor == other.anchor && this.head == other.head
  }

  /// Compare this selection to another selection, comparing all
  /// ranges, associativity, and marks.
  eq(other: GardSelection): boolean {
    return this.eqPos(other) && this.assoc == other.assoc &&
      this.ranges.length == other.ranges.length &&
      this.ranges.every((r, i) => r.from == other.ranges[i].from && r.to == other.ranges[i].to) &&
      this.marks == other.marks || !!(this.marks && other.marks && this.marks.length == other.marks.length &&
                                      this.marks.every((p, i) => p.eq(other.marks![i])))
  }

  /// Map a selection through a change. Used to adjust the selection
  /// position for changes.
  map(change: ChangeSet, assoc: -1 | 1 = -1): GardSelection {
    if (change.empty) return this
    if (this.type && this.type.map) return this.type.map(this, change, assoc)
    let main = GardSelection.mapRange(change, this.from, this.to, assoc)
    let ranges = this.ranges.map(r => r.from == this.from && r.to == this.to ? main
      : GardSelection.mapRange(change, r.from, r.to, assoc))
    let [anchor, head] = this.anchor < this.head ? [main.from, main.to] : [main.to, main.from]
    return GardSelection.createInner(anchor, head, this.assoc, this.goalColumn, ranges, this.marks, this.type)
  }

  /// @internal
  check(doc: Plot.Doc) {
    for (let {from, to} of this.ranges)
      if (from < 0 || to > doc.length)
        throw new RangeError(`Selection out of document range`)
  }

  /// Make sure, if this is a cursor selection, that it sits at a
  /// normal cursor position.
  normalize(state: GardState) { return normalize(state, this) }

  /// @internal
  resolve(doc: Plot.Doc) { return new GardSelection.Resolved(doc, this) }

  /// Convert this selection to an object that can be serialized to
  /// JSON.
  toJSON(): GardSelection.JSON {
    let result: GardSelection.JSON = {anchor: this.anchor}
    if (!this.empty) result.head = this.head
    if (this.ranges.length > 1) result.ranges = this.ranges
    if (this.assoc) result.assoc = this.assoc
    if (this.marks) {
      result.marks = {}
      for (let mark of this.marks) result.marks[mark.name] = mark.value
    }
    return result
  }

  /// Create a selection from a JSON representation.
  static fromJSON(config: GardState.Configuration, schema: Schema, json: GardSelection.JSON): GardSelection {
    if (!json || typeof json.anchor != "number")
      throw new ValidationError("Invalid JSON representation for EditorSelection")
    let anchor = json.anchor, head = typeof json.head == "number" ? json.head : anchor
    let marks = json.marks ? schema.marksFromJSON(json.marks) : undefined
    let ranges = Array.isArray(json.ranges) && json.ranges.every(r => typeof r.from == "number" && typeof r.to == "number")
    let type = json.type ? config.staticFacet(GardSelection.Type.source).find(t => t.name == json.type) : undefined
    return GardSelection.createInner(anchor, head, typeof json.assoc == "number" ? json.assoc : 0, undefined,
                                     ranges ? json.ranges! : undefined, marks, type)
  }

  /// Create a cursor selection range at the given position. You can
  /// safely ignore the optional arguments in most situations.
  static cursor(pos: number, assoc: -1 | 0 | 1 = 0, goalColumn?: number, marks?: readonly Mark<any>[]) {
    return GardSelection.createInner(pos, pos, assoc, goalColumn, undefined, marks)
  }

  /// Create a range selection.
  static range(anchor: number, head: number, assoc?: -1 | 0 | 1, goalColumn?: number, marks?: readonly Mark<any>[]) {
    if (assoc == null) assoc = head < anchor ? 1 : head > anchor ? -1 : 0
    return GardSelection.createInner(anchor, head, assoc, goalColumn, undefined, marks)
  }

  private static createInner(anchor: number, head: number, assoc: -1 | 0 | 1 = 0, goalColumn?: number,
                             ranges?: readonly {from: number, to: number}[], marks?: readonly Mark<any>[],
                             type?: GardSelection.Type) {
    if (anchor != head && !assoc) assoc = head < anchor ? 1 : -1
    return new GardSelection(anchor, head, assoc, goalColumn, ranges, marks, type)
  }

  /// Create a selection.
  static create(spec: GardSelection.Spec) {
    let {anchor, head = anchor} = spec
    if (spec.ranges && !spec.ranges.some(r => r.from == Math.min(anchor, head) && r.to == Math.max(anchor, head)))
      throw new RangeError("When given, ranges must include the main range")
    return GardSelection.createInner(anchor, head, spec.assoc, spec.goalColumn, spec.ranges, spec.marks, spec.type)
  }

  /// Find the next normal cursor position after or before this selection's
  /// head.
  nextNormalCursor(state: GardState, forward = true): GardSelection | null {
    let found = scanNormalFrom(state, this.head, this.assoc || (forward ? 1 : -1), forward, true)
    return found && GardSelection.cursor(found.pos, found.assoc)
  }

  /// Get a normal cursor at the start or end of this selection.
  normalCursorAtBound(state: GardState, forward = true): GardSelection | null {
    let found = scanNormalFrom(state, forward ? this.to : this.from, forward ? -1 : 1, forward, false)
    return found && GardSelection.cursor(found.pos, found.assoc)
  }

  /// Move across one word starting from this selection's head.
  skipWord(state: GardState, forward = true): GardSelection | null {
    let found = skipWord(state, this.head, this.assoc || -1, forward)
    return found && GardSelection.cursor(found.pos, found.assoc)
  }

  /// Find a normal selection near the given position.
  static near(state: GardState, pos: number, bias: -1 | 1 = 1) { return selectionNear(state, pos, bias) }

  /// Find a normal selection at the start of the document.
  static atStart(state: GardState) { return selectionAtStart(state) }

  /// Find a normal selection at the end of the document.
  static atEnd(state: GardState) {
    let found = state.doc.inlineContent
      ? TextblockMap.get(0, state.doc, state.textDirection()).visualTextblockSide(false)
      : scanNormalFrom(state, state.doc.length, -1, false, false) ?? {pos: state.doc.length, assoc: -1}
    return GardSelection.cursor(found.pos, found.assoc)
  }

  /// @internal
  static mapRange(change: ChangeSet, from: number, to: number, assoc = -1) {
    if (from == to) {
      let pos = change.mapPos(from, assoc)
      return {from: pos, to: pos}
    } else {
      from = change.mapPos(from, 1)
      return {from, to: Math.max(from, change.mapPos(to, -1))}
    }
  }
}

export namespace GardSelection {
  /// The representation of a selection when serialized to JSON.
  export type JSON = {
    anchor: number
    head?: number
    assoc?: -1 | 0 | 1,
    ranges?: readonly {from: number, to: number}[]
    marks?: Record<string, any>,
    type?: string
  }

  /// A description of an editor selection.
  export type Spec = {
    /// The anchor point of the selection. This is the side that doesn't
    /// move when extending the selection (for example by moving the
    /// cursor while holding shift).
    anchor: number
    /// The moving side of the selection. This will default to `anchor`
    /// when not given.
    head?: number
    /// The side of the head position that the selection is associated
    /// with, if any. `-1` points at the element before the position,
    /// `1` at the element after. This is only meaningful for
    /// empty/cursor selections. It will influence where the cursor is
    /// drawn.
    assoc?: -1 | 0 | 1
    /// Associates a horizontal position with this selection for use
    /// during vertical cursor motion.
    goalColumn?: number
    /// For selections that cover multiple ranges in the document, you
    /// can specify the ranges. Must include the main range
    /// (`anchor`/`head`) if provided. These must be non-overlapping,
    /// and sorted.
    ranges?: readonly {from: number, to: number}[]
    /// Marks associated with a cursor selection, which will determine
    /// the marks of inline content inserted at that selection. This is
    /// used for things like toggling emphasis on a cursor selection.
    marks?: readonly Mark<any>[]
    type?: GardSelection.Type
  }

  /// A selection object where the selection positions have been
  /// [resolved](#doc.DocNode.resolve). This is derived from the
  /// regular, canonical selection, for convenience.
  export class Resolved {
    /// The selection anchor.
    anchor: Pos
    /// The head of the selection.
    head: Pos

    private _ranges: readonly {from: Pos, to: Pos}[] | null = null

    constructor(readonly doc: Plot.Doc,
                /// The original selection.
                readonly selection: GardSelection) {
      this.anchor = doc.resolve(selection.anchor)
      this.head = selection.empty ? this.anchor : doc.resolve(selection.head)
    }

    /// The lower bound of the selection.
    get from() { return this.anchor.pos < this.head.pos ? this.anchor : this.head }
    /// The upper bound of the selection.
    get to() { return this.anchor.pos > this.head.pos ? this.anchor : this.head }

    get ranges() {
      return this._ranges || (this._ranges = this.resolveRanges())
    }

    private resolveRanges(): readonly {from: Pos, to: Pos}[] {
      return this.selection.ranges.map(({from, to}) => ({from: this.doc.resolve(from), to: this.doc.resolve(to)}))
    }

    /// True when the selection is empty (a cursor).
    get empty() { return this.selection.empty }
    /// If a cursor is explicitly associated with the element before or
    /// after it, this holds a non-zero value.
    get assoc() { return this.selection.assoc }
    /// [Active marks](#state.EditorSelection.marks) on this selection.
    get marks() { return this.selection.marks }

    /// If the selection's main range covers precisely one node, you can
    /// find that node here.
    get node(): Node | null {
      let {from, to} = this
      if (from.inText || to.inText || from.parent.start != to.parent.start || from.index != to.index - 1) return null
      return this.from.nodeAfter
    }
  }

  export class Type {
    extension: GardState.Extension

    constructor(
      readonly name: string,
      readonly map?: (sel: GardSelection, change: ChangeSet, assoc: -1 | 1) => GardSelection
    ) {
      this.extension = GardSelection.Type.source.of(this)
    }

    static define(name: string, config: {
      map?: (sel: GardSelection, change: ChangeSet, assoc: -1 | 1) => GardSelection
    } = {}) {
      return new GardSelection.Type(name, config.map)
    }

    /// @internal
    declare static source: Facet<GardSelection.Type>
  }
}

export function normalize(cx: SelectionContext, selection: GardSelection) {
  if (!selection.empty) return selection
  let pos = cx.doc.resolve(selection.head)
  if (pos.parent.node.isTextblock) return selection
  let normal = selectionNear(cx, selection.head, selection.assoc || -1)
  if (normal == null || normal.head == selection.head) return selection
  return GardSelection.cursor(normal.head, normal.assoc, selection.goalColumn ?? undefined, selection.marks)
}

export function selectionNear(cx: SelectionContext, pos: number, bias: -1 | 1) {
  let norm = scanNormalFrom(cx, pos, bias, bias > 0, false) ??
    scanNormalFrom(cx, pos, -bias as -1 | 1, bias < 0, false) ??
    {pos: pos, assoc: -1}
  return GardSelection.cursor(norm.pos, norm.assoc)
}

export function selectionAtStart(cx: SelectionContext) {
  let found = cx.doc.inlineContent
    ? TextblockMap.get(0, cx.doc, (cx.textDirection ?? alwaysLTR)(cx.doc.tag)).visualTextblockSide(true)
    : scanNormalFrom(cx, 0, 1, true, false) ?? {pos: 0, assoc: 1}
  return GardSelection.cursor(found.pos, found.assoc)
}

function isBarrier(node: Node) {
  if (node.isLeaf) return node.isBlock
  let override = node.type.spec.cursorBarrier
  if (override != null) return override
  return node.type.isolating || node.type.preserveWhitespace ||
    node.isBlock && node.type.isAtom
}

// Find the next 'normal' cursor position from the given position. Any
// inline position not inside a surrogate pair, unicode cluster, or
// atomic node counts as a normal position. Positions between a block
// node that counts as a barrier and another such block node, or the
// end/start of the document, also count as normal positions.
function scanNormalFrom(
  cx: SelectionContext, from: number, assoc: -1 | 1, forward: boolean, mustMove: boolean
): {pos: number, assoc: -1 | 1} | null {
  let dir = cx.textDirection ?? alwaysLTR, visualOrder = cx.visualCursorMotion !== false
  let pos = cx.doc.resolve(from), pastBarrier = false
  if (pos.parent.node.inlineContent) {
    if (!mustMove) return {pos: pos.pos, assoc: assoc < 0 ? -1 : 1}
    let block = pos.textblockParent!
    let map = TextblockMap.get(block.start, block.node, dir(block.node.tag))
    let next = visualOrder ? map.moveVisually(pos.pos, assoc, forward) : map.moveLogically(pos.pos, forward)
    if (next != null) return next
    if (!block.parent) return null
    pos = new Pos(block.parent, forward ? block.after : block.before, block.index + (forward ? 1 : 0), 0)
    pastBarrier = isBarrier(block.node)
  } else {
    pastBarrier = !pos.parent.parent && pos.index == (forward ? 0 : pos.parent.node.content.length)
    for (let {parent: {node}, index} = pos; !pastBarrier && (forward ? index : index < node.content.length);) {
      let next = node.content[forward ? index - 1 : index]
      if (isBarrier(next)) pastBarrier = true
      if (next.isLeaf) {
        index += forward ? 1 : -1
      } else {
        if (next.inlineContent) break
        node = next
        index = forward ? next.content.length : 0
      }
    }
  }

  let bottom = pos.pos, step = forward ? 1 : -1
  for (let {parent, index} = pos, p = pos.pos;;) {
    let {node, parent: next} = parent
    if (node.inlineContent) {
      if (visualOrder) return TextblockMap.get(parent.start, parent.node, dir(parent.node.tag)).visualTextblockSide(forward)
      return {pos: p, assoc: forward ? 1 : -1}
    }
    if (index == (forward ? node.content.length : 0)) {
      let barrier = !next || isBarrier(node)
      if ((bottom != from || !mustMove) && pastBarrier && barrier) return {pos: bottom, assoc: forward ? -1 : 1}
      if (!next) return null
      index = parent.index + (forward ? 1 : 0)
      parent = next
      p += step
      bottom = p
      if (barrier) pastBarrier = true
    } else {
      let nextNode = node.content[index - (forward ? 0 : 1)]
      let barrier = isBarrier(nextNode)
      if (pastBarrier && (bottom != from || !mustMove) && barrier) return {pos: bottom, assoc: forward ? -1 : 1}
      if (nextNode.isLeaf || nextNode.type.isAtom) {
        index += step
        p += nextNode.length * step
      } else {
        if (!forward) index--
        parent = new Pos.Plot(parent, nextNode, forward ? p : p - nextNode.length, index)
        p += step
        index = forward ? 0 : nextNode.content.length
      }
      if (barrier) { pastBarrier = true; bottom = p }
    }
  }
}

function skipWord(cx: SelectionContext, start: number, assoc: -1 | 1, forward: boolean) {
  let last: {pos: number, assoc: -1 | 1} | null = null
  for (let pos = start, visually = cx.visualCursorMotion !== false;;) {
    let block = cx.doc.resolve(pos).textblockParent
    if (!block) {
      let next = scanNormalFrom(cx, pos, assoc, forward, true)
      if (!next) return last
      ;({pos, assoc} = next)
    } else {
      let map = TextblockMap.get(block.start, block.node, (cx.textDirection ?? alwaysLTR)(block.node.tag))
      let next = map.skipWord(pos, assoc, forward, visually)
      if (next) return next
      if (!block.parent) return last
      let end: {pos: number, assoc: -1 | 1} = visually ? map.visualTextblockSide(!forward)
        : forward ? {pos: block.end, assoc: -1} : {pos: block.start, assoc: 1}
      if (end.pos != start) last = end
      pos = forward ? block.after : block.before
    }
  }
}

export function wordAt(state: GardState, pos: number, bias: -1 | 1) {
  let res = state.doc.resolve(pos)
  if (!res.parent.node.inlineContent) return GardSelection.cursor(pos, bias)
  let start = pos, end = pos, text = ""
  scanBack: for (let i = res.index, cur = res.nodeBefore; cur;) {
    if (!cur.is(Leaf.Text)) break
    for (let j = cur.length; j > 0;) {
      let next = findClusterBreak(cur.param, j, false)
      let ch = cur.param.slice(next, j)
      if (!/\p{L}|\p{N}/u.test(ch)) break scanBack
      text = ch + text
      start -= (j - next)
      j = next
    }
    if (!i) break
    cur = res.parent.node.content[--i]
  }
  scanForward: for (let i = res.index + 1, cur = res.nodeAfter; cur;) {
    if (!cur.is(Leaf.Text)) break
    for (let j = 0; j < cur.length;) {
      let next = findClusterBreak(cur.param, j, true)
      let ch = cur.param.slice(j, next)
      if (!/\p{L}|\p{N}/u.test(ch)) break scanForward
      text += ch
      end += (next - j)
      j = next
    }
    if (i == res.parent.node.content.length) break
    cur = res.parent.node.content[i++]
  }
  if (!(Intl as any).Segmenter) return GardSelection.range(start, end)
  let best: any = null, local = pos - start
  for (let segment of new (Intl as any).Segmenter(undefined, {granularity: "word"}).segment(text)) {
    if (segment.isWordLike && segment.index <= local && segment.index + segment.segment.length >= local && (!best || bias > 0))
      best = segment
  }
  return best ? GardSelection.range(start + best.index, start + best.index + best.segment.length) : GardSelection.cursor(pos, bias)
}
