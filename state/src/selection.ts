import {Schema, DocNode, Node, ChangeDesc, Prop, Context} from "@willows/doc"
import {findClusterBreak} from "@marijn/find-cluster-break"

// A range's flags field is used like this:
// - 3 bits for bidi level (7 means unset) (only meaningful for
//   cursors)
// - 2 bits to indicate the side the cursor is associated with (only
//   for cursors)
// - 1 bit to indicate whether the range is inverted (head before
//   anchor) (only meaningful for non-empty ranges)
// - Any further bits hold the goal column (only for ranges
//   produced by vertical motion)
const enum RangeFlag {
  BidiLevelMask = 7,
  AssocBefore = 8,
  AssocAfter = 16,
  Inverted = 32,
  GoalColumnOffset = 6,
  NoGoalColumn = 0xffffff
}

export type SelectionJSON = {
  ranges: {anchor: number, head: number}[],
  main: number,
  props?: Record<string, any>
}

/// A single selection range. When
/// [`allowMultipleSelections`](#state.EditorState^allowMultipleSelections)
/// is enabled, a [selection](#state.EditorSelection) may hold
/// multiple ranges. By default, selections hold exactly one range.
export class SelectionRange {
  private constructor(
    /// The lower boundary of the range.
    readonly from: number,
    /// The upper boundary of the range.
    readonly to: number,
    private flags: number
  ) {}

  /// The anchor of the range—the side that doesn't move when you
  /// extend it.
  get anchor() { return this.flags & RangeFlag.Inverted ? this.to : this.from }

  /// The head of the range, which is moved when the range is
  /// [extended](#state.SelectionRange.extend).
  get head() { return this.flags & RangeFlag.Inverted ? this.from : this.to }

  /// True when `anchor` and `head` are at the same position.
  get empty(): boolean { return this.from == this.to }

  /// If this is a cursor that is explicitly associated with the
  /// element before or after it, this returns the side. -1 means the
  /// element before its position, 1 the element after, and 0 means no
  /// association.
  get assoc(): -1 | 0 | 1 { return this.flags & RangeFlag.AssocBefore ? -1 : this.flags & RangeFlag.AssocAfter ? 1 : 0 }

  /// The bidirectional text level associated with this cursor, if
  /// any.
  get bidiLevel(): number | null {
    let level = this.flags & RangeFlag.BidiLevelMask
    return level == 7 ? null : level
  }

  /// The goal column (stored vertical offset) associated with a
  /// cursor. This is used to preserve the vertical position when
  /// moving across lines of different length.
  get goalColumn() {
    let value = this.flags >> RangeFlag.GoalColumnOffset
    return value == RangeFlag.NoGoalColumn ? undefined : value
  }

  /// Map this range through a change, producing a valid range in the
  /// updated document.
  map(change: ChangeDesc, assoc = -1): SelectionRange {
    let from, to, flags = this.flags
    if (this.empty) {
      from = to = change.mapPos(this.from, assoc)
    } else {
      from = change.mapPos(this.from, 1)
      to = change.mapPos(this.to, -1)
      if (from == to) flags &= ~RangeFlag.Inverted
    }
    return from == this.from && to == this.to ? this : new SelectionRange(from, to, flags)
  }

  /// Extend this range to cover at least `from` to `to`.
  extend(from: number, to: number = from) {
    if (from <= this.anchor && to >= this.anchor) return EditorSelection.range(from, to)
    let head = Math.abs(from - this.anchor) > Math.abs(to - this.anchor) ? from : to
    return EditorSelection.range(this.anchor, head)
  }

  /// Compare this range to another range.
  eq(other: SelectionRange, includeAssoc = false): boolean {
    return this.anchor == other.anchor && this.head == other.head &&
      (!includeAssoc || !this.empty || this.assoc == other.assoc)
  }

  /// Return a JSON-serializable object representing the range.
  toJSON(): {anchor: number, head: number} { return {anchor: this.anchor, head: this.head} }

