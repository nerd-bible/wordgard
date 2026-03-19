import {Plot, Node, Mark, NodePos, PlotPos, Leaf, Token, ChangeSet} from "wordgard/doc"
import {EditorSelection, EditorState, Direction} from "wordgard/state"
import {type EditorView} from "wordgard/view"
import {joinForward, joinBackward, liftEmptyBlock, setTextblockType,
        deleteSelection, deleteForward, deleteBackward,
        splitTextblock, joinListItems, unwrapBlockType, wrapBlock,
        canAddMarkInRange, selectedTextblocks} from "./helper"
import {Command} from "./command"
import {findClusterBreak} from "@marijn/find-cluster-break"

// FIXME check behavior around inline nodes with content for all of these

/// Command to insert a line break. The default handler will, if the
/// schema defines a [line break](#doc.Leaf.Spec.isLineBreak) node and
/// the selection's parent node allows that, insert such a node.
/// Otherwise, in nodes marked as
/// [whitespace-preserving](#doc.Plot.Spec.preserveWhitespace), this
/// will insert a line break.
export const insertLineBreak = Command.define(({state, dispatch}) => {
  let {doc, sel} = state
  let brk = doc.schema.lineBreak, parent = sel.from.parent.node.type
  let marks = state.selection.marks || sel.from.marks(sel.to)
  if (brk && parent.canContain(brk.type)) {
    dispatch(state.update({
      changes: {from: sel.from.pos, to: sel.to.pos, insert: [brk.withMarks(marks)], fit: true},
      selection: {anchor: sel.from.pos + 1},
      scrollIntoView: true,
      userEvent: "insert.linebreak"
    }))
    return true
  } else if (parent.preserveWhitespace && sel.to.parent.start == sel.from.parent.start) {
    dispatch(state.update({
      changes: {from: sel.from.pos, to: sel.to.pos, insert: [Leaf.text("\n", marks)]},
      selection: EditorSelection.cursor(sel.from.pos + 1, -1),
      scrollIntoView: true,
      userEvent: "input"
    }))
    return true
  } else {
    return false
  }
})

/// The command that handles enter presses. The default handler will,
/// if the selection is not in an inline context, insert an empty
/// default textblock in its position. Otherwise it first tries
/// `liftEmptyTextblock`, then `splitTextblock`.
export const enter = Command.define(view => {
  let {state, dispatch} = view, {sel, doc} = state
  // When not in an inline context, try to create new empty textblock
  if (!sel.head.parent.node.inlineContent || !sel.anchor.parent.node.inlineContent) {
    let wrap = doc.schema.findWrapping(sel.from.parent.node.type, Leaf.Text)
    if (!wrap) return false
    let content: Plot[] = []
    for (let i = wrap.length - 1; i >= 0; i--) content = [wrap[i].create(content)]
    dispatch(state.update({
      changes: {from: sel.from.pos, to: sel.to.pos, insert: content, fit: true},
      selection: EditorSelection.cursor(sel.from.pos + content[0].length, -1),
      normalizeSelection: true,
      scrollIntoView: true,
      userEvent: "insert.textblock"
    }))
    return true
  }
  let tr = liftEmptyBlock(view.state) || splitTextblock(view.state)
  if (!tr) return false
  view.dispatch(tr)
  return true
})

export const deleteUnit = Command.define<"forward" | "backward">((view, dir) => {
  let tr = deleteSelection(view.state) || (dir == "forward"
    ? joinForward(view.state) || deleteForward(view.state)
    : joinListItems(view.state) || joinBackward(view.state) || deleteBackward(view.state))
  return tr ? (view.dispatch(tr), true) : false
})

export const deleteWord = Command.define<"forward" | "backward">((view, dir) => {
  let tr = deleteSelection(view.state) || (dir == "forward"
    ? joinForward(view.state) || deleteForward(view.state, true)
    : joinListItems(view.state) || joinBackward(view.state) || deleteBackward(view.state, true))
  return tr ? (view.dispatch(tr), true) : false
})

export const deleteToLineEnd = Command.define<"forward" | "backward">((view, dir) => {
  let tr = deleteSelection(view.state), {selection} = view.state
  if (tr) return (view.dispatch(tr), true)
  let end = view.moveToLineBoundary(selection, dir == "forward")
  if (!end || end.head == selection.head) return false
  view.dispatch({
    changes: {correct: dir == "forward" ? {from: selection.head, to: end.head} : {from: end.head, to: selection.head}},
    scrollIntoView: true,
    userEvent: "delete." + dir
  })
  return true
})

