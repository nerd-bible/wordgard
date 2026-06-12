import {Node, Pos, ChangeSet} from "wordgard/doc"
import {Transaction} from "./transaction"
import {GardState} from "./state"

const enum CorrectionEvent {
  ChildList = 0,
  Content = 1,
  Marks = 2,
}

type PlanElt<PosType extends Pos.Node> = {node: PosType, correction: Correction<PosType>}

function scanTransaction(tr: Transaction) {
  let [childList, content, marks] = tr.startState.facet(corrections)
  let plan: PlanElt<any>[] = []
  let queried: Set<number> = new Set, newNode = childList.concat(content)
  let updateWalker: Pos.Walker | undefined, {schema} = tr.startState.doc
  let checkMarks = (node: Node, pos: number, parent: Pos.Plot, index: number) => {
    for (let correction of marks) if (schema.matchNode(node.type, correction.query))
      plan.push({node: Pos.Node.create(parent, node, pos, index), correction})
  }
  if (marks.length) updateWalker = {
    enterPlot: checkMarks,
    skip(node: Node, pos: number, parent: Pos.Plot, index: number) {
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
  let changeWalker: Pos.Walker = {
    enterPlot(node, pos, parent, index) {
      queried.add(pos)
      this.skip(node, pos, parent, index)
    },
    skip(node, pos, parent, index) {
      if (node.isPlot) for (let correction of newNode) if (schema.matchNode(node.type, correction.query))
        plan.push({node: Pos.Plot.create(parent, node, pos, index), correction})
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
        if (childList.some(c => schema.matchNode(pA.node.type, c.query))) {
          let chA = pA.node.content, chB = pB.node.content
          if (chA.length != chB.length || chA.some((ch, i) => !ch.tag.eq(chB[i].tag))) {
            for (let correction of childList)
              if (schema.matchNode(pA.node.type, correction.query)) plan.push({node: pB, correction})
          }
        }
        for (let correction of content)
          if (schema.matchNode(pB.node.type, correction.query)) plan.push({node: pB, correction})
        if (!pB.parent) break
        pA = pA.parent!; pB = pB.parent
      }
      posB = posB.walk(ins, changeWalker)
      posA = posA.advance(len)
    }
  }
  return plan
}

const corrections = GardState.Facet.define<Correction<Pos.Node>, readonly (readonly Correction<Pos.Node>[])[]>({
  combine(corrections) {
    let buckets: Correction<Pos.Node>[][] = [[], [], []]
    for (let c of corrections) buckets[c.event].push(c)
    return buckets
  }
})

const planCache = new WeakMap<Transaction, ReturnType<typeof scanTransaction>>()

/// The class representing a correction. Counts as an editor
/// extension.
export class Correction<PosType extends Pos.Node> {
  /// To take effect, corrections must be included in an editor
  /// configuration.
  extension: GardState.Extension

  private constructor(
    /// @internal
    readonly event: CorrectionEvent,
    /// @internal
    readonly query: Node.Query,
    /// @internal
    readonly correct: (node: PosType, state: GardState) => ChangeSet.Spec | null
  ) {
    this.extension = [
      corrections.of(this as any),
      Transaction.extender.of(tr => this.extend(tr))
    ]
  }

  /// @internal
  extend(tr: Transaction) {
    if (!tr.docChanged) return null
    let plan = planCache.get(tr)
    if (!plan) planCache.set(tr, plan = scanTransaction(tr))
    let changes: ChangeSet.Spec[] = []
    for (let elt of plan) if (elt.correction == this) {
      let change = this.correct(elt.node, tr.startState)
      if (change) changes.push(change)
    }
    return changes.length ? {changes, sequential: true} : null
  }

  /// This method can be used to run a correction agains all matching
  /// nodes in an existing document. If the correction makes any
  /// changes, the method returns a transaction with those changes.
  scan(state: GardState) {
    let changes: ChangeSet.Spec[] = []
    state.doc.iterate((node, pos) => {
      if (state.schema.matchNode(node.type, this.query) && (this.event == CorrectionEvent.Marks || node.isPlot)) {
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
  static onChildList(query: Node.Query, correct: (node: Pos.Plot, state: GardState) => ChangeSet.Spec | null) {
    return new Correction<Pos.Plot>(CorrectionEvent.ChildList, query, correct as any)
  }

  /// Create a correction that runs whenever any content inside a node
  /// that matches the given selector changes, or such a node is
  /// inserted into the document.
  static onContent(query: Node.Query, correct: (node: Pos.Plot, state: GardState) => ChangeSet.Spec | null) {
    return new Correction<Pos.Plot>(CorrectionEvent.Content, query, correct as any)
  }

  /// Define a correction that runs whenever the set of marks on a tag
  /// matching a selector changes.
  static onMarks(query: Node.Query, correct: (node: Pos.Node, state: GardState) => ChangeSet.Spec | null) {
    return new Correction<Pos.Plot>(CorrectionEvent.Marks, query, correct)
  }
}
