import {Plot, Node, Mark, Pos, Leaf, Token, ChangeSet} from "wordgard/doc"
import {GardSelection, GardState, Direction, Transaction} from "wordgard/state"
import {type Wordgard} from "wordgard/view"
import {Command} from "./command"
import {joinForward, joinBackward, liftEmptyBlock, setTextblockType,
        deleteSelection, deleteForward, deleteBackward,
        splitTextblock, joinListItems, unwrapBlockType, wrapBlock,
        canAddMarkInRange, selectedTextblocks} from "./helper"
import {findClusterBreak} from "@marijn/find-cluster-break"

// FIXME check behavior around inline nodes with content for all of these

/// This command handles text input. To selectively override the
/// behavior of text input, provide a handler that, when the
/// conditions that it requires apply, handles the input and returns
/// true. `userEvent` will generally be one of `"input.type"`,
/// `"input.type.compose"` (text inserted as part as a composition),
/// or `"input.type.compose.start"` (initial text created by a started
/// composition).
export const insertText: Command.Pure<{from: number, to: number, insert: string, userEvent: string}> = (
  {state}, {from, to, insert, userEvent}
) => {
  // FIXME support getting the default transaction spec somehow?
  let marks = state.selection.marks || state.doc.resolve(to).marks()
  let changes = ChangeSet.create(state.doc, {from, to, insert: [Leaf.Text.of(insert, marks)], fit: true})
  return {
    changes,
    selection: GardSelection.cursor(changes.mapPos(to, 1), -1),
    normalizeSelection: true,
    userEvent
  }
}

/// Command to insert a line break. The default handler will, if the
/// schema defines a [line break](#doc.Leaf.Spec.isLineBreak) node and
/// the selection's parent node allows that, insert such a node.
/// Otherwise, in nodes marked as
/// [whitespace-preserving](#doc.Plot.Spec.preserveWhitespace), this
/// will insert a line break.
export const insertLineBreak: Command.Pure = ({state}) => {
  let {doc, sel} = state
  let brk = doc.schema.lineBreak, parent = sel.from.parent.node.type
  let marks = state.selection.marks || sel.from.marks(sel.to)
  if (brk && doc.schema.canContain(parent, brk.type)) {
    return {
      changes: {from: sel.from.pos, to: sel.to.pos, insert: [brk.withMarks(marks)], fit: true},
      selection: {anchor: sel.from.pos + 1},
      scrollIntoView: true,
      userEvent: "insert.linebreak"
    }
  }
  if (parent.preserveWhitespace && sel.to.parent.start == sel.from.parent.start) {
    return {
      changes: {from: sel.from.pos, to: sel.to.pos, insert: [Leaf.text("\n", marks)]},
      selection: GardSelection.cursor(sel.from.pos + 1, -1),
      scrollIntoView: true,
      userEvent: "input"
    }
  }
  return false
}

/// The command that handles enter presses. The default handler will,
/// if the selection is not in an inline context, insert an empty
/// default textblock in its position. Otherwise it first tries
/// `liftEmptyTextblock`, then `splitTextblock`.
export const enter: Command.Pure = ({state}) => {
  let {sel, doc} = state
  // When not in an inline context, try to create new empty textblock
  if (!sel.head.parent.node.inlineContent || !sel.anchor.parent.node.inlineContent) {
    let wrap = doc.schema.findWrapping(sel.from.parent.node.type, Leaf.Text)
    if (!wrap) return false
    let content: Plot[] = []
    for (let i = wrap.length - 1; i >= 0; i--) content = [wrap[i].create(content)]
    return {
      changes: {from: sel.from.pos, to: sel.to.pos, insert: content, fit: true},
      selection: GardSelection.cursor(sel.from.pos + content[0].length, -1),
      normalizeSelection: true,
      scrollIntoView: true,
      userEvent: "insert.textblock"
    }
  }
  return liftEmptyBlock(state) || splitTextblock(state)
}

export const deleteUnit: Command.Pure<"forward" | "backward"> = ({state}, dir) => {
  return deleteSelection(state) || (dir == "forward"
    ? joinForward(state) || deleteForward(state)
    : joinListItems(state) || joinBackward(state) || deleteBackward(state))
}

