import {Plot, Leaf, Node} from "./node"
import {Pos, PlotPos} from "./pos"
import { Mark } from "./mark"
import {Schema} from "./schema"
import {ChangeSet} from "./change"
import {Token} from "./slice"

export function clearNonFitting(node: PlotPos, type: Plot.Type<any>) {
  let changes: ChangeSet.Spec[] = []
  for (let i = 0, pos = node.start; i < node.node.content.length; i++) {
    let child = node.node.content[i], end = pos + child.length
    if (!type.canContain(child.type)) changes.push({from: pos, to: end})
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
  for (;;) {
    if (!pFrom.parent || pFrom.node.type.isolating) return null
    if (pFrom.parent.start == pTo.parent!.start && pFrom.parent.node.type.canContain(wrapper.type)) break
    pFrom = pFrom.parent; pTo = pTo.parent!
  }
  let {schema} = from.doc
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
export function findUnwrappable(from: Pos, to: Pos, predicate?: (type: Node.Type<any>) => boolean) {
  let dFrom = from.depth, dTo = to.depth
  let fromStart = from.parent.node.inlineContent ? from.parent.start : from.pos
  let fromTextblock = from.textblockParent?.node.type
  let toEnd = to.parent.node.inlineContent ? to.parent.end : to.pos
  let innerCandidates: PlotPos[] = []
  let outerCandidates: PlotPos[] = []
  let {doc} = from
  doc.iterate(fromStart, toEnd, (node, p, parent) => {
    if (node.isBlock && node.isPlot && !node.inlineContent && parent &&
        (fromTextblock ? parent.type.canContain(fromTextblock) : textblockChild(doc.schema, parent.type)) &&
        (!predicate || predicate(node.type))) {
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

/// Unwrap the given block node, or the node's children between `from`
/// and `to`.
export function unwrapBlock(block: PlotPos, from?: number, to?: number): ChangeSet.Spec {
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
          let deflt = block.doc.schema.createDefault(outer.type)
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
      if (outer.type.canContain(next.type) || wrapText && next.isPlot && next.inlineContent) {
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
          if (outer.type.canContain(next.type)) {
            replaceGap(pos, [])
          } else {
            // If it doesn't fit directly but can be moved into a
            // different text block, do that
            replaceGap(pos + 1, [wrapText!])
            changes.push(clearNonFitting(new PlotPos(parent, next as Plot, pos, index), wrapText!.type))
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
    if (type.canTarget(node.type)) found = true
    return true
  })
  return found
}
