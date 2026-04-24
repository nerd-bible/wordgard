import {Plot, Node as wgNode, Leaf, ChangeSet, Mark, Pos, ValidationError, MapMode} from "wordgard/doc"
import {findClusterBreak} from "@marijn/find-cluster-break"
import {TextblockMap} from "./textblock"
import {Direction} from "./bidi"
import type {GardState, Facet} from "./state"

export class SelectionType {
  constructor(
    readonly tag: string,
    readonly cls: any,
    readonly toJSON: (sel: GardSelection) => unknown,
    readonly fromJSON: (doc: Plot.Doc, json: any) => GardSelection
  ) {}
}

// FIXME check all comments

/// An editor selection holds one or more selection ranges.
export abstract class GardSelection {
  constructor(
    /// The anchor of the range—the side that doesn't move when you
    /// extend it.
    readonly anchor: number,
    /// The head of the range, which is moved when the range is
    /// [extended](#state.EditorSelection.extend).
    readonly head: number,
    /// The goal column (stored vertical offset) associated with a
    /// cursor. This is used to preserve the vertical position when
    /// moving across lines of different length.
    readonly goalColumn?: number
  ) {}

  /// The lower boundary of the selected range.
  get from() { return Math.min(this.anchor, this.head) }

  /// The upper boundary of the range.
  get to() { return Math.max(this.anchor, this.head) }

  /// True when `anchor` and `head` are at the same position.
  get empty(): boolean { return this.anchor == this.head }

  private _ranges: readonly {from: number, to: number}[] | null = null

  /// Returns true when this is an empty text selection.
  get isCursor(): boolean { return this.empty && this instanceof GardSelection.Text }

  /// The set of ranges covered by this selection, sorted.
  get ranges() {
    return this._ranges || (this._ranges = this.enumerateRanges())
  }

  enumerateRanges() { return [this] }

  /// The range that should be used when replacing this selection with
  /// other content (for example when typing or pasting over it) or
  /// deleting it. The default implementation returns `this.from` to
  /// `this.to`.
  get replacemenRange(): {from: number, to: number} { return this }

  // FIXME rename, check uses of plain 'assoc'
  get anchorSide(): -1 | 1 { return this.anchor > this.head ? -1 : 1 }
  get headSide(): -1 | 1 { return this.head > this.anchor ? -1 : 1 }

  /// Compare this selection to another selection.
  abstract eq(other: GardSelection): boolean

  /// Returns true if this selection has the same head and anchor as
  /// the given selection.
  eqPos(other: GardSelection) {
    return this.anchor == other.anchor && this.head == other.head
  }

  /// Map a selection through a change. Used to adjust the selection
  /// position for changes.
  abstract map(change: ChangeSet, doc: Plot.Doc | (() => Plot.Doc), assoc?: -1 | 1): GardSelection

  /// @internal
  check(config: GardState.Configuration, doc: Plot.Doc) {
    if (!config.staticFacet(GardSelection.selectionType).some(t => this instanceof t.cls))
      throw new RangeError("Unsupported selection type")
    for (let {from, to} of this.ranges)
      if (from < 0 || to > doc.length)
        throw new RangeError(`Selection out of document range`)
  }

  /// @internal
  resolve(doc: Plot.Doc) { return new GardSelection.Resolved(doc, this) }

  /// Convert this selection to an object that can be serialized to
  /// JSON.
  toJSON(state: GardState): unknown {
    let type = state.facet(GardSelection.selectionType).find(tp => this instanceof tp.cls)
    if (!type) throw new Error("Selection type not enabled in state given to GardSelection.toJSON")
    let result = type.toJSON(this) as any
    result.type = type.tag
    return result
  }

  /// Deserialize a selection. The configuration is used to associate
  /// custom selection types with their implementation.
  static fromJSON(cx: GardSelection.Context, json: unknown): GardSelection {
    let {doc, config} = toContext(cx), tag = (json as any).type as string
    let types = config ? config.staticFacet(GardSelection.selectionType) : [GardSelection.Text.type, GardSelection.Node.type]
    let type = types.find(tp => tp.tag == tag)
    if (!type) throw new Error(`Unknown selection type '${tag}' in GardSelection.fromJSON`)
    return type.fromJSON(doc, json)
  }

