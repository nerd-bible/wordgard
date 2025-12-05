import {Node, Tag, Prop, NodePos, Slice, Text, Token,
        ChangeSpec, ChangeSet, CloseToken,
        joinBlocks, findWrappable, wrapBlockRange, findUnwrappable,
        unwrapBlock as doUnwrapBlock, clearNonFitting, canAddPropInRange} from "@wordgard/doc"
import {EditorSelection, StateCommand, EditorState, Transaction, Direction, autoJoinBlocks} from "@wordgard/state"
import {EditorView} from "./editorview"
import {findClusterBreak} from "@marijn/find-cluster-break"
import {KeyBinding} from "./keymap"

/// Command functions are used in key bindings and other types of user
/// actions. Given an editor view, they check whether their effect can
/// apply to the editor, and if it can, perform it as a side effect
/// (which usually means [dispatching](#view.EditorView.dispatch) a
/// transaction) and return `true`.
export type Command = (target: EditorView) => boolean

// FIXME check behavior around inline nodes with content for all of these

export const insertLineBreak: StateCommand = ({state, dispatch}) => {
  let {doc, sel} = state
  let brk = doc.schema.lineBreak
  if (!brk || !sel.from.parent.node.type.canContain(brk.type)) return false
  dispatch(state.update({
    changes: {from: sel.from.pos, to: sel.to.pos, insert: new Slice([brk.create()]), fit: true},
    selection: {anchor: sel.from.pos + 1},
    scrollIntoView: true,
    userEvent: "insert.linebreak"
  }))
  return true
}

export const insertLineBreakInCode: StateCommand = ({state, dispatch}) => {
  let {doc, sel} = state
  let block = sel.from.parent
  if (!block.node.isTextblock || !block.node.type.preserveWhitespace || block.start != sel.to.parent.start) return false
  let props = state.selection.props || sel.from.props(sel.to)
  dispatch(state.update({
    changes: {from: sel.from.pos, to: sel.to.pos,
              insert: new Slice([(doc.schema.lineBreak ? doc.schema.lineBreak.create() : Node.text("\n")).withProps(props)])},
    selection: EditorSelection.cursor(sel.from.pos + 1, -1),
    scrollIntoView: true,
    userEvent: "input"
  }))
  return true
}

/// If the selection is not in an inline context, insert an empty
/// default textblock in its position.
export const createTextblock: StateCommand = ({state, dispatch}) => {
  let sel = state.sel
  if (sel.head.parent.node.inlineContent || sel.anchor.parent.node.inlineContent) return false
  let wrap = state.doc.schema.findWrapping(sel.from.parent.node.type, Text)
  if (!wrap) return false
  let content: Node[] = []
  for (let i = wrap.length - 1; i >= 0; i--) content = [wrap[i].create(content)]
  let slice = new Slice(content)
  dispatch(state.update({
    changes: {from: sel.from.pos, to: sel.to.pos, insert: slice, fit: true},
    selection: EditorSelection.cursor(sel.from.pos + slice.length, -1),
    normalizeSelection: true,
    scrollIntoView: true,
    userEvent: "insert.textblock"
  }))
  return true
}

/// If the cursor is in an empty textblock that can be lifted out of a
/// parent, this command will do so.
export const liftEmptyBlock: StateCommand = ({state, dispatch}) => {
  let sel = state.sel, block = sel.head.textblockParent
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
        scrollIntoView: true,
        userEvent: "unwrap.empty"
      }))
      return true
    }
    if (level.node.isInline || level.node.type.isolating) break
    if (index) atStart = false
    if (atStart) start--
    else before.push(CloseToken)
    if (index < level.node.children.length - 1) atEnd = false
    if (atEnd) end++
    else after.unshift(level.node.tag.split(false))
  }
  return false
}