export const deleteWord: Command.Pure<"forward" | "backward"> = ({state}, dir) => {
  return deleteSelection(state) || (dir == "forward"
    ? joinForward(state) || deleteForward(state, true)
    : joinListItems(state) || joinBackward(state) || deleteBackward(state, true))
}

export const deleteToLineEnd: Command<"forward" | "backward"> = (view, dir) => {
  let tr = deleteSelection(view.state), {selection} = view.state
  if (tr) return (view.dispatch(tr), true)
  let end = view.moveToLineBoundary(selection, dir == "forward")
  if (!end || end.head == selection.head) return false
  return {
    changes: {correct: dir == "forward" ? {from: selection.head, to: end.head} : {from: end.head, to: selection.head}},
    scrollIntoView: true,
    userEvent: "delete." + dir
  }
}

export const deleteLine: Command = view => {
  let tr = deleteSelection(view.state), {selection} = view.state
  if (tr) return (view.dispatch(tr), true)
  let start = view.moveToLineBoundary(selection, false), end = view.moveToLineBoundary(selection, true)
  if (!start || !end || start.head >= end.head) return false
  return {
    changes: {correct: {from: start.head, to: end.head}},
    scrollIntoView: true,
    userEvent: "delete.line"
  }
}

export const transposeChars: Command.Pure = ({state}) => {
  let {sel} = state, head = state.selection.head
  if (!sel.empty) return false
  let before = sel.head.nodeBefore, after = sel.head.nodeAfter
  if (!before || !before.is(Leaf.Text) || !after || !after.is(Leaf.Text)) return false
  let lenBefore = before.param.length - findClusterBreak(before.param, before.param.length, false)
  let lenAfter = findClusterBreak(after.param, 0)
  return {
    changes: [{from: head - lenBefore, to: head},
              {from: head + lenAfter, insert: [Leaf.text(before.param.slice(before.param.length - lenBefore))]}],
    selection: GardSelection.cursor(head + lenAfter, -1),
    scrollIntoView: true,
    userEvent: "transpose"
  }
}

export const changeTextblockType: Command.Pure<Plot.Tag.Any> = ({state}, tag) => {
  // FIXME inline
  return setTextblockType(state, tag)
}

export const unwrapBlock: Command.Pure<Node.Query | null> = ({state}, query) => {
  return unwrapBlockType(state, query ?? undefined) // FIXME inline?
}

export const toggleBlock: Command.Pure<Plot.Tag.Any> = ({state}, tag) => {
  return unwrapBlockType(state, tag) || wrapBlock(state, tag)
}

/// Toggle the given mark. If there is no selection, it is added to
/// the cursor's active marks, or removed if it is already in there.
/// Otherwise, if any selected content allows for the mark to be
/// added, it is added. If not, remove the mark from the selection.
export const toggleMark: Command.Pure<Mark<any>> = ({state}, mark) => {
  let {selection, doc} = state
  if (selection.empty) {
    let selMarks = selection.marks || state.sel.head.marks(), add = !mark.isInSet(selMarks)
    let newMarks = add ? mark.addToSet(selMarks) : mark.removeFromSet(selMarks)
    return {
      selection: GardSelection.cursor(selection.head, selection.assoc, selection.goalColumn, newMarks),
      userEvent: add ? "mark.add" : "mark.remove"
    }
  } else if (selection.ranges.some(r => canAddMarkInRange(doc, r.from, r.to, mark))) {
    return {
      changes: selection.ranges.map(r => ({from: r.from, to: r.to, add: mark})),
      userEvent: "mark.add"
    }
  } else {
    return {
      changes: selection.ranges.map(r => ({from: r.from, to: r.to, remove: mark})),
      userEvent: "mark.remove"
    }
  }
}

/// Search the schema for a mark with the given label (that has a
/// default parameter), and run [`toggleMark`](#commands.toggleMark)
/// with that mark.
export const toggleMarkByLabel: Command<Mark.Role> = (view, label) => {
  let mark: Mark | null = null
  for (let type of view.state.doc.schema.marks) {
    if (type.hasRole(label) && type.default) { mark = type.default; break }
  }
  if (!mark) return false
  return Command.dispatch(view, toggleMark, mark)
}

