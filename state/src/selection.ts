import {Schema, DocNode, Node, Tag, ChangeDesc, Prop, Pos, NodePos} from "@wordgard/doc"
import {findClusterBreak} from "@marijn/find-cluster-break"
import {TextblockMap} from "./textblock"
import {Direction} from "./bidi"
import {EditorState} from "./state"

export type SelectionJSON = {
  anchor: number
  head?: number
  assoc?: number
  ranges?: readonly {from: number, to: number}[]
  props?: Record<string, any>
}

export type SelectionSpec = {
  anchor: number
  head?: number
  assoc?: number
  goalColumn?: number
  ranges?: readonly {from: number, to: number}[]
  props?: readonly Prop<any>[]
}

export class SelectionPos {
  anchor: Pos
  head: Pos

  constructor(doc: DocNode, readonly selection: EditorSelection) {
    this.anchor = doc.resolve(selection.anchor)
    this.head = selection.empty ? this.anchor : doc.resolve(selection.head)
  }

  get from() { return this.anchor.pos < this.head.pos ? this.anchor : this.head }
  get to() { return this.anchor.pos > this.head.pos ? this.anchor : this.head }

  get empty() { return this.selection.empty }
  get assoc() { return this.selection.assoc } 
  get props() { return this.selection.props }
}

export interface SelectionContext {
  doc: DocNode
  textDirection?: (tag?: Tag) => Direction
  visualCursorMotion?: boolean
  isAtom?: (pos: number, node?: Node) => boolean
}

function isAtom(cx: SelectionContext, pos: number, node: Node) {
  return cx.isAtom ? cx.isAtom(pos, node) : node.type.shape.atom
}

function alwaysLTR() { return Direction.LTR }