/// Split the textblock at the cursor position, if any.
export const splitTextblock: StateCommand = ({state, dispatch}) => {
  let sel = state.sel
  let before = sel.from.textblockParent
  if (!before || !before.parent) return false
  let tokens: Token[] = []
  for (let p = sel.from.parent;; p = p.parent!) {
    tokens.push(CloseToken)
    if (p == before) break
  }

  let after = sel.to.textblockParent
  if (after) {
    let atEnd = true, insert = tokens.length
    for (let p = sel.to.parent, index = sel.to.index;; index = p.index + 1, p = p.parent!) {
      if (index < p.node.children.length) atEnd = false
      let tag = p.node.tag.split(atEnd), nextTag = atEnd && !p.node.type.spec.preserveOnSplitAtEnd ? null : tag
      if (!nextTag || !p.parent!.node.type.canContain(tag.type)) {
        if (!atEnd) return false
        let defaultType = state.doc.schema.defaultContentType(p.parent!.node.type)
        if (defaultType) tag = tag.changeType(defaultType)
        else return false
      }
      tokens.splice(insert, 0, tag)
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
        insert: new Slice([before.node.tag.changeType(deflt)])
      })
  }
  let changeSet = ChangeSet.create(state.doc, {correct: changes, local: true})
  dispatch(state.update({
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(sel.to.pos, 1)),
    scrollIntoView: true,
    userEvent: "split.textblock"
  }))
  return true
}

export const deleteSelection: StateCommand = ({state, dispatch}) => {
  if (state.selection.ranges.every(r => r.from == r.to)) return false
  dispatch(state.update(autoJoinBlocks(state, {
    changes: {correct: state.selection.ranges.map(r => ({from: r.from, to: r.to, fit: true})), local: true},
    normalizeSelection: true,
    scrollIntoView: true,
    userEvent: "delete.selection"
  })))
  return true
}

export const joinBackward: StateCommand = ({state, dispatch}) => {
  let {head, empty} = state.sel, block = head.textblockParent
  if (!empty || !block || !head.isAtStart(block)) return false
  let scan = block, target = scan.node
  while (!scan.index) {
    if (!scan.parent) return false
    scan = scan.parent
    if (scan.node.type.isolating || !scan.node.isBlock) return false
  }
  let before = scan.previousSibling!, parent = scan.parent!.node, pos = scan.start - 1
  while (!before.isTextblock) {
    if (before.type.isolating || state.isAtom(pos - before.length, before) || !before.isBlock) return false
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
      insert: new Slice([before.tag.changeType(target.tag)])
    })
  let changeSet = ChangeSet.create(state.doc, changes)
  dispatch(state.update({
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(head.pos), -1),
    scrollIntoView: true,
    userEvent: "join.backward"
  }))
  return true
}

export const joinListItems: StateCommand = ({state, dispatch}) => {
  let {empty, head} = state.sel
  if (!empty || head.index || head.inText) return false
  for (let scan = head.parent;;) {
    let next = scan.parent
    if (!next) return false
    if (scan.node.isBlock && next.node.type.isList) {
      let prev = scan.previousSibling
      if (!prev || scan.node.children.some(ch => !prev.type.canContain(ch.type))) return false
      dispatch(state.update({
        changes: {from: scan.before - 1, to: scan.before + 1},
        userEvent: "join.backward.list",
        scrollIntoView: true
      }))
      return true
    }
    if (scan.index) return false
    scan = next
  }
}

export const joinForward: StateCommand = ({state, dispatch}) => {
  let {head, empty} = state.sel, block = head.textblockParent
  if (!empty || !block || !head.isAtEnd(block)) return false
  let scan = block, target = scan.node
  for (;;) {
    if (!scan.parent) return false
    if (scan.index < scan.parent.node.children.length - 1) break
    scan = scan.parent
    if (scan.node.type.isolating || !scan.node.isBlock) return false
  }
  let after = scan.nextSibling!, parent = scan.parent.node, pos = scan.after
  while (!after.isTextblock) {
    if (after.type.isolating || state.isAtom(pos, after) || !after.isBlock) return false
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
      insert: new Slice([target.tag.changeType(after.tag)])
    })
  dispatch(state.update({
    changes,
    scrollIntoView: true,
    userEvent: "join.forward"
  }))
  return true
}