export const setAlignment: Command.Pure<null | "end" | "center"> = ({state}, align) => {
  let {schema} = state.doc
  let mark = schema.marks.find(m => m.hasRole(Mark.Role.Alignment))
  if (!mark) return false
  let changes: ChangeSet.Spec[] = []
  for (let block of selectedTextblocks(state)) {
    let cur = block.node.tag.mark(mark)
    if (cur != align && schema.markAllowed(mark, block.node.type))
      changes.push(align ? {from: block.before, add: mark.of(align)} : {from: block.before, remove: mark.of(cur)})
  }
  if (!changes.length) return false
  return {
    changes,
    userEvent: "mark.set.alignment",
  }
}

export const toggleList: Command.Pure<Plot.Tag.Any> = ({state}, listTag) => {
  let blocks = selectedTextblocks(state)
  if (!blocks.length) return false
  return addList(state, blocks, listTag) || removeList(state, blocks, listTag)
}

export const listIsActive = (listTag: Plot.Tag.Any): (state: GardState) => boolean => state => {
  return selectedTextblocks(state).every(b => {
    let item = isListItem(b)
    return item && item.parent!.node.type == listTag.type
  })
}

function isListItem(node: Pos.Node): Pos.Plot | null {
  for (let first = true;;) {
    let {parent} = node
    if (!parent) return null
    if (parent.node.tag.type.hasRole(Node.Role.List)) return first ? node as Pos.Plot : null
    first = node.isFirst
    node = parent
  }
}

function autoJoin(a: Plot.Tag.Any, b: Plot.Tag.Any) {
  let {autoJoin} = a.type.spec
  return typeof autoJoin == "function" ? autoJoin(a, b) : typeof autoJoin == "boolean" ? autoJoin : a.eq(b)
}

function addList(state: GardState, blocks: Pos.Plot[], listTag: Plot.Tag.Any): Transaction.Spec | false {
  let plan: ({wrap: Pos.Plot, item: Plot.Tag.Any} | {change: Pos.Node, item: Pos.Node})[] = []
  let chBefore: Set<number> = new Set, chAfter: Set<number> = new Set
  let lastItem = -1, {schema} = state.doc
  for (let block of blocks) {
    let item = isListItem(block), wrap
    if (!item && block.parent && schema.canContain(block.parent.node.type, listTag.type) &&
        ((wrap = schema.findWrapping(listTag.type, block.node.type)) && wrap.length == 1 ||
          (wrap = schema.findWrapping(listTag.type, Leaf.Text)) && wrap.length == 1)) {
      chAfter.add(block.before)
      chBefore.add(block.after)
      plan.push({wrap: block, item: wrap[0]})
      lastItem = block.before
    } else if (item?.parent && item.parent.node.tag.type != listTag.type &&
               schema.canContain(listTag.type, item.node.type) &&
               item.parent.parent && schema.canContain(item.parent.parent.node.type, listTag.type) &&
               item.before != lastItem) {
      chAfter.add(item.before)
      chBefore.add(item.after)
      if (item.isFirst) chAfter.add(item.parent.before)
      if (item.isLast) chBefore.add(item.parent.after)
      plan.push({change: block, item})
      lastItem = item.before
    }
  }
  if (!plan.length) return false
  let changes: ChangeSet.Spec[] = []
  for (let step of plan) {
    if ("wrap" in step) { // Wrap block in a list
      let {wrap, item} = step, prev, next
      let openTo = item.isTextblock ? wrap.start : wrap.before, openFrom = wrap.before, open: Token[] = [item]
      if (chBefore.has(wrap.before)) {} // Block above is also included in change
      else if ((prev = wrap.previousSibling) && prev.tag.eq(listTag)) openFrom-- // Join to list above
      else open.unshift(listTag) // Start new list
      changes.push({from: openFrom, to: openTo, insert: open})
      let closeFrom = item.isTextblock ? wrap.end : wrap.after, closeTo = wrap.after, close: Token[] = [Plot.End]
      if (chAfter.has(wrap.after)) {} // Block below included in change
      else if ((next = wrap.nextSibling) && next.isPlot && next.type == listTag.type && autoJoin(next.tag, listTag))
        closeTo++ // Join
      else close.push(Plot.End) // End list
      changes.push({from: closeFrom, to: closeTo, insert: close})
    } else { // Change other list
      let {item} = step, prev, next
      if (item.isFirst) {
        if (chBefore.has(item.before - 1)) // Right after an item produced by another change, delete open token
          changes.push({from: item.before - 1, to: item.before})
        else if ((prev = item.parent!.previousSibling) && prev.tag.type == listTag.type) // Join to list above
          changes.push({from: item.before - 2, to: item.before})
        else // Change open token
          changes.push({from: item.before - 1, to: item.before, insert: [listTag]})
      } else if (!chBefore.has(item.before)) { // Start a new list
        changes.push({from: item.before, insert: [Plot.End, listTag]})
      }
      if (item.isLast) {
        if (chAfter.has(item.after + 1)) { // Before item produced by other change, drop close token
          changes.push({from: item.after, to: item.after + 1})
        } else if ((next = item.parent!.nextSibling) && next.isPlot && autoJoin(next.tag, listTag)) { // Join to list below
          changes.push({from: item.after, to: item.after + 2})
        }
      }
    }
  }
  return {changes, userEvent: "wrap.list"}
}

