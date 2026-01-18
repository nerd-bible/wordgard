import {Plot, Node, Mark, NodePos, PlotPos, Leaf, Token, ChangeSet,
        // FIXME move these into this package?
        joinBlocks, findWrappable, wrapBlockRange, findUnwrappable,
        unwrapBlock as doUnwrapBlock, clearNonFitting, canAddMarkInRange} from "wordgard/doc"
import {EditorSelection, EditorState, Direction, autoJoinBlocks} from "wordgard/state"
import {type EditorView} from "wordgard/view"
import {findClusterBreak} from "@marijn/find-cluster-break"
import {Command} from "./command"

// FIXME split commands and helper functions into different files

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

/// If the cursor is in an empty textblock that can be lifted out of a
/// parent, return a transaction that does this.
export function liftEmptyBlock(state: EditorState) {
  let sel = state.sel, block = sel.head.textblockParent
  if (!sel.empty || !block || !sel.head.isAtStart(block) || !sel.head.isAtEnd(block)) return null
  let start = block.before, end = block.after, before: Token[] = [], after: Token[] = []
  for (let level = block.parent, index = block.index, atStart = true, atEnd = true, first = true;
       level; first = false, index = level.index, level = level.parent) {
    if (!first && level.node.type.canContain(block.node.type)) return state.update({
      changes: [
        {from: start, to: block.before, insert: before},
        {from: block.after, to: end, insert: after}
      ],
      scrollIntoView: true,
      userEvent: "unwrap.empty"
    })
    if (level.node.isInline || level.node.type.isolating) break
    if (index) atStart = false
    if (atStart) start--
    else before.push(Plot.End)
    if (index < level.node.content.length - 1) atEnd = false
    if (atEnd) end++
    else after.unshift(level.node.tag.split(false))
  }
  return null
}

/// Split the textblock at the cursor position, if any. If the
/// textblock is the first child of a list item, also split that item,
/// unless `splitListItem` is false.
export function splitTextblock(state: EditorState, splitListItem = true) {
  let sel = state.sel
  let before = sel.from.textblockParent
  if (!before || !before.parent) return null
  let tokens: Token[] = []
  for (let p = sel.from.parent;; p = p.parent!) {
    tokens.push(Plot.End)
    if (p == before) break
  }

  if (splitListItem && !before.parent.node.type.isList &&
      before.isFirst && before.parent.parent?.node.type.isList)
    tokens.push(Plot.End, before.parent.node.tag.split(false))

  let after = sel.to.textblockParent
  if (after) {
    let atEnd = true, insert = tokens.length
    for (let p = sel.to.parent, index = sel.to.index;; index = p.index + 1, p = p.parent!) {
      if (index < p.node.content.length) atEnd = false
      let tag = p.node.tag.split(atEnd), nextTag = atEnd && !p.node.type.spec.preserveOnSplitAtEnd ? null : tag
      if (!nextTag || !p.parent!.node.type.canContain(tag.type)) {
        if (!atEnd) return null
        let defaultType = state.doc.schema.defaultContentPlot(p.parent!.node.type)
        if (defaultType) tag = tag.changeType(defaultType)
        else return null
      }
      tokens.splice(insert, 0, tag)
      if (p == after) break
    }
  }
  let changes: ChangeSet.Spec[] = [{
    from: sel.from.pos, to: sel.to.pos,
    insert: tokens
  }]
  if (sel.from.isAtStart(before)) {
    let deflt = state.doc.schema.defaultContentPlot(before.parent.node.type)
    if (deflt && !deflt.eq(before.node.tag))
      changes.unshift({
        from: before.before, to: before.start,
        insert: [before.node.tag.changeType(deflt)]
      })
  }
  let changeSet = ChangeSet.create(state.doc, {correct: changes, local: true})
  return state.update({
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(sel.to.pos, 1)),
    scrollIntoView: true,
    userEvent: "split.textblock"
  })
}

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

/// Returns a transaction that deletes the selection, or null if the
/// selection is empty.
export function deleteSelection(state: EditorState) {
  if (state.selection.ranges.every(r => r.from == r.to)) return null
  return state.update(autoJoinBlocks(state, {
    changes: {correct: state.selection.ranges.map(r => ({from: r.from, to: r.to, fit: true})), local: true},
    normalizeSelection: true,
    scrollIntoView: true,
    userEvent: "delete.selection"
  }))
}