  /// Create a cursor selection range at the given position. You can
  /// safely ignore the optional arguments in most situations.
  static cursor(pos: number, side?: -1 | 1, goalColumn?: number) {
    return GardSelection.Text.createInner(pos, pos, side, goalColumn)
  }

  /// Create a range selection.
  static range(anchor: number, head?: number, headSide?: -1 | 1, goalColumn?: number) {
    return GardSelection.Text.createInner(anchor, head ?? anchor, headSide, goalColumn)
  }

  /// Create a node selection.
  static node(pos: number, node: wgNode, goalColumn?: number) {
    return GardSelection.Node.create(pos, node, goalColumn)
  }

  // FIXME I don't like these. Try to replace them with a different interface
  // FIXME also maybe move them to Text

  /// Find the next normal cursor position after or before this selection's
  /// head.
  nextNormalCursor(cx: GardSelection.Context, forward = true): GardSelection.Text | null {
    let found = scanNormalFrom(toContext(cx), this.head, this.headSide, forward, true)
    return found && GardSelection.cursor(found.pos, found.side)
  }

  /// Get a normal cursor at the start or end of this selection.
  normalCursorAtBound(cx: GardSelection.Context, forward = true): GardSelection.Text | null {
    let found = scanNormalFrom(toContext(cx), forward ? this.to : this.from, forward ? -1 : 1, forward, false)
    return found && GardSelection.cursor(found.pos, found.side)
  }

  /// Move across one word starting from this selection's head.
  skipWord(cx: GardSelection.Context, forward = true): GardSelection.Text | null {
    let found = skipWord(toContext(cx), this.head, this.headSide, forward)
    return found && GardSelection.cursor(found.pos, found.side)
  }

  /// Find a normal selection near the given position.
  static near(cx: GardSelection.Context, pos: number, bias: -1 | 1 = 1): GardSelection.Text {
    let c = toContext(cx)
    let norm = scanNormalFrom(c, pos, bias, bias > 0, false) ??
      scanNormalFrom(c, pos, -bias as -1 | 1, bias < 0, false) ??
      {pos: pos, side: -1}
    return GardSelection.cursor(norm.pos, norm.side)
  }

  /// Find a normal selection at the start of the document.
  static atStart(cx: GardSelection.Context) { return cursorAtStart(toContext(cx)) }

  /// Find a normal selection at the end of the document.
  static atEnd(cx: GardSelection.Context) {
    let c = toContext(cx)
    let found = c.doc.inlineContent
      ? TextblockMap.get(0, c.doc, textDir(c)).visualTextblockSide(false)
      : scanNormalFrom(c, c.doc.length, -1, false, false) ?? {pos: c.doc.length, side: -1}
    return GardSelection.cursor(found.pos, found.side)
  }

  /// @internal
  declare static selectionType: Facet<SelectionType>

  static define<T extends GardSelection, JSON>(
    tag: string, cls: {new(...args: any[]): T},
    toJSON: (sel: T) => JSON,
    fromJSON: (doc: Plot.Doc, json: JSON) => T
  ) {
    return GardSelection.selectionType.of(new SelectionType(tag, cls, toJSON as any, fromJSON as any)) as any
  }
}

export namespace GardSelection {
  export class Text extends GardSelection {
    private constructor(
      anchor: number,
      head: number,
      readonly _headSide: -1 | 1,
      goalColumn: number | undefined,
      /// A set of active marks that should be applied to content
      /// inserted at this selection (replacing the contextual marks).
      /// Used mostly for making the effect of toggling inline styles
      /// stick until something is inserted. Marks that aren't valid for
      /// the inserted content will be ignored.
      readonly marks: readonly Mark[] | undefined,
    ) {
      super(anchor, head, goalColumn)
    }

    /// @internal
    static createInner(anchor: number, head: number, side?: -1 | 1,
                       goalColumn?: number, marks?: readonly Mark<any>[]) {
      return new Text(anchor, head, side ?? (head > anchor ? -1 : 1), goalColumn, marks)
    }