export const deleteBackward: StateCommand = ({state, dispatch}) => {
  let sel = state.sel
  if (!sel.empty) return false
  if (sel.head.inText) {
    let before = sel.head.nodeBefore!
    let size = before.length - findClusterBreak(before.text!, before.length, false)
    dispatch(state.update(autoJoinBlocks(state, {
      changes: {from: sel.head.pos - size, to: sel.head.pos},
      scrollIntoView: true,
      userEvent: "delete.backward"
    })))
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
    if (state.isAtom(pos - before.length, before)) break
    let last = before.children.length - 1
    if (last < 0) return false
    before = before.children[last]
    pos--
  }
  if (before.isText) {
    let size = before.length - findClusterBreak(before.text!, before.length, false)
    dispatch(state.update({
      changes: {from: pos - size, to: pos},
      scrollIntoView: true,
      userEvent: "delete.backward"
    }))
    return true
  }
  let from = pos - before.length, to = pos
  let parent: NodePos | null = state.doc.resolve(pos).parent
  while (parent && parent.node.isBlock && parent.node.children.length == 1) {
    if (!parent.parent) return false
    parent = parent.parent
    from--; to++
  }
  dispatch(state.update({
    changes: {from, to},
    scrollIntoView: true,
    userEvent: "delete.backward"
  }))
  return true
}

export const deleteForward: StateCommand = ({state, dispatch}) => {
  let sel = state.sel
  if (!sel.empty) return false
  if (sel.head.inText) {
    let after = sel.head.nodeAfter!
    let size = findClusterBreak(after.text!, 0)
    dispatch(state.update(autoJoinBlocks(state, {
      changes: {from: sel.head.pos, to: sel.head.pos + size},
      scrollIntoView: true,
      userEvent: "delete.forward"
    })))
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
    if (state.isAtom(pos, after)) break
    if (!after.children.length) return false
    after = after.children[0]
    pos++
  }
  if (after.isText) {
    let size = findClusterBreak(after.text!, 0)
    dispatch(state.update({
      changes: {from: pos, to: pos + size},
      scrollIntoView: true,
      userEvent: "delete.forward"
    }))
    return true
  }
  let from = pos, to = pos + after.length
  let parent: NodePos | null = state.doc.resolve(pos).parent
  while (parent && parent.node.isBlock && parent.node.children.length == 1) {
    if (!parent.parent) return false
    parent = parent.parent
    from--; to++
  }
  dispatch(state.update({
    changes: {from, to},
    scrollIntoView: true,
    userEvent: "delete.forward"
  }))
  return true
}

export function setTextblockType(tag: Tag<any>): StateCommand {
  return ({state, dispatch}) => {
    let changes: ChangeSpec[] = []
    for (let block of selectedTextblocks(state)) {
      if (!block.node.tag.eq(tag) && block.parent && block.parent.node.type.canContain(tag.type)) {
        changes.push({from: block.before, to: block.before + 1, insert: new Slice([block.node.tag.changeType(tag)])})
        for (let ch of clearNonFitting(block, tag.type)) changes.push(ch)
      }
    }
    if (!changes.length) return false
    dispatch(state.update(autoJoinBlocks(state, {changes, scrollIntoView: true, userEvent: "settype"})))
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
    dispatch(state.update(autoJoinBlocks(state, {changes, scrollIntoView: true, userEvent: "wrap"})))
    return true
  }
}

export function unwrapBlockType(type: Tag.Type<any> | Tag<any> | ((tag: Tag<any>) => boolean)): StateCommand {
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
    dispatch(state.update(autoJoinBlocks(state, {changes, scrollIntoView: true, normalizeSelection: true, userEvent: "unwrap"})))
    return true
  }
}

export const unwrapBlock = unwrapBlockType(() => true)

export function toggleProp(prop: Prop<any>): StateCommand {
  return ({state, dispatch}) => {
    let {selection, doc} = state
    if (selection.empty) {
      let selProps = selection.props || state.sel.head.props(), add = !prop.isInSet(selProps)
      let newProps = add ? prop.addToSet(selProps) : prop.removeFromSet(selProps)
      dispatch(state.update({
        selection: EditorSelection.cursor(selection.head, selection.assoc, selection.goalColumn, newProps),
        userEvent: add ? "prop.add" : "prop.remove"
      }))
    } else if (selection.ranges.some(r => canAddPropInRange(doc, r.from, r.to, prop))) {
      dispatch(state.update({
        changes: selection.ranges.map(r => ({from: r.from, to: r.to, add: prop})),
        userEvent: "prop.add"
      }))
    } else {
      dispatch(state.update({
        changes: selection.ranges.map(r => ({from: r.from, to: r.to, remove: prop})),
        userEvent: "prop.remove"
      }))
    }
    return true
  }
}

