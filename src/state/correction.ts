import {Node, PlotPos, NodePos, Walker, ChangeSet} from "wordgard/doc"
import {Facet, Extension, transactionFilter} from "./facet"
import {Transaction} from "./transaction"
import {EditorState} from "./state"

const enum CorrectionEvent {
  ChildList = 0,
  Content = 1,
  Marks = 2,
}

type PlanElt<PosType extends NodePos> = {node: PosType, correction: Correction<PosType>}

function scanTransaction(tr: Transaction) {
  let [childList, content, marks] = tr.startState.facet(corrections)
  let plan: PlanElt<any>[] = []
  let queried: Set<number> = new Set, newNode = childList.concat(content)
  let updateWalker: Walker | undefined
  let checkMarks = (node: Node, pos: number, parent: PlotPos, index: number) => {
    for (let correction of marks) if (correction.tag(node.type))
      plan.push({node: new NodePos(parent, node, pos, index), correction})
  }
  if (marks.length) updateWalker = {
    enterPlot: checkMarks,
    skip(node: Node, pos: number, parent: PlotPos, index: number) {
      // Back up to the start of the node
      if (node.isText && !parent.node.content.includes(node)) {
        for (let off = parent.start, i = 0;; i++) {
          let next = parent.node.content[i], end = off + next.length
          if (end > pos) {
            node = next
            pos = off
            break
          }
        }
        if (queried.has(pos)) return
        queried.add(pos)
      }
      checkMarks(node, pos, parent, index)
    },
    leavePlot() {}
  }
  let changeWalker: Walker = {
    enterPlot(node, pos, parent, index) {
      queried.add(pos)
      this.skip(node, pos, parent, index)
    },
    skip(node, pos, parent, index) {
      if (!node.isLeaf) for (let correction of newNode) if (correction.tag(node.type))
        plan.push({node: new PlotPos(parent, node, pos, index), correction})
    },
    leavePlot() {}
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
          let chA = pA.node.content, chB = pB.node.content
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

const corrections = Facet.define<Correction<NodePos>, readonly (readonly Correction<NodePos>[])[]>({
  combine(corrections) {
    let buckets: Correction<NodePos>[][] = [[], [], []]
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
export class Correction<PosType extends NodePos> {
  /// To take effect, corrections must be included in an editor
  /// configuration as extensions.
  extension: Extension

  private constructor(
    /// @internal
    readonly event: CorrectionEvent,
    /// @internal
    readonly tag: (t: Node.Type<any>) => boolean,
    /// @internal
    readonly correct: (node: PosType, state: EditorState) => ChangeSet.Spec | null
  ) {
    this.extension = [
      corrections.of(this as any),
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
      if (this.tag(node.type) && (this.event == CorrectionEvent.Marks || !node.isLeaf)) {
        let change = this.correct(state.doc.resolveNode(pos) as PosType, state)
        if (change) changes.push(change)
      }
    })
    if (changes.length) return state.update({changes})
    return null
  }

  /// Create a correction that runs whenever the child list of a node
  /// that matches the given selector changes, or such a node is
  /// inserted into the document.
  static onChildList(tag: Node.Selector, correct: (node: PlotPos, state: EditorState) => ChangeSet.Spec | null) {
    return new Correction<PlotPos>(CorrectionEvent.ChildList, Node.selector(tag), correct as any)
  }

  /// Create a correction that runs whenever any content inside a node
  /// that matches the given selector changes, or such a node is
  /// inserted into the document.
  static onContent(tag: Node.Selector, correct: (node: PlotPos, state: EditorState) => ChangeSet.Spec | null) {
    return new Correction<PlotPos>(CorrectionEvent.Content, Node.selector(tag), correct as any)
  }

  /// Define a correction that runs whenever the set of marks on a tag
  /// matching a selector changes.
  static onMarks(tag: Node.Selector, correct: (node: NodePos, state: EditorState) => ChangeSet.Spec | null) {
    return new Correction<PlotPos>(CorrectionEvent.Marks, Node.selector(tag), correct)
  }
}