export const transposeChars = Command.define(view => {
  let {state} = view, {sel} = state, head = state.selection.head
  if (!sel.empty) return false
  let before = sel.head.nodeBefore, after = sel.head.nodeAfter
  if (!before || !before.is(Leaf.Text) || !after || !after.is(Leaf.Text)) return false
  let lenBefore = before.param.length - findClusterBreak(before.param, before.param.length, false)
  let lenAfter = findClusterBreak(after.param, 0)
  view.dispatch({
    changes: [{from: head - lenBefore, to: head},
              {from: head + lenAfter, insert: [Leaf.text(before.param.slice(before.param.length - lenBefore))]}],
    selection: EditorSelection.cursor(head + lenAfter, -1),
    scrollIntoView: true,
    userEvent: "transpose"
  })
  return true
})

export const changeTextblockType = Command.define<Plot.Tag.Any>((view, tag) => {
  let tr = setTextblockType(view.state, tag)
  return tr ? (view.dispatch(tr), true) : false
})

export const unwrapBlock = Command.define<Node.Selector | null>((view, selector) => {
  let tr = unwrapBlockType(view.state, selector ?? undefined)
  return tr ? (view.dispatch(tr), true) : false
})

export const toggleBlock = Command.define<Plot.Tag.Any>((view, tag) => {
  let tr = unwrapBlockType(view.state, tag) || wrapBlock(view.state, tag)
  return tr ? (view.dispatch(tr), true) : false
})

/// Toggle the given mark. If there is no selection, it is added to
/// the cursor's active marks, or removed if it is already in there.
/// Otherwise, if any selected content allows for the mark to be
/// added, it is added. If not, remove the mark from the selection.
export const toggleMark = Command.define<Mark<any>>((view, mark) => {
  let {state} = view, {selection, doc} = state
  if (selection.empty) {
    let selMarks = selection.marks || state.sel.head.marks(), add = !mark.isInSet(selMarks)
    let newMarks = add ? mark.addToSet(selMarks) : mark.removeFromSet(selMarks)
    view.dispatch({
      selection: EditorSelection.cursor(selection.head, selection.assoc, selection.goalColumn, newMarks),
      userEvent: add ? "mark.add" : "mark.remove"
    })
  } else if (selection.ranges.some(r => canAddMarkInRange(doc, r.from, r.to, mark))) {
    view.dispatch({
      changes: selection.ranges.map(r => ({from: r.from, to: r.to, add: mark})),
      userEvent: "mark.add"
    })
  } else {
    view.dispatch({
      changes: selection.ranges.map(r => ({from: r.from, to: r.to, remove: mark})),
      userEvent: "mark.remove"
    })
  }
  return true
})

/// Search the schema for a mark with the given label (that has a
/// default parameter), and run [`toggleMark`](#commands.toggleMark)
/// with that mark.
export const toggleMarkByLabel = Command.define<Mark.Label>((view, label) => {
  let mark: Mark | null = null
  for (let type of view.state.doc.schema.marks) {
    if (type.hasLabel(label) && type.default) { mark = type.default; break }
  }
  if (!mark) return false
  return toggleMark.dispatch(view, mark)
})

export const setAlignment = Command.define<null | "end" | "center">((view, align) => {
  let {state} = view
  let mark = state.doc.schema.marks.find(m => m.hasLabel(Mark.Label.Alignment))
  if (!mark) return false
  let changes: ChangeSet.Spec[] = []
  for (let block of selectedTextblocks(state)) {
    let cur = block.node.tag.mark(mark)
    if (cur != align && mark.canTarget(block.node.type))
      changes.push(align ? {from: block.before, add: mark.of(align)} : {from: block.before, remove: mark.of(cur)})
  }
  if (!changes.length) return false
  view.dispatch({
    changes,
    userEvent: "mark.set.alignment",
  })
  return true
})

export const toggleList = Command.define<Plot.Tag.Any>((view, listTag) => {
  let {state} = view, blocks = selectedTextblocks(state)
  if (!blocks.length) return false
  let tr = addList(state, blocks, listTag) || removeList(state, blocks, listTag)
  return tr ? (view.dispatch(tr), true) : false
})