function selectedTextblocks(state: EditorState) {
  let textblocks: NodePos[] = [], lastBlock = -1
  for (let {from, to} of state.selection.ranges) {
    state.doc.iterate(from, to, (node, pos, parent) => {
      if (node.isTextblock && pos > lastBlock) {
        textblocks.push(state.doc.resolveNode(pos)!)
        lastBlock = pos
      }
    })
  }
  return textblocks
}

// FIXME support textblock items
export function toggleList(listTag: Tag<any>): StateCommand {
  return ({state, dispatch}) => {
    let blocks = selectedTextblocks(state)
    if (!blocks.length) return false
    let tr = addList(state, blocks, listTag) || removeList(state, blocks, listTag)
    if (tr) dispatch(tr)
    return !!tr
  }
}

function isListItem(node: NodePos) {
  for (let top = true;;) {
    let {parent} = node
    if (!parent) return null
    if (parent.node.tag.type.isList) return top ? node : null
    top = !node.index
    node = parent
  }
}

const enum PlanPos { // FIXME don't need specific values?
  WrapBefore = 1,
  WrapAfter = 2,
  ConvertBefore = 4,
  ConvertAfter = 8,
  UnwrapAfter = 16,
  UnwrapBefore = 32
}

function get0<T>(map: Map<T, number>, val: T) { return map.get(val) ?? 0 }

function addPlanPos(map: Map<number, PlanPos>, at: number, plan: PlanPos) {
  map.set(at, (map.get(at) || 0) | plan)
}

function autoJoin(a: Tag<any>, b: Tag<any>) {
  let {autoJoin} = a.type.spec
  return typeof autoJoin == "function" ? autoJoin(a, b) : typeof autoJoin == "boolean" ? autoJoin : a.eq(b)
}

function addList(state: EditorState, blocks: NodePos[], listTag: Tag<any>) {
  let plan: ({wrap: NodePos, item: Tag<any>} | {change: NodePos, item: NodePos})[] = []
  let planPos: Map<number, PlanPos> = new Map
  let lastItem = -1
  for (let block of blocks) {
    let item = isListItem(block), wrap
    if (!item && block.parent && block.parent.node.type.canContain(listTag.type) &&
        (wrap = state.doc.schema.findWrapping(listTag.type, block.node.type)) && wrap.length == 1) {
      addPlanPos(planPos, block.before, PlanPos.WrapAfter)
      addPlanPos(planPos, block.after, PlanPos.WrapBefore)
      plan.push({wrap: block, item: wrap[0]})
      lastItem = block.before
    } else if (item?.parent && item.parent.node.tag.type != listTag.type &&
               listTag.type.canContain(item.node.type) &&
               item.parent.parent && item.parent.parent.node.type.canContain(listTag.type) &&
               item.before != lastItem) {
      addPlanPos(planPos, item.before, PlanPos.ConvertAfter)
      addPlanPos(planPos, item.after, PlanPos.ConvertBefore)
      if (item.index == 0) addPlanPos(planPos, item.parent.before, PlanPos.ConvertAfter)
      if (item.index == item.parent.node.children.length - 1) addPlanPos(planPos, item.parent.after, PlanPos.ConvertBefore)
      plan.push({change: block, item})
      lastItem = item.before
    }
  }
  if (!plan.length) return null
  let changes: ChangeSpec[] = []
  for (let step of plan) {
    if ("wrap" in step) {
      let {wrap, item} = step, prev, next
      if (get0(planPos, wrap.before) & (PlanPos.WrapBefore | PlanPos.ConvertBefore)) {
        changes.push({from: wrap.before, insert: new Slice([item])})
      } else if ((prev = wrap.previousSibling) && prev.tag.eq(listTag)) {
        changes.push({from: wrap.before - 1, to: wrap.before, insert: new Slice([item])})
      } else {
        changes.push({from: wrap.before, insert: new Slice([listTag, item])})
      }
      if (get0(planPos, wrap.after) & (PlanPos.WrapAfter | PlanPos.ConvertAfter)) {
        changes.push({from: wrap.after, insert: new Slice([CloseToken])})
      } else if ((next = wrap.nextSibling) && next.tag.type == listTag.type &&
                 autoJoin(next.tag, listTag)) {
        changes.push({from: wrap.after, to: wrap.after + 1, insert: new Slice([CloseToken])})
      } else {
        changes.push({from: wrap.after, insert: new Slice([CloseToken, CloseToken])})
      }
    } else { // Change other list
      let {item} = step, prev, next
      if (item.index == 0) {
        if (get0(planPos, item.before - 1) & (PlanPos.WrapBefore | PlanPos.ConvertBefore)) {
          changes.push({from: item.before - 1, to: item.before})
        } else if ((prev = item.parent!.previousSibling) && prev.tag.type == listTag.type) {
          changes.push({from: item.before - 2, to: item.before})
        } else {
          changes.push({from: item.before - 1, to: item.before, insert: new Slice([listTag])})
        }
      } else if (!(get0(planPos, item.before) & PlanPos.ConvertBefore)) {
        changes.push({from: item.before, insert: new Slice([CloseToken, listTag])})
      }
      if (item.index == item.parent!.node.children.length - 1) {
        if (get0(planPos, item.after + 1) & (PlanPos.WrapAfter | PlanPos.ConvertAfter)) {
          changes.push({from: item.after, to: item.after + 1})
        } else if ((next = item.parent!.nextSibling) && autoJoin(next.tag, listTag)) {
          changes.push({from: item.after, to: item.after + 2})
        }
      }
    }
  }
  return state.update({changes, userEvent: "wrap.list"})
}