function removeList(state: GardState, blocks: Pos.Node[], listTag: Plot.Tag.Any): Transaction.Spec | false {
  let plan: {item: Pos.Plot, rewrap: Plot.Tag.Any | null}[] = [], lastItem = -1
  let chBefore: Set<number> = new Set, chAfter: Set<number> = new Set
  let {schema} = state.doc
  for (let block of blocks) {
    let item = isListItem(block)
    if (!item) continue
    let list = item.parent!, parent = list.parent, rewrap: Node.Tag | null = null
    if (parent && list.node.isPlot && list.node.type == listTag.type && item.before != lastItem &&
        (item.node.isTextblock
          ? (rewrap = schema.defaultContentPlot(parent.node.type)) && rewrap.isTextblock
          : schema.canContain(parent.node.type, block.node.type))) {
      lastItem = item.before
      plan.push({item, rewrap: rewrap as Plot.Tag.Any})
      chAfter.add(item.before)
      chBefore.add(item.after)
    }
  }
  if (!plan.length) return false
  let changes: ChangeSet.Spec[] = []
  for (let {item, rewrap} of plan) {
    let openFrom = item.before, openTo = item.start, open: Token[] = rewrap ? [rewrap] : []
    if (item.isFirst) openFrom--
    else if (!chBefore.has(item.before)) open.unshift(Plot.End)
    changes.push({from: openFrom, to: openTo, insert: open})
    let closeFrom = rewrap ? item.after : item.end, closeTo = item.after, close: Token[] = []
    if (item.isLast) closeTo++
    else if (!chAfter.has(item.after)) close.push(listTag)
    changes.push({from: closeFrom, to: closeTo, insert: close})
  }
  return {changes, userEvent: "unwrap.list"}
}

function setSelection(selection: GardSelection, extend?: GardState | false): Transaction.Spec {
  return {
    selection: !extend ? selection
      : GardSelection.range(extend.selection.anchor, selection.head, selection.assoc, selection.goalColumn, selection.marks),
    scrollIntoView: true,
    userEvent: "select"
  }
}

function ltrAtCursor(state: GardState) {
  let block = state.sel.head.textblockParent
  return state.textDirection(block ? block.node.tag : undefined) == Direction.LTR
}

function isForward(dir: "left" | "right" | "forward" | "backward", state: GardState) {
  return dir == "forward" ? true : dir == "backward" ? false : (dir == "right") == ltrAtCursor(state)
}

/// Move the selection head one unit (text cluster, atomic node, or
/// node boundary) in the indicated direction. When `extend` is true,
/// keep the selection anchor in place. The default handler moves
/// visually through bidirectional text, so when going left, the
/// motion will go back in left-to-right text, and
/// forward in right-to-left text.
export const moveByUnit: Command.Pure<{dir: "left" | "right" | "forward" | "backward", extend?: boolean}> = (
  {state}, {dir, extend}
) => {
  let {selection} = state, forward = isForward(dir, state)
  if (!selection.empty && !extend) {
    let next = selection.normalCursorAtBound(state, forward)
    return next ? setSelection(next) : false
  } else {
    let next = selection.nextNormalCursor(state, forward)
    if (!next) return false
    if (!extend) state.doc.iterate(Math.min(selection.head, next.head), Math.max(selection.head, next.head), (node, pos) => {
      if (node.isPlot) return !node.type.isolating
      if (node.type.isSelectable) next = GardSelection.range(pos, pos + node.length)
    })
    return setSelection(next, extend && state)
  }
}