/// An editor selection holds one or more selection ranges.
export class EditorSelection {
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
    /// A set of active props that should be applied to content
    /// inserted at this selection (replacing the contextual props).
    /// Used mostly for making the effect of toggling inline styles
    /// stick until something is inserted. Props that aren't valid for
    /// the inserted content will be ignored.
    readonly props: readonly Prop[] | undefined
  ) {}

  /// The lower boundary of the selected range.
  get from() { return Math.min(this.anchor, this.head) }

  /// The upper boundary of the range.
  get to() { return Math.max(this.anchor, this.head) }

  /// True when `anchor` and `head` are at the same position.
  get empty(): boolean { return this.anchor == this.head }

  get ranges() {
    return this._ranges || (this._ranges = [{from: this.from, to: this.to}])
  }

  /// Extend this selection to cover at least `from` to `to`.
  extend(from: number, to: number = from) {
    let {head, anchor} = this
    if (from <= this.anchor && to >= this.anchor) {
      anchor = from
      head = to
    } else {
      head = Math.abs(from - this.anchor) > Math.abs(to - this.anchor) ? from : to
    }
    return EditorSelection.createInner(anchor, head, 0, this.goalColumn)
  }

  eqPos(other: EditorSelection) {
    return this.anchor == other.anchor && this.head == other.head
  }

  /// Compare this range to another range.
  eq(other: EditorSelection): boolean {
    return this.eqPos(other) && this.assoc == other.assoc &&
      this.ranges.length == other.ranges.length &&
      this.ranges.every((r, i) => r.from == other.ranges[i].from && r.to == other.ranges[i].to) &&
      this.props == other.props || !!(this.props && other.props && this.props.length == other.props.length &&
                                      this.props.every((p, i) => p.eq(other.props![i])))
  }

  /// Map a selection through a change. Used to adjust the selection
  /// position for changes.
  map(change: ChangeDesc, assoc = -1): EditorSelection {
    if (change.empty) return this
    let main = EditorSelection.mapRange(change, this.from, this.to, assoc)
    let ranges = this.ranges.map(r => r.from == this.from && r.to == this.to ? main
      : EditorSelection.mapRange(change, r.from, r.to, assoc))
    let [anchor, head] = this.anchor < this.head ? [main.from, main.to] : [main.to, main.from]
    return EditorSelection.createInner(anchor, head, anchor == head ? this.assoc : 0, this.goalColumn, ranges, this.props)
  }

  /// @internal
  check(doc: DocNode) {
    for (let {from, to} of this.ranges)
      if (from < 0 || to > doc.length)
        throw new Error(`Selection out of document range`)
  }

  /// Make sure, if this is a cursor selection, that it sits at a
  /// normal cursor position.
  normalize(cx: SelectionContext) {
    if (!this.empty) return this
    let pos = cx.doc.resolve(this.head)
    if (pos.parent.node.isTextblock) return this
    let normal = EditorSelection.near(cx, this.head, this.assoc || -1)
    if (normal == null || normal.head == this.head) return this
    return EditorSelection.cursor(normal.head, normal.assoc, this.goalColumn ?? undefined, this.props)
  }

  resolve(doc: DocNode) { return new SelectionPos(doc, this) }

  /// Convert this selection to an object that can be serialized to
  /// JSON.
  toJSON(): SelectionJSON {
    let result: SelectionJSON = {anchor: this.anchor}
    if (!this.empty) result.head = this.head
    if (this.ranges.length > 1) result.ranges = this.ranges
    if (this.assoc) result.assoc = this.assoc
    if (this.props) {
      result.props = {}
      for (let prop of this.props) result.props[prop.name] = prop.value
    }
    return result
  }

  /// Create a selection from a JSON representation.
  static fromJSON(schema: Schema, json: SelectionJSON): EditorSelection {
    if (!json || typeof json.anchor != "number")
      throw new RangeError("Invalid JSON representation for EditorSelection")
    let anchor = json.anchor, head = typeof json.head == "number" ? json.head : anchor
    let props = json.props ? schema.propsFromJSON(json.props) : undefined
    let ranges = Array.isArray(json.ranges) && json.ranges.every(r => typeof r.from == "number" && typeof r.to == "number")
    return EditorSelection.createInner(anchor, head, typeof json.assoc == "number" ? json.assoc : 0, undefined,
                                       ranges ? json.ranges! : undefined, props)
  }

  /// Create a cursor selection range at the given position. You can
  /// safely ignore the optional arguments in most situations.
  static cursor(pos: number, assoc = 0, goalColumn?: number, props?: readonly Prop<any>[]) {
    return EditorSelection.createInner(pos, pos, assoc, goalColumn, undefined, props)
  }

  /// Create a range selection.
  static range(anchor: number, head: number, goalColumn?: number, props?: readonly Prop<any>[]) {
    return EditorSelection.createInner(anchor, head, 0, goalColumn, undefined, props)
  }

  private static createInner(anchor: number, head: number, assoc?: number, goalColumn?: number,
                             ranges?: readonly {from: number, to: number}[], props?: readonly Prop<any>[]) {
    return new EditorSelection(anchor, head, !assoc ? 0 : assoc < 0 ? -1 : 1, goalColumn, ranges, props)
  }

  /// Create a selection.
  static create(spec: SelectionSpec) {
    return EditorSelection.createInner(spec.anchor, spec.head || spec.anchor, spec.assoc, spec.goalColumn,
                                       spec.ranges, spec.props)
  }

  static nextNormalCursor(cx: EditorState): EditorSelection | null
  static nextNormalCursor(cx: SelectionContext, selection: EditorSelection): EditorSelection | null
  static nextNormalCursor(cx: SelectionContext & {selection?: EditorSelection}, selection = cx.selection!) {
    let found = scanNormalFrom(cx, selection.head, selection.assoc || -1, true, true)
    return found && EditorSelection.cursor(found.pos, found.assoc)
  }

  static prevNormalCursor(state: EditorState): EditorSelection | null
  static prevNormalCursor(cx: SelectionContext, selection: EditorSelection): EditorSelection | null
  static prevNormalCursor(cx: SelectionContext & {selection?: EditorSelection}, selection = cx.selection!) {
    let found = scanNormalFrom(cx, selection.head, selection.assoc || -1, false, true)
    return found && EditorSelection.cursor(found.pos, found.assoc)
  }

  static skipNextWord(state: EditorState): EditorSelection | null
  static skipNextWord(cx: SelectionContext, selection: EditorSelection): EditorSelection | null
  static skipNextWord(cx: SelectionContext & {selection?: EditorSelection}, selection = cx.selection!) {
    let found = skipWord(cx, selection.head, selection.assoc || -1, true)
    return found && EditorSelection.cursor(found.pos, found.assoc)
  }

  static skipPrevWord(state: EditorState): EditorSelection | null
  static skipPrevWord(cx: SelectionContext, selection: EditorSelection): EditorSelection | null
  static skipPrevWord(cx: SelectionContext & {selection?: EditorSelection}, selection = cx.selection!) {
    let found = skipWord(cx, selection.head, selection.assoc || -1, false)
    return found && EditorSelection.cursor(found.pos, found.assoc)
  }

  // FIXME provide specific docStart/docEnd helpers. This doesn't work
  // for finding the start in a single-textblock-doc bidi situation.
  static near(cx: SelectionContext, pos: number, bias: -1 | 1 = 1) {
    let norm = scanNormalFrom(cx, pos, bias, bias > 0, false)
      ?? scanNormalFrom(cx, pos, -bias as -1 | 1, bias < 0, false)!
    return EditorSelection.cursor(norm.pos, norm.assoc)
  }

  static mapRange(change: ChangeDesc, from: number, to: number, assoc = -1) {
    if (from == to) {
      let pos = change.mapPos(from, assoc)
      return {from: pos, to: pos}
    } else {
      from = change.mapPos(from, 1)
      return {from, to: Math.max(from, change.mapPos(to, -1))}
    }
  }
}

