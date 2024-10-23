import {Node, Tag, TagType, Prop, NodePos, Slice, Text, Token,
        ChangeSpec, ChangeSet, CloseToken, OpenToken,
        joinBlocks, findWrappable, wrapBlockRange, findUnwrappable,
        unwrapBlock as doUnwrapBlock, clearNonFitting, canAddPropInRange} from "@willows/doc"
import {EditorSelection, StateCommand} from "@willows/state"
import {EditorView} from "./editorview"
import {findClusterBreak} from "@marijn/find-cluster-break"

/// Command functions are used in key bindings and other types of user
/// actions. Given an editor view, they check whether their effect can
/// apply to the editor, and if it can, perform it as a side effect
/// (which usually means [dispatching](#view.EditorView.dispatch) a
/// transaction) and return `true`.
export type Command = (target: EditorView) => boolean

// FIXME check behavior with inline nodes with content for all of these

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
  let sel = state.selPos, block = sel.head.textblockParent
  if (!sel.empty || !block || !sel.head.isAtStart(block) || !sel.head.isAtEnd(block)) return false
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
  let sel = state.selPos
  let before = sel.from.textblockParent
  if (!before || !before.parent) return false
  let tokens: Token[] = []
  for (let p = sel.from.parent;; p = p.parent!) {
    tokens.push(CloseToken)
    if (p == before) break
  }

  let after = sel.to.textblockParent, tagAfter = null
  if (after) {
    let atEnd = true, insert = tokens.length
    for (let p = sel.to.parent, index = sel.to.index;; index = p.index + 1, p = p.parent!) {
      if (index < p.node.children.length) atEnd = false
      let tag = p.node.tag.split(atEnd)
      if (tag.type.spec.splitTag) tagAfter = tag.type.spec.splitTag(tag, atEnd)
      if (atEnd && tag.isTextblock() && !tagAfter && p.parent) {
        let defaultType = state.doc.schema.defaultContentType(p.parent.node.type)
        if (defaultType) tagAfter = tag.changeType(defaultType)
      }
      tokens.splice(insert, 0, new OpenToken(tagAfter || tag))
      if (p == after) break
    }
  }
  let changes: ChangeSpec[] = [{
    from: sel.from.pos, to: sel.to.pos,
    insert: new Slice(tokens)
  }]
  if (sel.from.isAtStart(before)) {
    let deflt = state.doc.schema.defaultContentType(before.parent.node.type)
    if (deflt && !deflt.eq(before.node.tag))
      changes.unshift({
        from: before.before, to: before.start,
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

export const joinBackward: StateCommand = ({state, dispatch}) => {
  let {head, empty} = state.selPos, block = head.textblockParent
  if (!empty || !block || !head.isAtStart(block)) return false
  let scan = block, target = scan.node
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
  let changes = joinBlocks(state.doc.resolve(pos - 1).parent, block)
    .concat(clearNonFitting(block, before.type))
  if (!before.children.length && !before.tag.eq(target.tag) && parent.type.canContain(target.type))
    changes.push({
      from: pos - before.length, to: pos - before.length + 1,
      insert: new Slice([new OpenToken(before.tag.changeType(target.tag))])
    })
  let changeSet = ChangeSet.create(state.doc, changes)
  dispatch(state.update({
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(head.pos), -1),
    scrollIntoView: true
  }))
  return true
}

export const joinForward: StateCommand = ({state, dispatch}) => {
  let {head, empty} = state.selPos, block = head.textblockParent
  if (!empty || !block || !head.isAtEnd(block)) return false
  let scan = block, target = scan.node
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
  let blockAfter = state.doc.resolveNode(pos)!
  let changes = joinBlocks(block, blockAfter)
    .concat(clearNonFitting(blockAfter, target.type))
  if (!target.children.length && !target.tag.eq(after.tag) && parent.type.canContain(after.type))
    changes.push({
      from: block.before, to: block.start,
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
          for (let ch of clearNonFitting(state.doc.resolveNode(pos)!, tag.type)) changes.push(ch)
        }
      })
    }
    if (!changes.length) return false
    dispatch(state.update({changes, scrollIntoView: true}))
    return true
  }
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
          changes.push(doUnwrapBlock(node, from, to))
        }
      }
    }
    if (!targets.length) return false
    dispatch(state.update({changes, scrollIntoView: true, normalizeSelection: true}))
    return true
  }
}

export const unwrapBlock = unwrapBlockType(() => true)

export function toggleProp(prop: Prop<any>): StateCommand {
  return ({state, dispatch}) => {
    let {selection, doc} = state
    if (selection.empty) {
      let selProps = selection.props || state.selPos.head.props()
      let newProps = prop.isInSet(selProps) ? prop.removeFromSet(selProps) : prop.addToSet(selProps)
      dispatch(state.update({
        selection: EditorSelection.cursor(selection.head, selection.assoc, selection.goalColumn, newProps)
      }))
    } else if (selection.ranges.some(r => canAddPropInRange(doc, r.from, r.to, prop))) {
      dispatch(state.update({changes: selection.ranges.map(r => ({from: r.from, to: r.to, add: prop}))}))
    } else {
      dispatch(state.update({changes: selection.ranges.map(r => ({from: r.from, to: r.to, remove: prop}))}))
    }
    return true
  }
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

export const defaultDelete: Command = (view: EditorView) => {
  return deleteSelection(view) ||
    joinForward(view) ||
    deleteForward(view)
}
