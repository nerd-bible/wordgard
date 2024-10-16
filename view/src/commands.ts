import {Node, Tag, TagType, Context, Pos, NodePos, Slice, Text, Token,
        ChangeSpec, ChangeSet, CloseToken, OpenToken} from "@willows/doc"
import {EditorSelection, StateCommand} from "@willows/state"
import {EditorView} from "./editorview"
import {findClusterBreak} from "@marijn/find-cluster-break"

/// Command functions are used in key bindings and other types of user
/// actions. Given an editor view, they check whether their effect can
/// apply to the editor, and if it can, perform it as a side effect
/// (which usually means [dispatching](#view.EditorView.dispatch) a
/// transaction) and return `true`.
export type Command = (target: EditorView) => boolean

export const insertLineBreakInCode: StateCommand = ({state, dispatch}) => {
  let {doc, sel: sel} = state
  if (!sel.from.node.type.preserveWhitespace || sel.from.start != sel.to.start) return false
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
  let sel = state.sel
  if (sel.head.node.inlineContent() || sel.anchor.node.inlineContent()) return false
  let wrap = state.doc.schema.findWrapping(sel.from.node.type, Text)
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
  let sel = state.sel, node = sel.head.node
  if (!sel.empty || !node.inlineContent() || node.children.length) return false
  let start = sel.head.before, end = sel.head.after, before: Token[] = [], after: Token[] = []
  for (let level = sel.head.parent, atStart = true, atEnd = true, first = true; level; first = false, level = level.parent) {
    if (!first && level.node.type.canContain(node.type)) {
      dispatch(state.update({
        changes: [
          {from: start, to: sel.head.before, insert: new Slice(before)},
          {from: sel.head.after, to: end, insert: new Slice(after)}
        ],
        scrollIntoView: true
      }))
      return true
    }
    if (level.node.isInline() || level.node.type.isolating) break
    if (level.index) atStart = false
    if (atStart) start--
    else before.push(CloseToken)
    if (level.index < level.node.children.length - 1) atEnd = false
    if (atEnd) end++
    else after.unshift(new OpenToken(level.node.tag))
  }
  return false
}

export const splitTextblock: StateCommand = ({state, dispatch}) => {
  let sel = state.sel
  if (!sel.from.node.isTextblock() || !sel.to.parent) return false
  let tagAfter = null
  if (sel.to.node.isTextblock()) {
    let tag = sel.to.node.tag, atEnd = sel.to.pos == sel.to.end
    if (tag.type.spec.splitTag) tagAfter = tag.type.spec.splitTag(tag, atEnd)
    if (atEnd && !tagAfter) tagAfter = state.doc.schema.defaultContentType(sel.to.parent.node.type)
    if (!tagAfter) tagAfter = tag
  }
  let tokens: Token[] = [CloseToken]
  if (tagAfter) tokens.push(new OpenToken(tagAfter))
  let changes: ChangeSpec[] = [{
    from: sel.from.pos, to: sel.to.pos,
    insert: new Slice(tagAfter ? [CloseToken, new OpenToken(tagAfter)] : [CloseToken])
  }]
  if (sel.from.pos == sel.from.start && sel.from.parent) {
    let deflt = state.doc.schema.defaultContentType(sel.from.parent.node.type)
    // FIXME make configurable? Inherit selected props?
    if (deflt && !deflt.eq(sel.from.node.tag))
      changes.unshift({from: sel.from.pos - 1, to: sel.from.pos, insert: new Slice([new OpenToken(deflt)])})
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

function clearNonFitting(target: NodePos, type: TagType<any>) {
  let changes: ChangeSpec[] = []
  for (let i = 0, pos = target.start; i < target.node.children.length; i++) {
    let child = target.node.children[i], end = pos + child.length
    if (!type.canContain(child.type)) changes.push({from: pos, to: end})
    pos = end
  }
  return changes
}

export const joinBackward: StateCommand = ({state, dispatch}) => {
  let sel = state.sel
  let head = state.doc.resolveX(state.selection.head)
  if (!sel.empty || !head.parent.node.isTextblock() || head.pos != head.parent.start) return false
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
  let changes = joinBlocks(state.doc.resolveX(pos - 1), head).concat(clearNonFitting(head.parent, before.type))
  if (!before.children.length && !before.tag.eq(target.tag) && parent.type.canContain(target.type))
    changes.push({
      from: pos - before.length, to: pos - before.length + 1,
      insert: new Slice([new OpenToken(target.tag)])
    })
  dispatch(state.update({
    changes,
    selection: EditorSelection.cursor(pos - 1, -1),
    scrollIntoView: true
  }))
  return true
}

export const deleteBackward: StateCommand = ({state, dispatch}) => {
  let sel = state.sel
  if (!sel.empty) return false
  let scan = sel.head
  if (scan.inText) {
    let before = scan.nodeBefore!
    let size = before.length - findClusterBreak(before.text!, before.length, false)
    dispatch(state.update({
      changes: {from: scan.pos - size, to: scan.pos},
      scrollIntoView: true
    }))
    return true
  }

  while (scan && !scan.index) {
    if (scan.node.type.isolating || !scan.parent) return false
    scan = scan.parent
  }
  if (!scan) return false
  let before = scan.nodeBefore, pos = scan.pos
  for (;;) {
    if (!before || before.type.isolating) return false
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
  let cx: Context | null = state.doc.resolve(pos)
  while (cx && cx.node.isBlock() && cx.node.children.length == 1 && cx.parent) {
    from--; to++
    cx = cx.parent
  }
  if (from == 0 && to == state.doc.length) return false
  dispatch(state.update({
    changes: {from, to},
    scrollIntoView: true
  }))
  return true
}

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
