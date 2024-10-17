import {Schema, DocNode, Node, ChangeDesc, Prop, Context, Pos} from "@willows/doc"
import {findClusterBreak} from "@marijn/find-cluster-break"

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
    this.anchor = doc.resolveX(selection.anchor)
    this.head = selection.empty ? this.anchor : doc.resolveX(selection.head)
  }

  get from() { return this.anchor.pos < this.head.pos ? this.anchor : this.head }
  get to() { return this.anchor.pos > this.head.pos ? this.anchor : this.head }

  get empty() { return this.selection.empty }
  get assoc() { return this.selection.assoc } 
}

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
    readonly goalColumn: number | null,
    /// The ranges in the selection, for selections that cover more
    /// than one range. Includes the main range.
    readonly ranges: readonly {from: number, to: number}[],
    /// A set of active props that should be applied to content
    /// inserted at this selection (replacing the contextual props).
    /// Used mostly for making the effect of toggling inline styles
    /// stick until something is inserted. Props that aren't valid for
    /// the inserted content will be ignored.
    readonly props: readonly Prop[] | null
  ) {}

  /// The lower boundary of the selected range.
  get from() { return Math.min(this.anchor, this.head) }

  /// The upper boundary of the range.
  get to() { return Math.max(this.anchor, this.head) }

  /// True when `anchor` and `head` are at the same position.
  get empty(): boolean { return this.anchor == this.head }

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
  normalize(doc: DocNode) {
    if (!this.empty) return this
    let normal = EditorSelection.normalPositionBefore(doc, this.from, false)
      ?? EditorSelection.normalPositionAfter(doc, this.from, true)
    if (normal == null || normal == this.from) return this
    return EditorSelection.cursor(normal, -1, this.goalColumn ?? undefined, this.props)
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
    let props = json.props ? schema.propsFromJSON(json.props) : null
    let ranges = Array.isArray(json.ranges) && json.ranges.every(r => typeof r.from == "number" && typeof r.to == "number")
    return EditorSelection.createInner(anchor, head, typeof json.assoc == "number" ? json.assoc : 0, null,
                                       ranges ? json.ranges : rangesFor(anchor, head), props)
  }

  /// Create a cursor selection range at the given position. You can
  /// safely ignore the optional arguments in most situations.
  static cursor(pos: number, assoc = 0, goalColumn?: number, props?: readonly Prop<any>[] | null) {
    return EditorSelection.createInner(pos, pos, assoc, goalColumn, undefined, props)
  }

  /// Create a range selection.
  static range(anchor: number, head: number, goalColumn?: number, props?: readonly Prop<any>[] | null) {
    return EditorSelection.createInner(anchor, head, 0, goalColumn, undefined, props)
  }

  private static createInner(anchor: number, head: number, assoc?: number, goalColumn?: number | null,
                             ranges?: readonly {from: number, to: number}[], props?: readonly Prop<any>[] | null) {
    return new EditorSelection(anchor, head, !assoc ? 0 : assoc < 0 ? -1 : 1, goalColumn || null,
                               ranges || [{from: Math.min(anchor, head), to: Math.max(anchor, head)}],
                               props || null)
  }

  /// Create a selection.
  static create(spec: SelectionSpec) {
    return EditorSelection.createInner(spec.anchor, spec.head || spec.anchor, spec.assoc, spec.goalColumn,
                                       spec.ranges, spec.props)
  }

  static normalPositionAfter(doc: DocNode, from: number, mustMove: boolean = true) {
    return scanNormalFrom(doc, from, true, mustMove)
  }

  static normalPositionBefore(doc: DocNode, from: number, mustMove: boolean = true) {
    return scanNormalFrom(doc, from, false, mustMove)
  }

  static near(doc: DocNode, pos: number, bias: -1 | 1 = 1) {
    let norm = scanNormalFrom(doc, pos, bias > 0, false) ?? scanNormalFrom(doc, pos, bias < 0, false)!
    return EditorSelection.cursor(norm)
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

function rangesFor(anchor: number, head: number) {
  return [{from: Math.min(anchor, head), to: Math.max(anchor, head)}]
}

function isBarrier(node: Node) {
  return node.type.isolating || node.type.preserveWhitespace ||
    node.isBlock() && node.isAtom() // FIXME allow node specs to enable this?
}

function scanNormalFrom(doc: DocNode, from: number, forward: boolean, mustMove: boolean) {
  let $pos = doc.resolve(from), pastBarrier = false
  if ($pos.inText) {
    if (!mustMove) return from
    let text = $pos.node.children[$pos.index].text!
    let next = findClusterBreak(text, $pos.inText, forward), nextPos = from - $pos.inText + next
    if (!next) $pos = new Context($pos.node, $pos.index, nextPos, 0, $pos.parent)
    else if (next == text.length) $pos = new Context($pos.node, $pos.index + 1, nextPos, 0, $pos.parent)
    else return nextPos
  } else {
    pastBarrier = !$pos.parent && $pos.index == (forward ? 0 : $pos.node.children.length)
    for (let {node, index} = $pos; !pastBarrier && (forward ? index : index < node.children.length);) {
      let before = node.children[forward ? index - 1 : index]
      if (isBarrier(before)) pastBarrier = true
      if (before.inlineContent() || before.isAtom()) break
      node = before
      index = forward ? before.children.length : 0
    }
  }

  let bottom = $pos.pos, dir = forward ? 1 : -1
  for (let {parent, index, node} = $pos, pos = $pos.pos;;) {
    if (node.inlineContent() && (pos != from || !mustMove) &&
        (index && index < node.children.length ||
         !parent || !parent.node.inlineContent() || node.type.spec.cursorInsideBounds))
      return pos
    if (index == (forward ? node.children.length : 0)) {
      let barrier = !parent || isBarrier(node)
      if ((bottom != from || !mustMove) && pastBarrier && barrier) return bottom
      if (!parent) return null
      ;({parent, index, node} = parent)
      pos += dir
      if (forward) index++
      bottom = pos
      if (barrier) pastBarrier = true
    } else {
      let next = node.children[index - (forward ? 0 : 1)]
      if (next.isText()) {
        if (forward) {
          let skip = findClusterBreak(next.text, 0, true)
          if (skip < next.length) return pos + skip
        } else {
          let skip = findClusterBreak(next.text, next.text.length, false)
          if (skip) return pos - next.length + skip
        }
      }
      let barrier = isBarrier(next)
      if (pastBarrier && (bottom != from || !mustMove) && barrier) return bottom
      if (next.isAtom()) {
        index += dir
        pos += next.length * dir
      } else {
        if (!forward) index--
        parent = new Context(node, index, pos, 0, parent)
        pos += dir
        index = forward ? 0 : next.children.length
        node = next
      }
      if (barrier) { pastBarrier = true; bottom = pos }
    }
  }
}
