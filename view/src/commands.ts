import {Node, Tag, TagType, Schema, Pos, NodePos, Slice, Text, Token,
        ChangeSpec, ChangeSet, CloseToken, OpenToken} from "@willows/doc"
import {EditorSelection, StateCommand} from "@willows/state"
import {EditorView} from "./editorview"
import {findClusterBreak} from "@marijn/find-cluster-break"

// FIXME move some of the helper functions to @willows/doc, reconsider
// their interfaces

/// Command functions are used in key bindings and other types of user
/// actions. Given an editor view, they check whether their effect can
/// apply to the editor, and if it can, perform it as a side effect
/// (which usually means [dispatching](#view.EditorView.dispatch) a
/// transaction) and return `true`.
export type Command = (target: EditorView) => boolean

export const insertLineBreakInCode: StateCommand = ({state, dispatch}) => {
  let {doc, selPos: sel} = state
  let block = sel.from.parent
  if (!block.node.isTextblock() || !block.node.type.preserveWhitespace || block.start != sel.to.parent.start) return false
  let props = state.selection.props || sel.from.props(sel.to)
  dispatch(state.update({
    changes: {from: sel.from.pos, to: sel.to.pos,
              insert: new Slice([(doc.schema.lineBreak ? doc.schema.lineBreak.create() : Node.text("\n")).withProps(props)])},
    selection: EditorSelection.cursor(sel.from.pos + 1, -1),
    scrollIntoView: true
  }))
  return true
}

/// If the selection is not in an inline context, insert an empty
/// default textblock in its position.
export const createTextblock: StateCommand = ({state, dispatch}) => {
  let sel = state.selPos
  if (sel.head.parent.node.inlineContent() || sel.anchor.parent.node.inlineContent()) return false
  let wrap = state.doc.schema.findWrapping(sel.from.parent.node.type, Text)
  if (!wrap) return false
  let content: Node[] = []
  for (let i = wrap.length - 1; i >= 0; i--) content = [wrap[i].create(content)]
  let slice = new Slice(content)
  dispatch(state.update({
    changes: {from: sel.from.pos, to: sel.to.pos, insert: slice, fit: true},
    selection: EditorSelection.cursor(sel.from.pos + slice.length, -1),
    normalizeSelection: true,
    scrollIntoView: true
  }))
  return true
}

export const liftEmptyBlock: StateCommand = ({state, dispatch}) => {
  let sel = state.selPos, block = sel.head.parent
  if (!sel.empty || !block.node.isTextblock() || block.node.children.length) return false
  let start = block.before, end = block.after, before: Token[] = [], after: Token[] = []
  for (let level = block.parent, index = block.index, atStart = true, atEnd = true, first = true;
       level; first = false, index = level.index, level = level.parent) {
    if (!first && level.node.type.canContain(block.node.type)) {
      dispatch(state.update({
        changes: [
          {from: start, to: block.before, insert: new Slice(before)},
          {from: block.after, to: end, insert: new Slice(after)}
        ],
        scrollIntoView: true
      }))
      return true
    }
    if (level.node.isInline() || level.node.type.isolating) break
    if (index) atStart = false
    if (atStart) start--
    else before.push(CloseToken)
    if (index < level.node.children.length - 1) atEnd = false
    if (atEnd) end++
    else after.unshift(new OpenToken(level.node.tag.split(false)))
  }
  return false
}

export const splitTextblock: StateCommand = ({state, dispatch}) => {
  let sel = state.selPos, before = sel.from.parent
  if (!before.node.isTextblock() || !before.parent) return false
  let after = sel.to.parent, tagAfter = null
  if (after.node.isTextblock()) {
    let atEnd = sel.to.pos == after.end, tag = after.node.tag.split(atEnd)
    if (tag.type.spec.splitTag) tagAfter = tag.type.spec.splitTag(tag, atEnd)
    if (atEnd && !tagAfter && after.parent) {
      let defaultType = state.doc.schema.defaultContentType(after.parent.node.type)
      if (defaultType) tagAfter = tag.changeType(defaultType)
    }
    if (!tagAfter) tagAfter = tag
  }
  let tokens: Token[] = [CloseToken]
  if (tagAfter) tokens.push(new OpenToken(tagAfter))
  let changes: ChangeSpec[] = [{
    from: sel.from.pos, to: sel.to.pos,
    insert: new Slice(tagAfter ? [CloseToken, new OpenToken(tagAfter)] : [CloseToken])
  }]
  if (sel.from.pos == before.start && before.parent) {
    let deflt = state.doc.schema.defaultContentType(before.parent.node.type)
    if (deflt && !deflt.eq(before.node.tag))
      changes.unshift({
        from: sel.from.pos - 1, to: sel.from.pos,
        insert: new Slice([new OpenToken(before.node.tag.changeType(deflt))])
      })
  }
  let changeSet = ChangeSet.create(state.doc, {correct: changes, local: true})
  dispatch(state.update({
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(sel.to.pos, 1)),
    scrollIntoView: true
  }))
  return true
}