    get headSide() {
      return this._headSide
    }

    get anchorSide() {
      return this.anchor == this.head ? this._headSide : super.anchorSide
    }

    /// Create a text selection.
    static create(spec: GardSelection.Text.Spec) {
      let {anchor, head = anchor} = spec
      return Text.createInner(anchor, head, spec.headSide, spec.goalColumn, spec.marks)
    }

    map(change: ChangeSet, doc: Plot.Doc | (() => Plot.Doc), assoc: -1 | 1 = -1): GardSelection {
      let from, to
      if (this.empty) {
        from = to = change.mapPos(this.from, assoc)
      } else {
        from = change.mapPos(this.from, 1)
        to = Math.max(from, change.mapPos(this.to, -1))
      }
      return Text.createInner(from, to, this.headSide, this.goalColumn, this.marks)
    }

    eq(other: GardSelection) {
      return other instanceof Text && this.eqPos(other) && this.headSide == other.headSide &&
        (this.marks == other.marks || !!(this.marks && other.marks && this.marks.length == other.marks.length &&
          this.marks.every((p, i) => p.eq(other.marks![i]))))
    }
  }

  export namespace Text {
    /// Description of a text selection.
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
      headSide?: -1 | 1
      /// Associates a horizontal position with this selection for use
      /// during vertical cursor motion.
      goalColumn?: number
      /// Marks associated with a cursor selection, which will determine
      /// the marks of inline content inserted at that selection. This is
      /// used for things like toggling emphasis on a cursor selection.
      marks?: readonly Mark<any>[]
    }

    /// The representation of a text selection when serialized to JSON.
    export type JSON = {
      anchor: number
      head?: number
      side?: -1 | 0 | 1
      marks?: Record<string, any>
    }

    export const type = new SelectionType("text", Text, ((sel: Text): JSON => {
      let result: JSON = {anchor: sel.anchor, side: sel.headSide}
      if (!sel.empty) result.head = sel.head
      if (sel.marks) {
        result.marks = {}
        for (let mark of sel.marks) result.marks[mark.name] = mark.value
      }
      return result
    }) as any, ((doc: Plot.Doc, json: JSON) => {
      if (!json || typeof json.anchor != "number")
        throw new ValidationError("Invalid JSON representation for GardSelection.Text")
      let anchor = json.anchor, head = typeof json.head == "number" ? json.head : anchor
      let marks = json.marks ? doc.schema.marksFromJSON(json.marks) : undefined
      return Text.createInner(anchor, head, json.side == 1 || json.side == -1 ? json.side : undefined, undefined, marks)
    }) as any)
  }

  export class Node extends GardSelection {
    private constructor(
      from: number,
      to: number,
      /// The selected node.
      readonly node: wgNode,
      goalColumn?: number
    ) {
      super(from, to, goalColumn)
    }

    /// @internal
    static create(pos: number, node: wgNode, goalColumn?: number) {
      return new Node(pos, pos + node.length, node, goalColumn)
    }

    map(change: ChangeSet, doc: Plot.Doc | (() => Plot.Doc), assoc: -1 | 1 = -1) {
      let newPos = change.mapPos(this.anchor, 1, MapMode.TrackAfter)
      if (newPos == null)
        return GardSelection.cursor(change.mapPos(this.anchor, assoc))
      if (typeof doc == "function") doc = doc()
      return Node.create(newPos, doc.nodeAt(newPos)!)
    }

    eq(other: GardSelection) {
      return other instanceof Node && other.anchor == this.anchor
    }
  }

  export namespace Node {
    /// The representation of a node selection when serialized to JSON.
    export type JSON = {
      pos: number
    }

    /// @internal
    export const type = new SelectionType("node", Node, (sel): JSON => ({pos: sel.anchor}), (doc, json: JSON) => {
      let node = json && typeof json.pos == "number" && doc.nodeAt(json.pos)
      if (!node || node.isText) throw new ValidationError("Invalid GardSelection.Node JSON representation")
      return Node.create(json.pos, node)
    })
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

    get replacementRange(): {from: Pos, to: Pos} {
      let repl = this.selection.replacemenRange
      if (repl.from == this.selection.from && repl.to == this.selection.to) return this
      return {from: this.doc.resolve(repl.from), to: this.doc.resolve(repl.to)}
    }

    get activeMarks(): readonly Mark[] {
      let repl = this.replacementRange
      return (this.selection instanceof GardSelection.Text && this.selection.marks) || repl.from.marks(repl.to)
    }

    /// True when the selection is empty (a cursor).
    get empty() { return this.selection.empty }
  }

  /// Many selection related functions need access to a configuration
  /// (to determine text direction and visual motion behavior) and a
  /// document. You can pass in only a document if you don't expect
  /// direction to be relevant to your query. Note that {@link
  /// EditorState} is a subtype of this.
  export type Context = Plot.Doc | {doc: Plot.Doc, config: GardState.Configuration}
}

