import {Node, Tag, NodePos, Walker, ChangeSet} from "wordgard/doc"
import {Facet, Extension, transactionFilter} from "./facet"
import {Transaction} from "./transaction"
import {EditorState} from "./state"

const enum CorrectionEvent {
  ChildList = 0,
  Content = 1,
  Props = 2,
}

function scanTransaction(tr: Transaction) {
  let [childList, content, props] = tr.startState.facet(corrections)
  let plan: {node: NodePos, correction: Correction}[] = []
  let queried: Set<number> = new Set, newNode = childList.concat(content)
  let updateWalker: Walker | undefined
  if (props.length) updateWalker = {
    enter(node: Node, pos: number, parent: NodePos, index: number) {
      for (let correction of props) if (correction.tag(node.type))
        plan.push({node: new NodePos(parent, node, pos, index), correction})
    },
    skip(node: Node, pos: number, parent: NodePos, index: number) {
      // Back up to the start of the node
      if (node.isText && !parent.node.children.includes(node)) {
        for (let off = parent.start, i = 0;; i++) {
          let next = parent.node.children[i], end = off + next.length
          if (end > pos) {
            node = next
            pos = off
            break
          }
        }
        if (queried.has(pos)) return
        queried.add(pos)
      }
      this.enter(node, pos, parent, index)
    },
    leave() {}
  }
  let changeWalker: Walker = {
    enter(node, pos, parent, index) {
      queried.add(pos)
      this.skip(node, pos, parent, index)
    },
    skip(node, pos, parent, index) {
      if (!node.isText) for (let correction of newNode) if (correction.tag(node.type))
        plan.push({node: new NodePos(parent, node, pos, index), correction})
    },
    leave() {}
  }

  let posA = tr.startState.doc.resolve(0), posB = tr.newDoc.resolve(0)
  for (let i = 0, {sections} = tr.changes; i < sections.length;) {
    let len = sections[i++], ins = sections[i++]
    if (ins == -1 || ins == -2 && !updateWalker) {
      if (i == sections.length) break
      posA = posA.advance(len)
      posB = posB.advance(len)
    } else if (ins == -2) {
      while (i < sections.length && sections[i + 1] == -2) { len += sections[i++]; i++ }
      posA = posA.advance(len)
      posB = posB.walk(len, updateWalker!)
    } else {
      while (i < sections.length && sections[i + 1] >= 0) { len += sections[i++]; ins += sections[i++] }
      for (let pA = posA.parent, pB = posB.parent;;) {
        if (queried.has(pB.start - 1)) break
        queried.add(pB.start - 1)
        if (childList.some(c => c.tag(pA.node.type))) {
          let chA = pA.node.children, chB = pB.node.children
          if (chA.length != chB.length || chA.some((ch, i) => !ch.tag.eq(chB[i].tag))) {
            for (let correction of childList) if (correction.tag(pA.node.type)) plan.push({node: pB, correction})
          }
        }
        for (let correction of content) if (correction.tag(pB.node.type)) plan.push({node: pB, correction})
        if (!pB.parent) break
        pA = pA.parent!; pB = pB.parent
      }
      posB = posB.walk(ins, changeWalker)
      posA = posA.advance(len)
    }
  }
  return plan
}

const corrections = Facet.define<Correction, readonly (readonly Correction[])[]>({
  combine(corrections) {
    let buckets: Correction[][] = [[], [], []]
    for (let c of corrections) buckets[c.event].push(c)
    return buckets
  }
})

const planCache = new WeakMap<Transaction, ReturnType<typeof scanTransaction>>()

/// Corrections are extensions that listen for some kinds of document
/// changes on specific types of nodes and, when they occur, run a
/// function to verify that some condition holds, and optionally
/// adjust the node.
///
/// The correcting function will be passed a [`NodePos`](#doc.NodePos)
/// object pointing at the matched node, as well as the editor state
/// _before_ the transaction. Changes it produces will be interpreted
/// as relative to the document _after_ the transaction (so `node.doc`).
///
/// Corrections are wrappers around [transaction
/// filters](#state.EditorState^transactionFilter). This means that
/// their effect will be included in transactions as they are applied.
/// It also means that a correction, though generally effective, does
/// not _guarantee_ that an invariant will always be preserved,
/// because a transaction with
/// [`filter`](#state.TransactionSpec.filter)`: false` may violate it
/// and not be checked. Such a transaction may for example be created
/// by concurrent collaborative changes or undone changes that
/// interact with non-undoable changes.
export class Correction {
  /// To take effect, corrections must be included in an editor
  /// configuration as extensions.
  extension: Extension

  private constructor(
    /// @internal
    readonly event: CorrectionEvent,
    /// @internal
    readonly tag: (t: Tag.Type<any>) => boolean,
    /// @internal
    readonly correct: (node: NodePos, state: EditorState) => ChangeSet.Spec | null
  ) {
    this.extension = [
      corrections.of(this),
      transactionFilter.of(tr => this.filter(tr))
    ]
  }

  /// @internal
  filter(tr: Transaction) {
    if (!tr.docChanged) return tr
    let plan = planCache.get(tr)
    if (!plan) planCache.set(tr, plan = scanTransaction(tr))
    let changes: ChangeSet.Spec[] = []
    for (let elt of plan) if (elt.correction == this) {
      let change = this.correct(elt.node, tr.startState)
      if (change) changes.push(change)
    }
    if (!changes.length) return tr
    return [tr, {changes, sequential: true}]
  }

  /// This method can be used to run a correction agains all matching
  /// nodes in an existing document. If the correction makes any
  /// changes, the method returns a transaction with those changes.
  scan(state: EditorState) {
    let changes: ChangeSet.Spec[] = []
    state.doc.iterate((node, pos) => {
      if (this.tag(node.type)) {
        let at = state.doc.resolve(pos)
        let change = this.correct(new NodePos(at.parent.parent, at.nodeAfter!, pos, at.index), state)
        if (change) changes.push(change)
      }
    })
    if (changes.length) return state.update({changes})
    return null
  }

  /// Create a correction that runs whenever the child list of a node
  /// that matches the given selector changes, or such a node is
  /// inserted into the document.
  static onChildList(tag: Tag.Selector, correct: (node: NodePos, state: EditorState) => ChangeSet.Spec | null) {
    return new Correction(CorrectionEvent.ChildList, Tag.select(tag), correct)
  }

  /// Create a correction that runs whenever any content inside a node
  /// that matches the given selector changes, or such a node is
  /// inserted into the document.
  static onContent(tag: Tag.Selector, correct: (node: NodePos, state: EditorState) => ChangeSet.Spec | null) {
    return new Correction(CorrectionEvent.Content, Tag.select(tag), correct)
  }

  /// Define a correction that runs whenever the set of props on a tag
  /// matching a selector changes.
  static onProps(tag: Tag.Selector, correct: (node: NodePos, state: EditorState) => ChangeSet.Spec | null) {
    return new Correction(CorrectionEvent.Props, Tag.select(tag), correct)
  }
}