function removeList(state: EditorState, blocks: NodePos[], listTag: Tag<any>) {
  let plan: NodePos[] = [], planPos: Map<number, PlanPos> = new Map, lastItem = -1
  for (let block of blocks) {
    let item = isListItem(block)
    if (item && item.parent!.node.type == listTag.type && item.before != lastItem) {
      lastItem = item.before
      plan.push(item)
      addPlanPos(planPos, item.before, PlanPos.UnwrapAfter)
      addPlanPos(planPos, item.after, PlanPos.UnwrapBefore)
    }
  }
  if (!plan.length) return null
  let changes: ChangeSpec[] = []
  for (let item of plan) {
    if (item.index == 0) {
      changes.push({from: item.before - 1, to: item.start})
    } else if (get0(planPos, item.before) & PlanPos.UnwrapBefore) {
      changes.push({from: item.before, to: item.start})
    } else {
      changes.push({from: item.before, to: item.start, insert: new Slice([CloseToken])})
    }
    if (item.index == item.parent!.node.children.length - 1) {
      changes.push({from: item.end, to: item.after + 1})
    } else if (get0(planPos, item.after) & PlanPos.UnwrapAfter) {
      changes.push({from: item.end, to: item.after})
    } else {
      changes.push({from: item.end, to: item.after, insert: new Slice([listTag])})
    }
  }
  return state.update({changes, userEvent: "unwrap.list"})
}

function setSelection(state: EditorState, dispatch: (tr: Transaction) => void, selection: EditorSelection) {
  dispatch(state.update({
    selection,
    scrollIntoView: true,
    userEvent: "select"
  }))
  return true
}

function ltrAtCursor(state: EditorState) {
  let block = state.sel.head.textblockParent
  return state.textDirection(block ? block.node.tag : undefined) == Direction.LTR
}

function cursorByChar(state: EditorState, dispatch: (tr: Transaction) => void, forward: boolean) {
  let next = state.selection.nextNormalCursor(state, forward)
  return next ? setSelection(state, dispatch, next) : false
}

function selectByChar(state: EditorState, dispatch: (tr: Transaction) => void, forward: boolean) {
  let next = state.selection.nextNormalCursor(state, forward)
  return next ? setSelection(state, dispatch, state.selection.extend(next.from, next.to)) : false
}

/// Move the selection one character to the left (which is backward in
/// left-to-right text, forward in right-to-left text).
export const cursorCharLeft: StateCommand = ({state, dispatch}) => cursorByChar(state, dispatch, !ltrAtCursor(state))
/// Move the selection one character to the right.
export const cursorCharRight: StateCommand = ({state, dispatch}) => cursorByChar(state, dispatch, ltrAtCursor(state))