/// If the cursor is at the start of a textblock that can be joined to
/// a textblock before it, return a transaction to performs this join.
export function joinBackward(state: EditorState) {
  let {head, empty} = state.sel, block = head.textblockParent
  if (!empty || !block || !head.isAtStart(block)) return null
  let scan = block, target = scan.node
  while (!scan.index) {
    if (!scan.parent) return null
    scan = scan.parent
    if (scan.node.type.isolating || !scan.node.isBlock) return null
  }
  let before = scan.previousSibling!, parent = scan.parent!.node, pos = scan.start - 1
  while (before.isLeaf || !before.isTextblock) {
    if (before.isLeaf || before.type.isolating || state.isAtom(pos - before.length, before) || !before.isBlock) return null
    let last = before.content.length - 1
    if (last < 0) return null
    parent = before
    before = before.content[last]
    pos--
  }
  let changes = joinBlocks(state.doc.resolve(pos - 1).parent, block)
    .concat(clearNonFitting(block, before.type))
  if (!before.content.length && !before.tag.eq(target.tag) && parent.type.canContain(target.type))
    changes.push({
      from: pos - before.length, to: pos - before.length + 1,
      insert: [before.tag.changeType(target.tag)]
    })
  let changeSet = ChangeSet.create(state.doc, changes)
  return state.update({
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(head.pos), -1),
    scrollIntoView: true,
    userEvent: "join.backward"
  })
}

/// If the cursor is at the start of a list item that has another item
/// before it, return a transaction that joins those two items.
export function joinListItems(state: EditorState) {
  let {empty, head} = state.sel
  if (!empty || head.index || head.inText) return null
  for (let scan = head.parent;;) {
    let next = scan.parent
    if (!next) return null
    if (scan.node.isBlock && next.node.type.isList) {
      let prev = scan.previousSibling
      if (!prev || !prev.isLeaf && scan.node.content.some(ch => !prev.type.canContain(ch.type))) return null
      return state.update({
        changes: {from: scan.before - 1, to: scan.before + 1},
        userEvent: "join.backward.list",
        scrollIntoView: true
      })
    }
    if (scan.index) return null
    scan = next
  }
}

/// If the cursor is at the end of a textblock that can be joined to
/// the textblock after it, return a transaction that performs this
/// join.
export function joinForward(state: EditorState) {
  let {head, empty} = state.sel, block = head.textblockParent
  if (!empty || !block || !head.isAtEnd(block)) return null
  let scan = block, target = scan.node
  for (;;) {
    if (!scan.parent) return null
    if (scan.index < scan.parent.node.content.length - 1) break
    scan = scan.parent
    if (scan.node.type.isolating || !scan.node.isBlock) return null
  }
  let after = scan.nextSibling!, parent = scan.parent.node, pos = scan.after
  while (after.isLeaf || !after.isTextblock) {
    if (after.isLeaf || after.type.isolating || state.isAtom(pos, after) ||
        !after.isBlock || !after.content.length)
      return null
    parent = after
    after = after.content[0]
    pos++
  }
  let blockAfter = state.doc.resolveNode(pos) as PlotPos
  let changes = joinBlocks(block, blockAfter)
    .concat(clearNonFitting(blockAfter, target.type))
  if (!target.content.length && !target.tag.eq(after.tag) && parent.type.canContain(after.type))
    changes.push({
      from: block.before, to: block.start,
      insert: [target.tag.changeType(after.tag)]
    })
  return state.update({
    changes,
    scrollIntoView: true,
    userEvent: "join.forward"
  })
}