  /// Convert a JSON representation of a range to a `SelectionRange`
  /// instance.
  static fromJSON(json: any): SelectionRange {
    if (!json || typeof json.anchor != "number" || typeof json.head != "number")
      throw new RangeError("Invalid JSON representation for SelectionRange")
    return EditorSelection.range(json.anchor, json.head)
  }

  /// @internal
  static create(from: number, to: number, flags: number) {
    return new SelectionRange(from, to, flags)
  }
}

/// An editor selection holds one or more selection ranges.
export class EditorSelection {
  private constructor(
    /// The ranges in the selection, sorted by position. Ranges cannot
    /// overlap (but they may touch, if they aren't empty).
    readonly ranges: readonly SelectionRange[],
    /// The index of the _main_ range in the selection (which is
    /// usually the range that was added last).
    readonly mainIndex: number,
    /// A set of active props that should be applied to content
    /// inserted at this selection (replacing the contextual props).
    /// Used mostly for making the effect of toggling inline styles
    /// stick until something is inserted. Props that aren't valid for
    /// the inserted content will be ignored.
    readonly props: readonly Prop[] | null
  ) {}

  /// Map a selection through a change. Used to adjust the selection
  /// position for changes.
  map(change: ChangeDesc, assoc = -1): EditorSelection {
    if (change.empty) return this
    return EditorSelection.create(this.ranges.map(r => r.map(change, assoc)), this.mainIndex)
  }

  /// Compare this selection to another selection. By default, ranges
  /// are compared only by position. When `includeAssoc` is true,
  /// cursor ranges must also have the same
  /// [`assoc`](#state.SelectionRange.assoc) value.
  eq(other: EditorSelection, includeAssoc = false): boolean {
    if (this.ranges.length != other.ranges.length ||
        this.mainIndex != other.mainIndex) return false
    for (let i = 0; i < this.ranges.length; i++)
      if (!this.ranges[i].eq(other.ranges[i], includeAssoc)) return false
    return true
  }

  /// @internal
  check(doc: DocNode) {
    if (this.ranges[0].from < 0 || this.ranges[this.ranges.length - 1].to > doc.length)
      throw new Error(`Selection out of document range`)
  }

  /// Make sure all cursor ranges in the selection exist at a normal
  /// cursor position.
  normalize(doc: DocNode) {
    let copy: SelectionRange[] | undefined
    for (let i = 0; i < this.ranges.length; i++) {
      let range = this.ranges[i]
      if (range.empty) {
        let normal = EditorSelection.normalPositionBefore(doc, range.from, false)
          ?? EditorSelection.normalPositionAfter(doc, range.from, true)
        if (normal != null && normal != range.from) {
          if (!copy) copy = this.ranges.slice()
          copy[i] = EditorSelection.cursor(normal, -1, undefined, range.goalColumn)
        }
      }
    }
    return copy ? EditorSelection.sorted(copy, this.mainIndex, this.props) : this
  }

  /// Get the primary selection range.
  get main(): SelectionRange { return this.ranges[this.mainIndex] }

  /// Extend this selection with an extra range.
  addRange(range: SelectionRange, main: boolean = true) {
    return EditorSelection.create([range].concat(this.ranges), main ? 0 : this.mainIndex + 1)
  }

  /// Replace a given range with another range, and then merge and
  /// sort ranges if necessary.
  replaceRange(range: SelectionRange, which: number = this.mainIndex) {
    let ranges = this.ranges.slice()
    ranges[which] = range
    return EditorSelection.create(ranges, this.mainIndex)
  }

  /// Convert this selection to an object that can be serialized to
  /// JSON.
  toJSON(): SelectionJSON {
    let result: SelectionJSON = {ranges: this.ranges.map(r => r.toJSON()), main: this.mainIndex}
    if (this.props) {
      result.props = {}
      for (let prop of this.props) result.props[prop.name] = prop.value
    }
    return result
  }