/// Move the selection head one word in the indicated direction. Keep
/// the anchor in place if `extend` is true. The default handler moves
/// visually.
export const moveByWord: Command.Pure<{dir: "left" | "right", extend?: boolean}> = ({state}, {dir, extend}) => {
  let forward = (dir == "right") == ltrAtCursor(state)
  let moved = state.selection.skipWord(state, forward)
  return moved ? setSelection(moved, extend && state) : false
}

function nextVertical(view: Wordgard, sel: GardSelection, forward: boolean,
                      distance?: number, allowNode?: boolean) {
  let next = view.moveVertically(sel, forward, distance, allowNode)
  if (next) return next
  let end = (forward ? GardSelection.atEnd : GardSelection.atStart)(view.state)
  return end.head == view.state.selection.head ? null : end
}

/// Move the selection head one line up or down. When `extend` is
/// true, keep the anchor in place.
export const moveByLine: Command<{dir: "up" | "down", extend?: boolean}> = (view, {dir, extend}) => {
  let {state} = view, {selection} = state, forward = dir == "down"
  if (state.sel.node) {
    let next = !extend && state.selection.normalCursorAtBound(state, forward)
    if (next && !state.doc.resolve(next.head).parent.node.inlineContent)
      return setSelection(GardSelection.cursor(next.head, next.assoc, selection.goalColumn))
    selection = GardSelection.cursor(forward ? selection.to : selection.from, 0, selection.goalColumn)
  }
  let moved = nextVertical(view, selection, forward, undefined, !extend)
  return moved ? setSelection(moved, extend && state) : false
}

function pageHeight(view: Wordgard) {
  let marginTop = 0, marginBottom = 0
  for (let source of view.state.facet((view.constructor as typeof Wordgard).scrollMargins)) {
    let margins = source(view)
    if (margins?.top) marginTop = Math.max(margins?.top, marginTop)
    if (margins?.bottom) marginBottom = Math.max(margins?.bottom, marginBottom)
  }
  return Math.max(10, Math.min(view.scrollDOM.clientHeight - marginTop - marginBottom,
                               (view.dom.ownerDocument.defaultView || window).innerHeight) - 10)
}

/// Move the selection head one page up or down. Extend the selection
/// when the `extend` flag is true.
export const moveByPage: Command<{dir: "up" | "down", extend?: boolean}> = (view, {dir, extend}) => {
  let {state} = view, {selection} = state, forward = dir == "down"
  let moved = selection.empty || extend ? nextVertical(view, selection, forward, pageHeight(view))
    : forward ? GardSelection.cursor(selection.to, -1) : GardSelection.cursor(selection.from, 1)
  return moved ? setSelection(moved, extend && state) : false
}

// FIXME do we need a motion to texblock start/end variant?
export const moveToLineSide: Command<{
  dir: "left" | "right" | "forward" | "backward", extend?: boolean,
}> = (view, {dir, extend}) => {
  let pos = view.moveToLineBoundary(view.state.selection, isForward(dir, view.state))
  return pos ? setSelection(pos, extend && view.state) : false
}

export const moveToDocSide: Command.Pure<{side: "start" | "end", extend?: boolean}> = (target, {side, extend}) => {
  let {state} = target
  let pos = side == "start" ? GardSelection.atStart(state) : GardSelection.atEnd(state)
  if (state.selection.empty && pos.head == state.selection.head) return false
  return setSelection(pos, extend && state)
}

export const selectAll: Command.Pure = ({state}) => {
  return {
    selection: GardSelection.range(0, state.doc.length),
    userEvent: "select.all"
  }
}

/// Undo an edit. Does not have a default handler, but a handler is
/// added by the history extension.
export const undo: Command = () => false

/// Redo an edit. Does not have a default handler.
export const redo: Command = () => false