/// Create a transaction that deletes the text cluster or atomic node
/// in front of the cursor, if possible.
export function deleteBackward(state: EditorState, word = false) {
  let sel = state.sel
  if (!sel.empty) return null

  let {parent: scan, index, pos} = sel.head
  if (!sel.head.inText) while (!index) {
    if (scan.node.type.isolating || !scan.parent) return null
    index = scan.index
    scan = scan.parent
    pos--
  }
  let next = sel.head.inText ? sel.head.nodeBefore! : scan.node.content[--index]
  for (;;) {
    if (next.isPlot && next.type.isolating) return null
    if (next.isLeaf || state.isAtom(pos - next.length, next)) break
    let last = next.content.length - 1
    if (last < 0) return null
    next = next.content[last]
    pos--
  }
  if (next.is(Leaf.Text)) {
    let size = 0
    if (word) { // FIXME refine definition, check agains other tools
      for (let i = next.param.length, sawNonWS = false;;) {
        if (!/\s/.test(next.param[i - 1])) sawNonWS = true
        else if (sawNonWS) break
        i--; size++
        if (i == 0) {
          if (!index) break
          next = scan.node.content[--index]
          if (!next.is(Leaf.Text)) break
          i = next.param.length
        }
      }
    } else {
      size = next.length - findClusterBreak(next.param, next.length, false)
    }
    return state.update({
      changes: {from: pos - size, to: pos},
      scrollIntoView: true,
      userEvent: "delete.backward"
    })
  }
  let from = pos - next.length, to = pos
  let parent: PlotPos | null = state.doc.resolve(pos).parent
  while (parent && parent.node.isBlock && parent.node.content.length == 1) {
    if (!parent.parent) return null
    parent = parent.parent
    from--; to++
  }
  return state.update({
    changes: {from, to},
    scrollIntoView: true,
    userEvent: "delete.backward"
  })
}

/// Return a transaction that deletes the element (text cluster or
/// leaf node) after the cursor, if any.
export function deleteForward(state: EditorState, word = false) {
  let sel = state.sel
  if (!sel.empty) return null

  let {parent: scan, index, pos} = sel.head
  if (!sel.head.inText) while (index == scan.node.content.length) {
    if (scan.node.type.isolating || !scan.parent) return null
    index = scan.index + 1
    scan = scan.parent
    pos++
  }
  let next = sel.head.inText ? sel.head.nodeAfter! : scan.node.content[index]
  for (;;) {
    if (next.isPlot && next.type.isolating) return null
    if (next.isLeaf || state.isAtom(pos, next)) break
    if (!next.content.length) return null
    next = next.content[0]
    pos++
  }
  if (next.is(Leaf.Text)) {
    let size = 0
    if (word) {
      for (let i = 0, sawNonWS = false;;) {
        if (!/\s/.test(next.param[i])) sawNonWS = true
        else if (sawNonWS) break
        i++; size++
        if (i == next.param.length) {
          if (index == scan.node.content.length - 1) break
          next = scan.node.content[++index]
          if (!next.is(Leaf.Text)) break
          i = 0
        }
      }
    } else {
      size = findClusterBreak(next.param, 0)
    }
    return state.update({
      changes: {from: pos, to: pos + size},
      scrollIntoView: true,
      userEvent: "delete.forward"
    })
  }
  let from = pos, to = pos + next.length
  let parent: PlotPos | null = state.doc.resolve(pos).parent
  while (parent && parent.node.isBlock && parent.node.content.length == 1) {
    if (!parent.parent) return null
    parent = parent.parent
    from--; to++
  }
  return state.update({
    changes: {from, to},
    scrollIntoView: true,
    userEvent: "delete.forward"
  })
}

export const changeTextblockType = Command.define<Plot.Tag.Any>((view, tag) => {
  let tr = setTextblockType(view.state, tag)
  return tr ? (view.dispatch(tr), true) : false
})

/// Try to change the type of selected textblocks to the given tag.
/// Will return null if no such changes are possible.
export function setTextblockType(state: EditorState, tag: Plot.Tag.Any) {
  let changes: ChangeSet.Spec[] = []
  for (let block of selectedTextblocks(state)) {
    if (!block.node.tag.eq(tag) && block.parent && block.parent.node.type.canContain(tag.type)) {
      changes.push({from: block.before, to: block.before + 1, insert: [block.node.tag.changeType(tag)]})
      for (let ch of clearNonFitting(block, tag.type)) changes.push(ch)
    }
  }
  if (!changes.length) return null
  return state.update(autoJoinBlocks(state, {changes, scrollIntoView: true, userEvent: "settype"}))
}

/// Try to wrap selected textblocks in the given wrapper. Will return
/// null if no wrapping is possible.
export function wrapBlock(state: EditorState, wrapper: Plot.Tag.Any) {
  let changes: ChangeSet.Spec[] = [], lastTo = -1
  for (let {from, to} of state.selection.ranges) {
    let range = findWrappable(state.doc.resolve(from), state.doc.resolve(to), wrapper)
    if (!range || range.from.pos < lastTo) continue
    changes.push(wrapBlockRange(range, wrapper))
    lastTo = range.to.pos
  }
  if (!changes.length) return null
  return state.update(autoJoinBlocks(state, {changes, scrollIntoView: true, userEvent: "wrap"}))
}