/// Move the selection head one character to the left, while leaving
/// the anchor in place.
export const selectCharLeft: StateCommand = ({state, dispatch}) => selectByChar(state, dispatch, !ltrAtCursor(state))
/// Move the selection head one character to the right.
export const selectCharRight: StateCommand = ({state, dispatch}) => selectByChar(state, dispatch, ltrAtCursor(state))

/// Move the selection one character forward.
export const cursorCharForward: StateCommand = ({state, dispatch}) => cursorByChar(state, dispatch, true)
/// Move the selection one character backward.
export const cursorCharBackward: StateCommand = ({state, dispatch}) => cursorByChar(state, dispatch, false)

/// Move the selection head one character forward.
export const selectCharForward: StateCommand = ({state, dispatch}) => selectByChar(state, dispatch, true)
/// Move the selection head one character backward.
export const selectCharBackward: StateCommand = ({state, dispatch}) => selectByChar(state, dispatch, false)

function cursorByWord(state: EditorState, dispatch: (tr: Transaction) => void, forward: boolean) {
  let next = state.selection.skipWord(state, forward)
  return next ? setSelection(state, dispatch, next) : false
}

function selectByWord(state: EditorState, dispatch: (tr: Transaction) => void, forward: boolean) {
  let next = state.selection.skipWord(state, forward)
  return next ? setSelection(state, dispatch, next) : false
}

/// Move the selection one word to the left (which is backward in
/// left-to-right text, forward in right-to-left text).
export const cursorWordLeft: StateCommand = ({state, dispatch}) => cursorByWord(state, dispatch, !ltrAtCursor(state))
/// Move the selection one word to the right.
export const cursorWordRight: StateCommand = ({state, dispatch}) => cursorByWord(state, dispatch, ltrAtCursor(state))

/// Move the selection head one word to the left, while leaving
/// the anchor in place.
export const selectWordLeft: StateCommand = ({state, dispatch}) => selectByWord(state, dispatch, !ltrAtCursor(state))
/// Move the selection head one word to the right.
export const selectWordRight: StateCommand = ({state, dispatch}) => selectByWord(state, dispatch, ltrAtCursor(state))

/// Move the selection one word forward.
export const cursorWordForward: StateCommand = ({state, dispatch}) => cursorByWord(state, dispatch, true)
/// Move the selection one word backward.
export const cursorWordBackward: StateCommand = ({state, dispatch}) => cursorByWord(state, dispatch, false)

/// Move the selection head one word forward.
export const selectWordForward: StateCommand = ({state, dispatch}) => selectByWord(state, dispatch, true)
/// Move the selection head one word backward.
export const selectWordBackward: StateCommand = ({state, dispatch}) => selectByWord(state, dispatch, false)

function nextVertical(view: EditorView, sel: EditorSelection, forward: boolean, distance?: number) {
  let next = view.moveVertically(sel, forward, distance)
  if (next) return next
  let end = (forward ? EditorSelection.atEnd : EditorSelection.atStart)(view.state)
  return end.head == view.state.selection.head ? null : end
}

function cursorVertically(view: EditorView, forward: boolean, distance?: number) {
  let {selection} = view.state
  let next = selection.empty ? nextVertical(view, selection, forward, distance)
    : EditorSelection.cursor(forward ? selection.to : selection.from, forward ? -1 : 1, selection.goalColumn)
  return next ? setSelection(view.state, view.dispatch, next) : false
}

function selectVertically(view: EditorView, forward: boolean, distance?: number) {
  let next = nextVertical(view, view.state.selection, forward, distance)
  return next ? setSelection(view.state, view.dispatch, view.state.selection.extend(next.from, next.to)) : false
}

export const cursorLineDown: Command = view => cursorVertically(view, true)
export const cursorLineUp: Command = view => cursorVertically(view, false)

export const selectLineDown: Command = view => selectVertically(view, true)
export const selectLineUp: Command = view => selectVertically(view, false)

function pageHeight(view: EditorView) {
  let marginTop = 0, marginBottom = 0
  for (let source of view.state.facet(EditorView.scrollMargins)) {
    let margins = source(view)
    if (margins?.top) marginTop = Math.max(margins?.top, marginTop)
    if (margins?.bottom) marginBottom = Math.max(margins?.bottom, marginBottom)
  }
  return Math.max(10, Math.min(view.scrollDOM.clientHeight - marginTop - marginBottom,
                               (view.dom.ownerDocument.defaultView || window).innerHeight) - 10)
}