type Context = {doc: Plot.Doc, config?: GardState.Configuration}

function toContext(cx: GardSelection.Context): Context {
  return cx instanceof Plot.Doc ? {doc: cx, config: undefined} : cx
}

function textDir(cx: Context, tag?: Plot.Tag.Any) {
  return cx.config ? cx.config.textDirection(tag) : Direction.LTR
}

function visualMotion(cx: Context) {
  return cx.config ? cx.config.visualCursorMotion : true
}

export function cursorAtStart(cx: Context) {
  let found = cx.doc.inlineContent
    ? TextblockMap.get(0, cx.doc, textDir(cx, cx.doc.tag)).visualTextblockSide(true)
    : scanNormalFrom(cx, 0, 1, true, false) ?? {pos: 0, side: 1}
  return GardSelection.cursor(found.pos, found.side)
}

function isBarrier(node: wgNode) {
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
  cx: Context, from: number, side: -1 | 1, forward: boolean, mustMove: boolean
): {pos: number, side: -1 | 1} | null {
  let pos = cx.doc.resolve(from), pastBarrier = false
  if (pos.parent.node.inlineContent) {
    if (!mustMove) return {pos: pos.pos, side}
    let block = pos.textblockParent!
    let map = TextblockMap.get(block.start, block.node, textDir(cx, block.node.tag))
    let next = visualMotion(cx) ? map.moveVisually(pos.pos, side, forward) : map.moveLogically(pos.pos, forward)
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
      if (visualMotion(cx))
        return TextblockMap.get(parent.start, parent.node, textDir(cx, parent.node.tag)).visualTextblockSide(forward)
      return {pos: p, side: forward ? 1 : -1}
    }
    if (index == (forward ? node.content.length : 0)) {
      let barrier = !next || isBarrier(node)
      if ((bottom != from || !mustMove) && pastBarrier && barrier) return {pos: bottom, side: forward ? -1 : 1}
      if (!next) return null
      index = parent.index + (forward ? 1 : 0)
      parent = next
      p += step
      bottom = p
      if (barrier) pastBarrier = true
    } else {
      let nextNode = node.content[index - (forward ? 0 : 1)]
      let barrier = isBarrier(nextNode)
      if (pastBarrier && (bottom != from || !mustMove) && barrier) return {pos: bottom, side: forward ? -1 : 1}
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

function skipWord(cx: Context, start: number, side: -1 | 1, forward: boolean) {
  let last: {pos: number, side: -1 | 1} | null = null
  for (let pos = start, visually = visualMotion(cx);;) {
    let block = cx.doc.resolve(pos).textblockParent
    if (!block) {
      let next = scanNormalFrom(cx, pos, side, forward, true)
      if (!next) return last
      ;({pos, side} = next)
    } else {
      let map = TextblockMap.get(block.start, block.node, textDir(cx, block.node.tag))
      let next = map.skipWord(pos, side, forward, visually)
      if (next) return next
      if (!block.parent) return last
      let end: {pos: number, side: -1 | 1} = visually ? map.visualTextblockSide(!forward)
        : forward ? {pos: block.end, side: -1} : {pos: block.start, side: 1}
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
