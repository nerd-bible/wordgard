import {Part, Plot, PlotPos, PartPos, Walker, ChangeSet} from "wordgard/doc"
import {Facet, Extension, transactionFilter} from "./facet"
import {Transaction} from "./transaction"
import {EditorState} from "./state"

const enum CorrectionEvent {
  ChildList = 0,
  Content = 1,
  Props = 2,
}

type PlanElt<PosType extends PartPos> = {node: PosType, correction: Correction<PosType>}

function scanTransaction(tr: Transaction) {
  let [childList, content, props] = tr.startState.facet(corrections)
  let plan: PlanElt<any>[] = []
  let queried: Set<number> = new Set, newNode = childList.concat(content)
  let updateWalker: Walker | undefined
  let checkProps = (node: Part, pos: number, parent: PlotPos, index: number) => {
    for (let correction of props) if (correction.tag(node.type))
      plan.push({node: new PartPos(parent, node, pos, index), correction})
  }
  if (props.length) updateWalker = {
    enterPlot: checkProps,
    skip(node: Part, pos: number, parent: PlotPos, index: number) {
      // Back up to the start of the node
      if (node.isText && !parent.part.content.includes(node)) {
        for (let off = parent.start, i = 0;; i++) {
          let next = parent.part.content[i], end = off + next.length
          if (end > pos) {
            node = next
            pos = off
            break
          }
        }
        if (queried.has(pos)) return
        queried.add(pos)
      }
      checkProps(node, pos, parent, index)
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
        if (childList.some(c => c.tag(pA.part.type))) {
          let chA = pA.part.content, chB = pB.part.content
          if (chA.length != chB.length || chA.some((ch, i) => !ch.label.eq(chB[i].label))) {
            for (let correction of childList) if (correction.tag(pA.part.type)) plan.push({node: pB, correction})
          }
        }
        for (let correction of content) if (correction.tag(pB.part.type)) plan.push({node: pB, correction})
        if (!pB.parent) break
        pA = pA.parent!; pB = pB.parent
      }
      posB = posB.walk(ins, changeWalker)
      posA = posA.advance(len)
    }
  }
  return plan
}

const corrections = Facet.define<Correction<PartPos>, readonly (readonly Correction<PartPos>[])[]>({
  combine(corrections) {
    let buckets: Correction<PartPos>[][] = [[], [], []]
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
export class Correction<PosType extends PartPos> {
  /// To take effect, corrections must be included in an editor
  /// configuration as extensions.
  extension: Extension

  private constructor(
    /// @internal
    readonly event: CorrectionEvent,
    /// @internal
    readonly tag: (t: Part.Type<any>) => boolean,
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
      if (this.tag(node.type) && (this.event == CorrectionEvent.Props || !node.isLeaf)) {
        let at = state.doc.resolve(pos)
        let nodePos = this.event == CorrectionEvent.Props
          ? new PartPos(at.parent, at.nodeAfter!, pos, at.index)
          : new PlotPos(at.parent, at.nodeAfter as Plot, pos, at.index)
        let change = this.correct(nodePos as PosType, state)
        if (change) changes.push(change)
      }
    })
    if (changes.length) return state.update({changes})
    return null
  }

  /// Create a correction that runs whenever the child list of a node
  /// that matches the given selector changes, or such a node is
  /// inserted into the document.
  static onChildList(tag: Part.Selector, correct: (node: PlotPos, state: EditorState) => ChangeSet.Spec | null) {
    return new Correction<PlotPos>(CorrectionEvent.ChildList, Part.selector(tag), correct as any)
  }

  /// Create a correction that runs whenever any content inside a node
  /// that matches the given selector changes, or such a node is
  /// inserted into the document.
  static onContent(tag: Part.Selector, correct: (node: PlotPos, state: EditorState) => ChangeSet.Spec | null) {
    return new Correction<PlotPos>(CorrectionEvent.Content, Part.selector(tag), correct as any)
  }

  /// Define a correction that runs whenever the set of props on a tag
  /// matching a selector changes.
  static onProps(tag: Part.Selector, correct: (node: PartPos, state: EditorState) => ChangeSet.Spec | null) {
    return new Correction<PlotPos>(CorrectionEvent.Props, Part.selector(tag), correct)
  }
}