export const cursorPageDown: Command = view => cursorVertically(view, true, pageHeight(view))
export const cursorPageUp: Command = view => cursorVertically(view, false, pageHeight(view))

export const selectPageDown: Command = view => selectVertically(view, true, pageHeight(view))
export const selectPageUp: Command = view => selectVertically(view, false, pageHeight(view))

function cursorLineSide(view: EditorView, forward: boolean) {
  let pos = view.moveToLineBoundary(view.state.selection, forward)
  return pos ? setSelection(view.state, view.dispatch, pos) : false
}

export const cursorLineStart: Command = view => cursorLineSide(view, false)
export const cursorLineEnd: Command = view => cursorLineSide(view, true)

function selectLineSide(view: EditorView, forward: boolean) {
  let {selection} = view.state, pos = view.moveToLineBoundary(selection, forward)
  return pos ? setSelection(view.state, view.dispatch, EditorSelection.range(selection.anchor, pos.head)) : false
}

export const selectLineStart: Command = view => selectLineSide(view, false)
export const selectLineEnd: Command = view => selectLineSide(view, true)

export const cursorDocStart: StateCommand = ({state, dispatch}) => {
  let start = EditorSelection.atStart(state)
  if (state.selection.empty && start.head == state.selection.head) return false
  return setSelection(state, dispatch, start)
}
export const cursorDocEnd: StateCommand = ({state, dispatch}) => {
  let end = EditorSelection.atEnd(state)
  if (state.selection.empty && end.head == state.selection.head) return false
  return setSelection(state, dispatch, end)
}

export const selectDocStart: StateCommand = ({state, dispatch}) => {
  return setSelection(state, dispatch, EditorSelection.range(state.selection.anchor, 0))
}
export const selectDocEnd: StateCommand = ({state, dispatch}) => {
  return setSelection(state, dispatch, EditorSelection.range(state.selection.anchor, state.doc.length))
}

export const selectAll: StateCommand = ({state, dispatch}) => {
  dispatch(state.update({
    selection: EditorSelection.range(0, state.doc.length),
    userEvent: "select.all"
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
    joinListItems(view) ||
    joinBackward(view) ||
    deleteBackward(view)
}

export const defaultDelete: Command = (view: EditorView) => {
  return deleteSelection(view) ||
    joinForward(view) ||
    deleteForward(view)
}

export const defaultKeymap: readonly KeyBinding[] = [
  {key: "Enter", run: defaultEnter, preventDefault: true},
  {key: "Shift-Enter", run: view => insertLineBreakInCode(view) || insertLineBreak(view), preventDefault: true},
  {key: "Backspace", run: defaultBackspace, preventDefault: true},
  {key: "Delete", run: defaultDelete, preventDefault: true},
  {key: "ArrowLeft", run: cursorCharLeft, shift: selectCharLeft, preventDefault: true},
  {key: "ArrowRight", run: cursorCharRight, shift: selectCharRight, preventDefault: true},
  {key: "ArrowDown", run: cursorLineDown, shift: selectLineDown, preventDefault: true},
  {key: "ArrowUp", run: cursorLineUp, shift: selectLineUp, preventDefault: true},
  {key: "PageDown", run: cursorPageDown, shift: selectPageDown, preventDefault: true},
  {key: "PageUp", run: cursorPageUp, shift: selectPageUp, preventDefault: true},
  {key: "Home", run: cursorLineStart, shift: selectLineStart, preventDefault: true},
  {key: "End", run: cursorLineEnd, shift: selectLineEnd, preventDefault: true},
  {key: "Mod-Home", run: cursorDocStart, shift: selectDocStart, preventDefault: true},
  {key: "Mod-End", run: cursorDocEnd, shift: selectDocEnd, preventDefault: true},
  {key: "Mod-ArrowLeft", run: cursorWordLeft, shift: selectWordLeft, preventDefault: true},
  {key: "Mod-ArrowRight", run: cursorWordRight, shift: selectWordRight, preventDefault: true},
  {key: "Mod-a", run: selectAll},
]