export const listIsActive = (listTag: Plot.Tag.Any): (state: EditorState) => boolean => state => {
  return selectedTextblocks(state).every(b => {
    let item = isListItem(b)
    return item && item.parent!.node.type == listTag.type
  })
}

function isListItem(node: NodePos): PlotPos | null {
  for (let first = true;;) {
    let {parent} = node
    if (!parent) return null
    if (parent.node.tag.type.inGroup("List")) return first ? node as PlotPos : null
    first = node.isFirst
    node = parent
  }
}

function autoJoin(a: Plot.Tag.Any, b: Plot.Tag.Any) {
  let {autoJoin} = a.type.spec
  return typeof autoJoin == "function" ? autoJoin(a, b) : typeof autoJoin == "boolean" ? autoJoin : a.eq(b)
}

function addList(state: EditorState, blocks: PlotPos[], listTag: Plot.Tag.Any) {
  let plan: ({wrap: PlotPos, item: Plot.Tag.Any} | {change: NodePos, item: NodePos})[] = []
  let chBefore: Set<number> = new Set, chAfter: Set<number> = new Set
  let lastItem = -1
  for (let block of blocks) {
    let item = isListItem(block), wrap
    if (!item && block.parent && block.parent.node.type.canContain(listTag.type) &&
        ((wrap = state.doc.schema.findWrapping(listTag.type, block.node.type)) && wrap.length == 1 ||
          (wrap = state.doc.schema.findWrapping(listTag.type, Leaf.Text)) && wrap.length == 1)) {
      chAfter.add(block.before)
      chBefore.add(block.after)
      plan.push({wrap: block, item: wrap[0]})
      lastItem = block.before
    } else if (item?.parent && item.parent.node.tag.type != listTag.type &&
               listTag.type.canContain(item.node.type) &&
               item.parent.parent && item.parent.parent.node.type.canContain(listTag.type) &&
               item.before != lastItem) {
      chAfter.add(item.before)
      chBefore.add(item.after)
      if (item.isFirst) chAfter.add(item.parent.before)
      if (item.isLast) chBefore.add(item.parent.after)
      plan.push({change: block, item})
      lastItem = item.before
    }
  }
  if (!plan.length) return null
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
  return state.update({changes, userEvent: "wrap.list"})
}

function removeList(state: EditorState, blocks: NodePos[], listTag: Plot.Tag.Any) {
  let plan: {item: PlotPos, rewrap: Plot.Tag.Any | null}[] = [], lastItem = -1
  let chBefore: Set<number> = new Set, chAfter: Set<number> = new Set
  for (let block of blocks) {
    let item = isListItem(block)
    if (!item) continue
    let list = item.parent!, parent = list.parent, rewrap: Node.Tag | null = null
    if (parent && list.node.isPlot && list.node.type == listTag.type && item.before != lastItem &&
        (item.node.isTextblock
          ? (rewrap = state.doc.schema.defaultContentPlot(parent.node.type)) && rewrap.isTextblock
          : parent.node.type.canContain(block.node.type))) {
      lastItem = item.before
      plan.push({item, rewrap: rewrap as Plot.Tag.Any})
      chAfter.add(item.before)
      chBefore.add(item.after)
    }
  }
  if (!plan.length) return null
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
  return state.update({changes, userEvent: "unwrap.list"})
}

function setSelection(view: EditorView, selection: EditorSelection, extend?: boolean) {
  view.dispatch(view.state.update({
    selection: extend ? EditorSelection.range(view.state.selection.anchor, selection.head, selection.goalColumn, selection.marks)
      : selection,
    scrollIntoView: true,
    userEvent: "select"
  }))
  return true
}

function ltrAtCursor(state: EditorState) {
  let block = state.sel.head.textblockParent
  return state.textDirection(block ? block.node.tag : undefined) == Direction.LTR
}

function isForward(dir: "left" | "right" | "forward" | "backward", state: EditorState) {
  return dir == "forward" ? true : dir == "backward" ? false : (dir == "right") == ltrAtCursor(state)
}