export const deleteSelection: StateCommand = ({state, dispatch}) => {
  if (state.selection.ranges.every(r => r.from == r.to)) return false
  dispatch(state.update({
    changes: {correct: state.selection.ranges.map(r => ({from: r.from, to: r.to, fit: true})), local: true},
    normalizeSelection: true,
    scrollIntoView: true
  }))
  return true
}

function joinBlocks(before: Pos, after: Pos): ChangeSpec[] {
  let changes: ChangeSpec[] = [{from: before.pos, to: after.pos}]
  let dBefore = before.depth, dAfter = after.depth
  let tokensAfter: Token[] = [], posAfter = after.parent.after, end = posAfter
  if (dBefore > dAfter) {
    let extraContext: Tag[] = []
    for (let i = dBefore - dAfter, level = before.parent.parent!; i > 0; i--, level = level.parent!)
      extraContext.push(level.node.tag)
    let nodeAfter = after.parent.nextSibling
    for (let i = dBefore - dAfter - 1, joining = true; i >= 0; i--) {
      let context = extraContext[i]
      if (!joining || !nodeAfter || context.type != nodeAfter.type || !context.type.spec.autoJoin ||
          (typeof context.type.spec.autoJoin == "function" && !context.type.spec.autoJoin(context, nodeAfter.tag)))
        joining = false
      if (joining) end++
      else tokensAfter.push(CloseToken)
    }
  } else if (dAfter > dBefore) {
    for (let i = dAfter - dBefore, level = after.parent, atEnd = true; i > 0; i--, level = level.parent!) {
      if (level.nextSibling) atEnd = false
      if (atEnd) end++
      else tokensAfter.push(new OpenToken(level.parent!.node.tag))
    }
  }
  if (tokensAfter.length || end > posAfter)
    changes.push({from: posAfter, to: end, insert: new Slice(tokensAfter)})
  return changes
}

function clearNonFitting(node: Node, nodePos: number, type: TagType<any>) {
  let changes: ChangeSpec[] = []
  for (let i = 0, pos = nodePos + 1; i < node.children.length; i++) {
    let child = node.children[i], end = pos + child.length
    if (!type.canContain(child.type)) changes.push({from: pos, to: end})
    pos = end
  }
  return changes
}

export const joinBackward: StateCommand = ({state, dispatch}) => {
  let {head, empty} = state.selPos
  if (!empty || !head.parent.node.isTextblock() || head.pos != head.parent.start) return false
  let scan = head.parent, target = scan.node
  while (!scan.index) {
    if (!scan.parent) return false
    scan = scan.parent
    if (scan.node.type.isolating || !scan.node.isBlock()) return false
  }
  let before = scan.previousSibling!, parent = scan.parent!.node, pos = scan.start - 1
  while (!before.isTextblock()) {
    if (before.type.isolating || before.isAtom() || !before.isBlock()) return false
    let last = before.children.length - 1
    if (last < 0) return false
    parent = before
    before = before.children[last]
    pos--
  }
  let changes = joinBlocks(state.doc.resolve(pos - 1), head)
    .concat(clearNonFitting(head.parent.node, head.parent.before, before.type))
  if (!before.children.length && !before.tag.eq(target.tag) && parent.type.canContain(target.type))
    changes.push({
      from: pos - before.length, to: pos - before.length + 1,
      insert: new Slice([new OpenToken(before.tag.changeType(target.tag))])
    })
  dispatch(state.update({
    changes,
    selection: EditorSelection.cursor(pos - 1, -1),
    scrollIntoView: true
  }))
  return true
}

