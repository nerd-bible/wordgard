import {DocNode, Tag, TagType, Text} from "./node"
import {Pos, NodePos} from "./pos"
import {Schema} from "./schema"
import {ChangeSpec} from "./change"
import {Slice, Token, OpenToken, CloseToken} from "./slice"

export function clearNonFitting(node: NodePos, type: TagType<any>) {
  let changes: ChangeSpec[] = []
  for (let i = 0, pos = node.start; i < node.node.children.length; i++) {
    let child = node.node.children[i], end = pos + child.length
    if (!type.canContain(child.type)) changes.push({from: pos, to: end})
    pos = end
  }
  return changes
}

export function findWrappable(from: Pos, to: Pos, wrapper: Tag<any>) {
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
    let ch = pFrom.parent.node.children[i]
    if (!schema.findWrapping(wrapper.type, ch.type)) return null
  }
  return {from: new Pos(pFrom.parent, pFrom.before, pFrom.index, 0),
          to: new Pos(pFrom.parent, pTo.after, pTo.index + 1, 0)}
}

export function wrapBlockRange(range: {from: Pos, to: Pos}, wrapper: Tag<any>) {
  let changes: ChangeSpec[] = [], parent = range.from.parent.node
  for (let i = range.from.index, openWrappers = 0, pos = range.from.pos;; i++) {
    let tokens: Token[] = []
    for (let j = 0; j < openWrappers; j++) tokens.push(CloseToken)
    if (i == range.from.index) {
      tokens.push(new OpenToken(wrapper))
    } else if (i == range.to.index) {
      tokens.push(CloseToken)
      changes.push({from: pos, insert: new Slice(tokens)})
      break
    }
    let child = parent.children[i]
    let {schema} = range.from.doc
    let wrapping = schema.findWrapping(wrapper.type, child.type)!
    for (let tag of wrapping) tokens.push(new OpenToken(tag))
    openWrappers = wrapping.length
    changes.push({from: pos, insert: new Slice(tokens)})
    pos += child.length
  }
  return changes
}

function textblockChild(schema: Schema, type: TagType<any>) {
  let wrap = schema.findWrapping(type, Text)
  return wrap && wrap.length == 1 ? wrap[0] : null
}

// FIXME this still doesn't work properly on textblock-item-lists or definition lists
export function findUnwrappable(from: Pos, to: Pos, predicate?: (tag: Tag) => boolean) {
  let dFrom = from.depth, dTo = to.depth
  let fromStart = from.parent.node.inlineContent() ? from.parent.start : from.pos
  let fromTextblock = from.parent.node.isTextblock() ? from.parent.node.type : null
  let toEnd = to.parent.node.inlineContent() ? to.parent.end : to.pos
  let innerCandidates: NodePos[] = []
  let outerCandidates: NodePos[] = []
  let {doc} = from
  doc.iterate(fromStart, toEnd, (node, p, parent) => {
    if (node.isBlock() && !node.isAtom() && !node.inlineContent() && parent &&
        (fromTextblock ? parent.type.canContain(fromTextblock) : textblockChild(doc.schema, parent.type)) &&
        (!predicate || predicate(node.tag))) {
      let pos = doc.resolveNode(p)!, depth = pos.depth
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

export function unwrapBlock(block: NodePos, from?: number, to?: number): ChangeSpec {
  let changes: ChangeSpec[] = [], {schema} = block.doc
  let outer = block.parent!.node, wrapText = textblockChild(schema, outer.type)

  let parent = block, index = 0, pos = block.start
  let gapStart = block.before, skippedDepth = 0
  let replaceGap = (to: number, tokens: Token[]) => {
    for (let i = 0; i < skippedDepth; i++) tokens.unshift(CloseToken)
    skippedDepth = 0
    if (to > gapStart || tokens.length)
      changes.push({from: gapStart, to, insert: new Slice(tokens)})
  }

  for (;;) {
    if (index == parent.node.children.length) {
      if (parent == block) {
        let tokens: Token[] = []
        if (gapStart == block.before && outer.children.length == 1) {
          let deflt = block.doc.schema.createDefault(outer.type)
          if (deflt) tokens.push(deflt)
        }
        replaceGap(block.after, tokens)
        break
      } else {
        if (gapStart == pos && skippedDepth > 0) {
          gapStart++
          skippedDepth--
        }
        pos++
        index = parent.index + 1
        parent = parent.parent!
      }
    } else {
      let next = parent.node.children[index]
      if (outer.type.canContain(next.type) || wrapText && next.inlineContent()) {
        if (from != null && pos + next.length <= from) {
          pos += next.length
          gapStart = pos
          skippedDepth = 1
          for (let cx = parent; cx != block; cx = cx.parent!) skippedDepth++
          index++
        } else if (to != null && pos >= to) {
          let tokens: Token[] = [], upto = pos
          for (let cx = parent, i = tokens.length, atStart = !index;; cx = cx.parent!) {
            if (cx.index > 0) atStart = false
            if (atStart) upto--
            else tokens.splice(i, 0, new OpenToken(cx.node.tag.split(false)))
            if (cx == block) break
          }
          replaceGap(upto, tokens)
          break
        } else {
          if (outer.type.canContain(next.type)) {
            replaceGap(pos, [])
          } else {
            replaceGap(pos + 1, [new OpenToken(wrapText!)])
            changes.push(clearNonFitting(next, pos, wrapText!.type))
          }
          pos += next.length
          index++
          gapStart = pos
        }
      } else if (next.type.isolating || next.isAtom()) {
        pos += next.length
        index++
      } else {
        parent = new NodePos(parent, next, pos + 1, index)
        index = 0
        pos++
      }
    }
  }
  return changes
}

export function joinBlocks(before: NodePos, after: NodePos): ChangeSpec[] {
  let changes: ChangeSpec[] = [{from: before.end, to: after.start}]
  let dBefore = before.depth, dAfter = after.depth
  let tokensAfter: Token[] = [], posAfter = after.after, end = posAfter
  if (dBefore > dAfter) {
    let extraContext: Tag[] = []
    for (let i = dBefore - dAfter, level = before.parent!; i > 0; i--, level = level.parent!)
      extraContext.push(level.node.tag)
    let nodeAfter = after.nextSibling
    for (let i = dBefore - dAfter - 1, joining = true; i >= 0; i--) {
      let context = extraContext[i]
      if (!joining || !nodeAfter || context.type != nodeAfter.type || !context.type.spec.autoJoin ||
          (typeof context.type.spec.autoJoin == "function" && !context.type.spec.autoJoin(context, nodeAfter.tag)))
        joining = false
      if (joining) end++
      else tokensAfter.push(CloseToken)
    }
  } else if (dAfter > dBefore) {
    for (let i = dAfter - dBefore, level = after, atEnd = true; i > 0; i--, level = level.parent!) {
      if (level.nextSibling) atEnd = false
      if (atEnd) end++
      else tokensAfter.push(new OpenToken(level.parent!.node.tag))
    }
  }
  if (tokensAfter.length || end > posAfter)
    changes.push({from: posAfter, to: end, insert: new Slice(tokensAfter)})
  return changes
}

export function canAddPropInRange(doc: DocNode, from: number, to: number, prop: Prop<any>) {
  let found = false
  doc.iterate(from, to, node => {
    if (found || prop.isInSet(node.tag.props)) return false
    if (prop.type.canTarget(node.type)) found = true
    return true
  })
  return found
}