export const unwrapBlock = Command.define<Node.Selector | null>((view, selector) => {
  let tr = unwrapBlockType(view.state, selector ?? undefined)
  return tr ? (view.dispatch(tr), true) : false
})

export const toggleBlock = Command.define<Plot.Tag.Any>((view, tag) => {
  let tr = unwrapBlockType(view.state, tag) || wrapBlock(view.state, tag)
  return tr ? (view.dispatch(tr), true) : false
})

/// Try to unwrap blocks around the selection. The second argument, if
/// given, indicates what kind of wrapping plots may be removed.
/// Returns null when no unwrapping is possible.
export function unwrapBlockType(state: EditorState, type?: Node.Selector) {
  let pred = Node.selector(type)
  let targets: NodePos[] = [], changes: ChangeSet.Spec[] = []
  for (let {from, to} of state.selection.ranges) {
    if (!targets.some(t => t.after > from && t.before < to)) {
      let result = findUnwrappable(state.doc.resolve(from), state.doc.resolve(to), pred)
      if (result) for (let node of result) {
        targets.push(node)
        changes.push(doUnwrapBlock(node, from, to))
      }
    }
  }
  if (!targets.length) return null
  return state.update(autoJoinBlocks(state, {changes, scrollIntoView: true, normalizeSelection: true, userEvent: "unwrap"}))
}

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

function selectedTextblocks(state: EditorState) {
  let textblocks: PlotPos[] = [], lastBlock = -1
  for (let {from, to} of state.selection.ranges) {
    state.doc.iterate(from, to, (node, pos, parent) => {
      if (node.isPlot && node.isTextblock && pos > lastBlock) {
        textblocks.push(state.doc.resolveNode(pos) as PlotPos)
        lastBlock = pos
      }
    })
  }
  return textblocks
}

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
    if (parent.node.tag.type.isList) return first ? node as PlotPos : null
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

/// Move the selection head one unit (text cluster, atomic node, or
/// node boundary) in the indicated direction. When `extend` is true,
/// keep the selection anchor in place. The default handler moves
/// visually through bidirectional text, so when going left, the
/// motion will go back in left-to-right text, and
/// forward in right-to-left text.
export const moveByUnit = Command.define<{dir: "left" | "right", extend?: boolean}>((view, {dir, extend}) => {
  let {state} = view, forward = (dir == "right") == ltrAtCursor(state)
  let moved = state.selection.nextNormalCursor(state, forward)
  return moved ? setSelection(view, moved, extend) : false
})

/// Move the selection head one word in the indicated direction. Keep
/// the anchor in place if `extend` is true. The default handler moves
/// visually.
export const moveByWord = Command.define<{dir: "left" | "right", extend?: boolean}>((view, {dir, extend}) => {
  let {state} = view, forward = (dir == "right") == ltrAtCursor(state)
  let moved = state.selection.skipWord(state, forward)
  return moved ? setSelection(view, moved, extend) : false
})

function nextVertical(view: EditorView, sel: EditorSelection, forward: boolean, distance?: number) {
  let next = view.moveVertically(sel, forward, distance)
  if (next) return next
  let end = (forward ? EditorSelection.atEnd : EditorSelection.atStart)(view.state)
  return end.head == view.state.selection.head ? null : end
}

/// Move the selection head one line up or down. When `extend` is
/// true, keep the anchor in place.
export const moveByLine = Command.define<{dir: "up" | "down", extend?: boolean}>((view, {dir, extend}) => {
  let {state} = view, {selection} = state, forward = dir == "down"
  let moved = selection.empty || extend ? nextVertical(view, selection, forward)
    : forward ? EditorSelection.cursor(selection.to, -1) : EditorSelection.cursor(selection.from, 1)
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

export const moveToLineSide = Command.define<{side: "start" | "end", extend?: boolean}>((view, {side, extend}) => {
  let pos = view.moveToLineBoundary(view.state.selection, side == "end")
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

/// Redo an editor. Does not have a default handler.
export const redo = Command.define()
