import {Plot, Node, Mark, NodePos, PlotPos, Leaf, Token, ChangeSet, Pos, Schema} from "wordgard/doc"
import {EditorSelection, EditorState, autoJoinBlocks} from "wordgard/state"
import {findClusterBreak} from "@marijn/find-cluster-break"

// FIXME should these get their own module?

/// If the cursor is in an empty textblock that can be lifted out of a
/// parent, return a transaction that does this.
export function liftEmptyBlock(state: EditorState) {
  let sel = state.sel, block = sel.head.textblockParent
  if (!sel.empty || !block || !sel.head.isAtStart(block) || !sel.head.isAtEnd(block)) return null
  let start = block.before, end = block.after, before: Token[] = [], after: Token[] = []
  for (let level = block.parent, index = block.index, atStart = true, atEnd = true, first = true;
       level; first = false, index = level.index, level = level.parent) {
    if (!first && state.doc.schema.canContain(level.node.type, block.node.type)) return state.update({
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
  let sel = state.sel, {schema} = state.doc
  let before = sel.from.textblockParent
  if (!before || !before.parent) return null
  let tokens: Token[] = []
  for (let p = sel.from.parent;; p = p.parent!) {
    tokens.push(Plot.End)
    if (p == before) break
  }

  if (splitListItem && !before.parent.node.type.hasRole(Node.Role.List) &&
      before.isFirst && before.parent.parent?.node.type.hasRole(Node.Role.List))
    tokens.push(Plot.End, before.parent.node.tag.split(false))

  let after = sel.to.textblockParent
  if (after) {
    let atEnd = true, insert = tokens.length
    for (let p = sel.to.parent, index = sel.to.index;; index = p.index + 1, p = p.parent!) {
      if (index < p.node.content.length) atEnd = false
      let tag = p.node.tag.split(atEnd), nextTag = atEnd && !p.node.type.spec.preserveOnSplitAtEnd ? null : tag
      if (!nextTag || !schema.canContain(p.parent!.node.type, tag.type)) {
        if (!atEnd) return null
        let defaultType = schema.defaultContentPlot(p.parent!.node.type)
        if (defaultType) tag = schema.addMarksFrom(tag, defaultType)
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
    let deflt = schema.defaultContentPlot(before.parent.node.type)
    if (deflt && !deflt.eq(before.node.tag))
      changes.unshift({
        from: before.before, to: before.start,
        insert: [schema.addMarksFrom(before.node.tag, deflt)]
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
    if (before.isLeaf || before.type.isAtom || before.type.isolating || !before.isBlock) return null
    let last = before.content.length - 1
    if (last < 0) return null
    parent = before
    before = before.content[last]
    pos--
  }
  let {schema} = state.doc
  let changes = joinBlocks(state.doc.resolve(pos - 1).parent, block)
    .concat(clearNonFitting(schema, block, before.type))
  if (!before.content.length && !before.tag.eq(target.tag) && schema.canContain(parent.type, target.type))
    changes.push({
      from: pos - before.length, to: pos - before.length + 1,
      insert: [schema.addMarksFrom(before.tag, target.tag)]
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
    if (scan.node.isBlock && next.node.type.hasRole(Node.Role.List)) {
      let prev = scan.previousSibling
      if (!prev || !prev.isLeaf && scan.node.content.some(ch => !state.doc.schema.canContain(prev.type, ch.type))) return null
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
    if (after.isLeaf || after.type.isolating || after.type.isAtom || !after.isBlock || !after.content.length)
      return null
    parent = after
    after = after.content[0]
    pos++
  }
  let blockAfter = state.doc.resolveNode(pos) as PlotPos
  let {schema} = state.doc
  let changes = joinBlocks(block, blockAfter)
    .concat(clearNonFitting(schema, blockAfter, target.type))
  if (!target.content.length && !target.tag.eq(after.tag) && schema.canContain(parent.type, after.type))
    changes.push({
      from: block.before, to: block.start,
      insert: [schema.addMarksFrom(target.tag, after.tag)]
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
    if (next.isLeaf || next.type.isAtom) break
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
    if (next.isLeaf || next.type.isAtom) break
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

/// Try to change the type of selected textblocks to the given tag.
/// Will return null if no such changes are possible.
export function setTextblockType(state: EditorState, tag: Plot.Tag.Any) {
  let changes: ChangeSet.Spec[] = [], {schema} = state.doc
  for (let block of selectedTextblocks(state)) {
    if (!block.node.tag.eq(tag) && block.parent && schema.canContain(block.parent.node.type, tag.type)) {
      changes.push({from: block.before, to: block.before + 1, insert: [schema.addMarksFrom(block.node.tag, tag)]})
      for (let ch of clearNonFitting(schema, block, tag.type)) changes.push(ch)
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

/// Try to unwrap blocks around the selection. The second argument, if
/// given, indicates what kind of wrapping plots may be removed.
/// Returns null when no unwrapping is possible.
export function unwrapBlockType(state: EditorState, query?: Node.Query) {
  let targets: NodePos[] = [], changes: ChangeSet.Spec[] = []
  for (let {from, to} of state.selection.ranges) {
    if (!targets.some(t => t.after > from && t.before < to)) {
      let result = findUnwrappable(state.doc.schema, state.doc.resolve(from), state.doc.resolve(to), query)
      if (result) for (let node of result) {
        targets.push(node)
        changes.push(unwrapBlock(node, from, to))
      }
    }
  }
  if (!targets.length) return null
  return state.update(autoJoinBlocks(state, {changes, scrollIntoView: true, normalizeSelection: true, userEvent: "unwrap"}))
}

export function selectedTextblocks(state: EditorState) {
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

export function clearNonFitting(schema: Schema, node: PlotPos, type: Plot.Type<any>) {
  let changes: ChangeSet.Spec[] = []
  for (let i = 0, pos = node.start; i < node.node.content.length; i++) {
    let child = node.node.content[i], end = pos + child.length
    if (!schema.canContain(type, child.type)) changes.push({from: pos, to: end})
    pos = end
  }
  return changes
}

/// Find a way to wrap the blocks betwen `from` and `to` in a node
/// with the given tag. Returns precise start and end positions where
/// a wrap is possible, or null if none is possible.
export function findWrappable(from: Pos, to: Pos, wrapper: Plot.Tag.Any) {
  let dFrom = from.depth, dTo = to.depth
  let pFrom = from.parent, pTo = to.parent
  while (dFrom > dTo) { pFrom = pFrom.parent!; dFrom-- }
  while (dTo > dFrom) { pTo = pTo.parent!; dTo-- }
  let {schema} = from.doc
  for (;;) {
    if (!pFrom.parent || pFrom.node.type.isolating) return null
    if (pFrom.parent.start == pTo.parent!.start && schema.canContain(pFrom.parent.node.type, wrapper.type)) break
    pFrom = pFrom.parent; pTo = pTo.parent!
  }
  for (let i = pFrom.index; i < pTo.index + 1; i++) {
    let ch = pFrom.parent.node.content[i]
    if (!schema.findWrapping(wrapper.type, ch.type)) return null
  }
  return {from: new Pos(pFrom.parent, pFrom.before, pFrom.index, 0),
          to: new Pos(pFrom.parent, pTo.after, pTo.index + 1, 0)}
}

/// Wrap the given range in the given wrapper tag. The caller is
/// responsible for verifying that this is actually a valid wrapping.
/// It is recommended to use [`findWrappable`](#view.findWrappable)
/// for finding wrap positions in non-trivial situations.
export function wrapBlockRange(range: {from: Pos, to: Pos}, wrapper: Plot.Tag.Any) {
  let changes: ChangeSet.Spec[] = [], parent = range.from.parent.node
  for (let i = range.from.index, openWrappers = 0, pos = range.from.pos;; i++) {
    let tokens: Token[] = []
    for (let j = 0; j < openWrappers; j++) tokens.push(Plot.End)
    if (i == range.from.index) {
      tokens.push(wrapper)
    } else if (i == range.to.index) {
      tokens.push(Plot.End)
      changes.push({from: pos, insert: tokens})
      break
    }
    let child = parent.content[i]
    let {schema} = range.from.doc
    let wrapping = schema.findWrapping(wrapper.type, child.type)!
    for (let tag of wrapping) tokens.push(tag)
    openWrappers = wrapping.length
    changes.push({from: pos, insert: tokens})
    pos += child.length
  }
  return changes
}

function textblockChild(schema: Schema, type: Plot.Type<any>) {
  let wrap = schema.findWrapping(type, Leaf.Text)
  return wrap && wrap.length == 1 ? wrap[0] : null
}

/// Find the set of block nodes around the given range that match the
/// predicate (if any) and can be unwrapped, meaning their content
/// gets moved out to a parent node.
export function findUnwrappable(schema: Schema, from: Pos, to: Pos, query?: Node.Query) {
  let dFrom = from.depth, dTo = to.depth
  let fromStart = from.parent.node.inlineContent ? from.parent.start : from.pos
  let fromTextblock = from.textblockParent?.node.type
  let toEnd = to.parent.node.inlineContent ? to.parent.end : to.pos
  let innerCandidates: PlotPos[] = []
  let outerCandidates: PlotPos[] = []
  let {doc} = from
  doc.iterate(fromStart, toEnd, (node, p, parent) => {
    if (node.isBlock && node.isPlot && !node.inlineContent && parent &&
        (fromTextblock ? doc.schema.canContain(parent.type, fromTextblock) : textblockChild(doc.schema, parent.type)) &&
        (!query || schema.matchNode(node.type, query))) {
      let pos = doc.resolveNode(p) as PlotPos, depth = pos.depth
      if (pos.before >= fromStart - (dFrom - depth + 1) && pos.after <= toEnd + (dTo - depth + 1))
        innerCandidates.push(pos)
      else
        outerCandidates.push(pos)
    }
  })
  let candidates = innerCandidates.length
    ? innerCandidates.sort((a, b) => (b.after - b.before) - (a.after - a.before))
    : outerCandidates.sort((a, b) => (a.after - a.before) - (b.after - b.before))
  if (!candidates.length) return null
  // Delete those that overlap earlier nodes
  for (let i = 1; i < candidates.length; i++) {
    let cur = candidates[i]
    for (let j = 0; j < i; j++) {
      let other = candidates[j]
      if (cur.after > other.before && cur.before < other.after) {
        candidates.splice(i--, 1)
        break
      }
    }
  }
  return candidates
}

// FIXME find export name that doesn't collide with command
/// Unwrap the given block node, or the node's children between `from`
/// and `to`.
function unwrapBlock(block: PlotPos, from?: number, to?: number): ChangeSet.Spec {
  let changes: ChangeSet.Spec[] = [], {schema} = block.doc
  let outer = block.parent!.node, wrapText = textblockChild(schema, outer.type)

  // The start of the gap we're currently moving over
  let gapStart = block.before
  // Track the current depth relative to the start of the gap
  let skippedDepth = 0
  // Emit a change that replaces the current gap with the given tokens
  let replaceGap = (to: number, tokens: Token[]) => {
    for (let i = 0; i < skippedDepth; i++) tokens.unshift(Plot.End)
    skippedDepth = 0
    if (to > gapStart || tokens.length)
      changes.push({from: gapStart, to, insert: tokens})
  }

  // Scan through the block
  let parent = block, index = 0, pos = block.start
  for (;;) {
    if (index == parent.node.content.length) {
      if (parent == block) { // End of entire block, delete closing tokens
        let tokens: Token[] = []
        // If parent becomes empty, put in a default replacement block
        if (gapStart == block.before && outer.content.length == 1) {
          let deflt = schema.createDefault(outer.type)
          if (deflt) tokens.push(deflt)
        }
        replaceGap(block.after, tokens)
        break
      } else { // Move out of an inner block
        if (gapStart == pos && skippedDepth > 0) {
          gapStart++
          skippedDepth--
        }
        pos++
        index = parent.index + 1
        parent = parent.parent!
      }
    } else {
      let next = parent.node.content[index]
      // Can be lifted
      if (schema.canContain(outer.type, next.type) || wrapText && next.isPlot && next.inlineContent) {
        if (from != null && pos + next.length <= from) { // Before from
          pos += next.length
          gapStart = pos
          // Reset skippedDepth to the depth after this node
          skippedDepth = 1
          for (let cx = parent; cx != block; cx = cx.parent!) skippedDepth++
          index++
        } else if (to != null && pos >= to) { // After to
          let tokens: Token[] = [], upto = pos
          // Create open tokens for the end of the unwrap, and exit
          for (let cx = parent, i = tokens.length, atStart = !index;; cx = cx.parent!) {
            if (cx.index > 0) atStart = false
            if (atStart) upto--
            else tokens.splice(i, 0, cx.node.tag.split(false))
            if (cx == block) break
          }
          replaceGap(upto, tokens)
          break
        } else {
          // Make sure this element is removed from the unwrapped parent
          if (schema.canContain(outer.type, next.type)) {
            replaceGap(pos, [])
          } else {
            // If it doesn't fit directly but can be moved into a
            // different text block, do that
            replaceGap(pos + 1, [wrapText!])
            changes.push(clearNonFitting(schema, new PlotPos(parent, next as Plot, pos, index), wrapText!.type))
          }
          pos += next.length
          index++
          gapStart = pos
        }
      } else if (next.isLeaf || next.type.isolating) {
        // Skip leaves and isolating nodes that cannot be moved up
        pos += next.length
        index++
      } else {
        // Enter anything else
        parent = new PlotPos(parent, next, pos, index)
        index = 0
        pos++
      }
    }
  }
  return changes
}

export function joinBlocks(before: PlotPos, after: PlotPos): ChangeSet.Spec[] {
  let changes: ChangeSet.Spec[] = [{from: before.end, to: after.start}]
  let dBefore = before.depth, dAfter = after.depth
  let tokensAfter: Token[] = [], posAfter = after.after, end = posAfter
  if (dBefore > dAfter) {
    let extraContext: Plot.Tag.Any[] = []
    for (let i = dBefore - dAfter, level = before.parent!; i > 0; i--, level = level.parent!)
      extraContext.push(level.node.tag)
    let nodeAfter = after.nextSibling
    for (let i = dBefore - dAfter - 1, joining = true; i >= 0; i--) {
      let context = extraContext[i]
      if (!joining || !nodeAfter || nodeAfter.isLeaf || nodeAfter.type != context.type || !context.type.spec.autoJoin ||
          (typeof context.type.spec.autoJoin == "function" && !context.type.spec.autoJoin(context, nodeAfter.tag)))
        joining = false
      if (joining) end++
      else tokensAfter.push(Plot.End)
    }
  } else if (dAfter > dBefore) {
    for (let i = dAfter - dBefore, level = after, atEnd = true; i > 0; i--, level = level.parent!) {
      if (level.nextSibling) atEnd = false
      if (atEnd) end++
      else tokensAfter.push(level.parent!.node.tag)
    }
  }
  if (tokensAfter.length || end > posAfter)
    changes.push({from: posAfter, to: end, insert: tokensAfter})
  return changes
}

export function canAddMarkInRange(doc: Plot.Doc, from: number, to: number, mark: Mark<any> | Mark.Type<any>) {
  let found = false, type = mark instanceof Mark ? mark.type : mark
  doc.iterate(from, to, node => {
    if (found || mark.isInSet(node.tag.marks)) return false
    if (doc.schema.markAllowed(type, node.type)) found = true
    return true
  })
  return found
}