export const joinForward: StateCommand = ({state, dispatch}) => {
  let {head, empty} = state.selPos
  if (!empty || !head.parent.node.isTextblock() || head.pos != head.parent.end) return false
  let scan = head.parent, target = scan.node
  for (;;) {
    if (!scan.parent) return false
    if (scan.index < scan.parent.node.children.length - 1) break
    scan = scan.parent
    if (scan.node.type.isolating || !scan.node.isBlock()) return false
  }
  let after = scan.nextSibling!, parent = scan.parent.node, pos = scan.after
  while (!after.isTextblock()) {
    if (after.type.isolating || after.isAtom() || !after.isBlock()) return false
    if (!after.children.length) return false
    parent = after
    after = after.children[0]
    pos++
  }
  let posAfter = state.doc.resolve(pos + 1)
  let changes = joinBlocks(head, posAfter).concat(clearNonFitting(posAfter.parent.node, posAfter.parent.before, target.type))
  if (!target.children.length && !target.tag.eq(after.tag) && parent.type.canContain(after.type))
    changes.push({
      from: head.parent.before, to: head.parent.start,
      insert: new Slice([new OpenToken(target.tag.changeType(after.tag))])
    })
  dispatch(state.update({
    changes,
    scrollIntoView: true
  }))
  return true
}

// FIXME do auto-joining in delete commands

export const deleteBackward: StateCommand = ({state, dispatch}) => {
  let sel = state.selPos
  if (!sel.empty) return false
  if (sel.head.inText) {
    let before = sel.head.nodeBefore!
    let size = before.length - findClusterBreak(before.text!, before.length, false)
    dispatch(state.update({
      changes: {from: sel.head.pos - size, to: sel.head.pos},
      scrollIntoView: true
    }))
    return true
  }

  let {parent: scan, index, pos} = sel.head
  while (!index) {
    if (scan.node.type.isolating || !scan.parent) return false
    index = scan.index
    scan = scan.parent
    pos--
  }
  let before = scan.node.children[index - 1]
  for (;;) {
    if (before.type.isolating) return false
    if (before.isAtom()) break
    let last = before.children.length - 1
    if (last < 0) return false
    before = before.children[last]
    pos--
  }
  if (before.isText()) {
    let size = before.length - findClusterBreak(before.text, before.length, false)
    dispatch(state.update({
      changes: {from: pos - size, to: pos},
      scrollIntoView: true
    }))
    return true
  }
  let from = pos - before.length, to = pos
  let parent: NodePos | null = state.doc.resolve(pos).parent
  while (parent && parent.node.isBlock() && parent.node.children.length == 1) {
    if (!parent.parent) return false
    parent = parent.parent
    from--; to++
  }
  dispatch(state.update({
    changes: {from, to},
    scrollIntoView: true
  }))
  return true
}

export const deleteForward: StateCommand = ({state, dispatch}) => {
  let sel = state.selPos
  if (!sel.empty) return false
  if (sel.head.inText) {
    let after = sel.head.nodeAfter!
    let size = findClusterBreak(after.text!, 0)
    dispatch(state.update({
      changes: {from: sel.head.pos, to: sel.head.pos + size},
      scrollIntoView: true
    }))
    return true
  }

  let {parent: scan, index, pos} = sel.head
  while (index == scan.node.children.length) {
    if (scan.node.type.isolating || !scan.parent) return false
    index = scan.index + 1
    scan = scan.parent
    pos++
  }
  let after = scan.node.children[index]
  for (;;) {
    if (after.type.isolating) return false
    if (after.isAtom()) break
    if (!after.children.length) return false
    after = after.children[0]
    pos++
  }
  if (after.isText()) {
    let size = findClusterBreak(after.text, 0)
    dispatch(state.update({
      changes: {from: pos, to: pos + size},
      scrollIntoView: true
    }))
    return true
  }
  let from = pos, to = pos + after.length
  let parent: NodePos | null = state.doc.resolve(pos).parent
  while (parent && parent.node.isBlock() && parent.node.children.length == 1) {
    if (!parent.parent) return false
    parent = parent.parent
    from--; to++
  }
  dispatch(state.update({
    changes: {from, to},
    scrollIntoView: true
  }))
  return true
}