function isBarrier(cx: SelectionContext, pos: number, node: Node) {
  return node.type.isolating || node.type.preserveWhitespace ||
    node.isBlock && isAtom(cx, pos, node) // FIXME allow node specs to enable this?
}

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
    pastBarrier = isBarrier(cx, block.before, block.node)
  } else {
    pastBarrier = !pos.parent.parent && pos.index == (forward ? 0 : pos.parent.node.children.length)
    for (let {parent: {node}, index, pos: p} = pos; !pastBarrier && (forward ? index : index < node.children.length);) {
      let next = node.children[forward ? index - 1 : index]
      if (!forward) p -= next.length
      if (isBarrier(cx, p, next)) pastBarrier = true
      if (next.inlineContent) break
      node = next
      index = forward ? next.children.length : 0
      if (forward) p += next.length
    }
  }

  let bottom = pos.pos, step = forward ? 1 : -1
  for (let {parent, index} = pos, p = pos.pos;;) {
    let {node, parent: next} = parent
    if (node.inlineContent) {
      if (visualOrder) return TextblockMap.get(parent.start, parent.node, dir(parent.node.tag)).visualTextblockSide(forward)
      return {pos: p, assoc: forward ? 1 : -1}
    }
    if (index == (forward ? node.children.length : 0)) {
      let barrier = !next || isBarrier(cx, parent.before, node)
      if ((bottom != from || !mustMove) && pastBarrier && barrier) return {pos: bottom, assoc: forward ? -1 : 1}
      if (!next) return null
      index = parent.index + (forward ? 1 : 0)
      parent = next
      p += step
      bottom = p
      if (barrier) pastBarrier = true
    } else {
      let nextNode = node.children[index - (forward ? 0 : 1)], nextPos = p - (forward ? 0 : nextNode.length)
      let barrier = isBarrier(cx, nextPos, nextNode)
      if (pastBarrier && (bottom != from || !mustMove) && barrier) return {pos: bottom, assoc: forward ? -1 : 1}
      if (isAtom(cx, nextPos, nextNode)) {
        index += step
        p += nextNode.length * step
      } else {
        if (!forward) index--
        parent = new NodePos(parent, nextNode, p - (forward ? 0 : nextNode.length) + 1, index)
        p += step
        index = forward ? 0 : nextNode.children.length
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
      let map = TextblockMap.get(block.start, block.node, cx.textDirection ? cx.textDirection(block.node.tag) : Direction.LTR)
      let next = map.skipWord(pos, assoc, forward, visually)
      if (next) return next
      if (!block.parent) return last
      let end: {pos: number, assoc: -1 | 1} = visually ? map.visualTextblockSide(!forward) : forward ? {pos: block.end, assoc: -1} : {pos: block.start, assoc: 1}
      if (end.pos != start) last = end
      pos = forward ? block.after : block.before
    }
  }
}

export function wordAt(state: EditorState, pos: number, bias: -1 | 1) {
  let res = state.doc.resolve(pos)
  if (!res.parent.node.inlineContent) return EditorSelection.cursor(pos, bias)
  let start = pos, end = pos, text = ""
  scanBack: for (let i = res.index, cur = res.nodeBefore; cur;) {
    if (!cur.isText) break
    for (let j = cur.length; j > 0;) {
      let next = findClusterBreak(cur.text!, j, false)
      let ch = cur.text!.slice(next, j)
      if (!/\p{L}|\p{N}/u.test(ch)) break scanBack
      text = ch + text
      start -= (j - next)
      j = next
    }
    if (!i) break
    cur = res.parent.node.children[--i]
  }
  scanForward: for (let i = res.index + 1, cur = res.nodeAfter; cur;) {
    if (!cur.isText) break
    for (let j = 0; j < cur.length;) {
      let next = findClusterBreak(cur.text!, j, true)
      let ch = cur.text!.slice(j, next)
      if (!/\p{L}|\p{N}/u.test(ch)) break scanForward
      text += ch
      end += (next - j)
      j = next
    }
    if (i == res.parent.node.children.length) break
    cur = res.parent.node.children[i++]
  }
  if (!(Intl as any).Segmenter) return EditorSelection.range(start, end)
  let best: any = null, local = pos - start
  for (let segment of new (Intl as any).Segmenter(undefined, {granularity: "word"}).segment(text)) {
    if (segment.isWordLike && segment.index <= local && segment.index + segment.segment.length >= local && (!best || bias > 0))
      best = segment
  }
  return best ? EditorSelection.range(start + best.index, start + best.index + best.segment.length) : EditorSelection.cursor(pos, bias)
}