/// Move the selection head one unit (text cluster, atomic node, or
/// node boundary) in the indicated direction. When `extend` is true,
/// keep the selection anchor in place. The default handler moves
/// visually through bidirectional text, so when going left, the
/// motion will go back in left-to-right text, and
/// forward in right-to-left text.
export const moveByUnit = Command.define<{dir: "left" | "right" | "forward" | "backward", extend?: boolean}>((view, {dir, extend}) => {
  let {state} = view, {selection} = state, forward = isForward(dir, state)
  if (!selection.empty && !extend) {
    let next = selection.normalCursorAtBound(state, forward)
    return next ? setSelection(view, next) : false
  } else {
    let next = selection.nextNormalCursor(state, forward)
    if (!next) return false
    if (!extend) state.doc.iterate(Math.min(selection.head, next.head), Math.max(selection.head, next.head), (node, pos) => {
      if (node.isPlot) return !node.type.isolating
      if (node.type.isSelectable) next = EditorSelection.range(pos, pos + node.length)
    })
    return setSelection(view, next, !!extend)
  }
})

/// Move the selection head one word in the indicated direction. Keep
/// the anchor in place if `extend` is true. The default handler moves
/// visually.
export const moveByWord = Command.define<{dir: "left" | "right", extend?: boolean}>((view, {dir, extend}) => {
  let {state} = view, forward = (dir == "right") == ltrAtCursor(state)
  let moved = state.selection.skipWord(state, forward)
  return moved ? setSelection(view, moved, extend) : false
})

function nextVertical(view: EditorView, sel: EditorSelection, forward: boolean,
                      distance?: number, allowNode?: boolean) {
  let next = view.moveVertically(sel, forward, distance, allowNode)
  if (next) return next
  let end = (forward ? EditorSelection.atEnd : EditorSelection.atStart)(view.state)
  return end.head == view.state.selection.head ? null : end
}

/// Move the selection head one line up or down. When `extend` is
/// true, keep the anchor in place.
export const moveByLine = Command.define<{dir: "up" | "down", extend?: boolean}>((view, {dir, extend}) => {
  let {state} = view, {selection} = state, forward = dir == "down"
  if (state.sel.node) {
    let next = !extend && state.selection.normalCursorAtBound(state, forward)
    if (next && !state.doc.resolve(next.head).parent.node.inlineContent)
      return setSelection(view, EditorSelection.cursor(next.head, next.assoc, selection.goalColumn))
    selection = EditorSelection.cursor(forward ? selection.to : selection.from, 0, selection.goalColumn)
  }
  let moved = nextVertical(view, selection, forward, undefined, !extend)
  return moved ? setSelection(view, moved, extend) : false
})

function pageHeight(view: EditorView) {
  let marginTop = 0, marginBottom = 0
  for (let source of view.state.facet((view.constructor as typeof EditorView).scrollMargins)) {
    let margins = source(view)
    if (margins?.top) marginTop = Math.max(margins?.top, marginTop)
    if (margins?.bottom) marginBottom = Math.max(margins?.bottom, marginBottom)
  }
  return Math.max(10, Math.min(view.scrollDOM.clientHeight - marginTop - marginBottom,
                               (view.dom.ownerDocument.defaultView || window).innerHeight) - 10)
}

/// Move the selection head one page up or down. Extend the selection
/// when the `extend` flag is true.
export const moveByPage = Command.define<{dir: "up" | "down", extend?: boolean}>((view, {dir, extend}) => {
  let {state} = view, {selection} = state, forward = dir == "down"
  let moved = selection.empty || extend ? nextVertical(view, selection, forward, pageHeight(view))
    : forward ? EditorSelection.cursor(selection.to, -1) : EditorSelection.cursor(selection.from, 1)
  return moved ? setSelection(view, moved, extend) : false
})

// FIXME do we need a motion to texblock start/end variant?
export const moveToLineSide = Command.define<{
  dir: "left" | "right" | "forward" | "backward", extend?: boolean
}>((view, {dir, extend}) => {
  let pos = view.moveToLineBoundary(view.state.selection, isForward(dir, view.state))
  return pos ? setSelection(view, pos, extend) : false
})

export const moveToDocSide = Command.define<{side: "start" | "end", extend?: boolean}>((view, {side, extend}) => {
  let {state} = view
  let pos = side == "start" ? EditorSelection.atStart(state) : EditorSelection.atEnd(state)
  if (state.selection.empty && pos.head == state.selection.head) return false
  return setSelection(view, pos, extend)
})

export const selectAll = Command.define(view => {
  view.dispatch({
    selection: EditorSelection.range(0, view.state.doc.length),
    userEvent: "select.all"
  })
  return true
})

/// Undo an edit. Does not have a default handler, but a handler is
/// added by the history extension.
export const undo = Command.define()

/// Redo an edit. Does not have a default handler.
export const redo = Command.define()