  /// Create a selection from a JSON representation.
  static fromJSON(schema: Schema, json: SelectionJSON): EditorSelection {
    if (!json || !Array.isArray(json.ranges) || typeof json.main != "number" || json.main >= json.ranges.length)
      throw new RangeError("Invalid JSON representation for EditorSelection")
    let props = json.props ? schema.propsFromJSON(json.props) : null
    return new EditorSelection(json.ranges.map((r: any) => SelectionRange.fromJSON(r)), json.main, props)
  }

  /// Create a selection holding a single range.
  static single(anchor: number, head: number = anchor, props: readonly Prop[] | null = null) {
    return new EditorSelection([EditorSelection.range(anchor, head)], 0, props)
  }

  /// Sort and merge the given set of ranges, creating a valid
  /// selection.
  static create(ranges: readonly SelectionRange[], mainIndex: number = 0, props: readonly Prop[] | null = null) {
    if (ranges.length == 0) throw new RangeError("A selection needs at least one range")
    for (let pos = 0, i = 0; i < ranges.length; i++) {
      let range = ranges[i]
      if (range.empty ? range.from <= pos : range.from < pos)
        return EditorSelection.sorted(ranges.slice(), mainIndex, props)
      pos = range.to
    }
    return new EditorSelection(ranges, mainIndex, props)
  }

  /// Create a cursor selection range at the given position. You can
  /// safely ignore the optional arguments in most situations.
  static cursor(pos: number, assoc = 0, bidiLevel?: number, goalColumn?: number) {
    return SelectionRange.create(
      pos, pos, (assoc == 0 ? 0 : assoc < 0 ? RangeFlag.AssocBefore : RangeFlag.AssocAfter) |
      (bidiLevel == null ? 7 : Math.min(6, bidiLevel)) |
      ((goalColumn ?? RangeFlag.NoGoalColumn) << RangeFlag.GoalColumnOffset))
  }

  /// Create a selection range.
  static range(anchor: number, head: number, goalColumn?: number, bidiLevel?: number) {
    let flags = ((goalColumn ?? RangeFlag.NoGoalColumn) << RangeFlag.GoalColumnOffset) |
      (bidiLevel == null ? 7 : Math.min(6, bidiLevel))
    return head < anchor ? SelectionRange.create(head, anchor, RangeFlag.Inverted | RangeFlag.AssocAfter | flags)
      : SelectionRange.create(anchor, head, (head > anchor ? RangeFlag.AssocBefore : 0) | flags)
  }

  static atStart(doc: DocNode) {
    for (let offset = 0, node = doc as Node;;) {
      if (node.inlineContent()) return EditorSelection.single(offset)
      if (!node.children.length) return EditorSelection.single(0)
      node = node.children[0]
      offset++
    }
  }

  /// @internal
  static sorted(ranges: SelectionRange[], mainIndex: number = 0, props: readonly Prop[] | null): EditorSelection {
    let main = ranges[mainIndex]
    ranges.sort((a, b) => a.from - b.from)
    mainIndex = ranges.indexOf(main)
    for (let i = 1; i < ranges.length; i++) {
      let range = ranges[i], prev = ranges[i - 1]
      if (range.empty ? range.from <= prev.to : range.from < prev.to) {
        let from = prev.from, to = Math.max(range.to, prev.to)
        if (i <= mainIndex) mainIndex--
        ranges.splice(--i, 2, range.anchor > range.head ? EditorSelection.range(to, from) : EditorSelection.range(from, to))
      }
    }
    return new EditorSelection(ranges, mainIndex, props)
  }

  static normalPositionAfter(doc: DocNode, from: number, mustMove: boolean = true) {
    return scanNormalFrom(doc, from, true, mustMove)
  }

  static normalPositionBefore(doc: DocNode, from: number, mustMove: boolean = true) {
    return scanNormalFrom(doc, from, false, mustMove)
  }
}

function isBarrier(node: Node) {
  return node.tag.type.isolating || node.tag.type.preserveWhitespace ||
    node.isBlock() && node.tag.isAtom() // FIXME allow node specs to enable this?
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