export function setTextblockType(tag: Tag<any>): StateCommand {
  return ({state, dispatch}) => {
    let changes: ChangeSpec[] = [], lastBlock = -1
    for (let {from, to} of state.selection.ranges) {
      state.doc.iterate(from, to, (node, pos, parent) => {
        if (node.isTextblock() && pos > lastBlock && !node.tag.eq(tag) && parent && parent.type.canContain(tag.type)) {
          lastBlock = pos
          // FIXME more refined handling of props
          changes.push({from: pos, to: pos + 1, insert: new Slice([new OpenToken(node.tag.changeType(tag))])})
          for (let ch of clearNonFitting(node, pos, tag.type)) changes.push(ch)
        }
      })
    }
    if (!changes.length) return false
    dispatch(state.update({changes, scrollIntoView: true}))
    return true
  }
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

export function wrapBlock(wrapper: Tag<any>): StateCommand {
  return ({state, dispatch}) => {
    let changes: ChangeSpec[] = [], lastTo = -1
    for (let {from, to} of state.selection.ranges) {
      let range = findWrappable(state.doc.resolve(from), state.doc.resolve(to), wrapper)
      if (!range || range.from.pos < lastTo) continue
      changes.push(wrapBlockRange(range, wrapper))
      lastTo = range.to.pos
    }
    if (!changes.length) return false
    dispatch(state.update({changes, scrollIntoView: true}))
    return true
  }
}

function textblockChild(schema: Schema, type: TagType<any>) {
  let wrap = schema.findWrapping(type, Text)
  return wrap && wrap.length == 1 ? wrap[0] : null
}

export function findUnwrappable(from: Pos, to: Pos, predicate?: (tag: Tag) => boolean) {
  let dFrom = from.depth, dTo = to.depth
  let fromStart = from.parent.node.inlineContent() ? from.parent.start : from.pos
  let toEnd = to.parent.node.inlineContent() ? to.parent.end : to.pos
  let innerCandidates: NodePos[] = []
  let outerCandidates: NodePos[] = []
  let {doc} = from
  doc.iterate(fromStart, toEnd, (node, p, parent) => {
    if (node.isBlock() && !node.isAtom() && !node.inlineContent() && parent && textblockChild(doc.schema, parent.type) &&
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

// FIXME move, rename
export function unwrapBlock1(block: NodePos, from?: number, to?: number): ChangeSpec {
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
        // FIXME drop atoms/isolating
        parent = new NodePos(parent, next, pos + 1, index)
        index = 0
        pos++
      }
    }
  }
  return changes
}

export function unwrapBlockType(type: TagType<any> | Tag<any> | ((tag: Tag<any>) => boolean)): StateCommand {
  let pred: (tag: Tag<any>) => boolean = typeof type == "function" ? type
    : type instanceof Tag ? tag => tag.type == type.type
    : tag => tag.type == type
  return ({state, dispatch}) => {
    let targets: NodePos[] = [], changes: ChangeSpec[] = []
    for (let {from, to} of state.selection.ranges) {
      if (!targets.some(t => t.after > from && t.before < to)) {
        let result = findUnwrappable(state.doc.resolve(from), state.doc.resolve(to), pred)
        if (result) for (let node of result) {
          targets.push(node)
          changes.push(unwrapBlock1(node, from, to))
        }
      }
    }
    if (!targets.length) return false
    dispatch(state.update({changes, scrollIntoView: true, normalizeSelection: true}))
    return true
  }
}

export const unwrapBlock = unwrapBlockType(() => true)

export const defaultEnter: Command = (view: EditorView) => {
  return insertLineBreakInCode(view) ||
    createTextblock(view) ||
    liftEmptyBlock(view) ||
    splitTextblock(view)
}

export const defaultBackspace: Command = (view: EditorView) => {
  return deleteSelection(view) ||
    joinBackward(view) ||
    deleteBackward(view)
}

export const defaultDelete: Command = (view: EditorView) => {
  return deleteSelection(view) ||
    joinForward(view) ||
    deleteForward(view)
}
