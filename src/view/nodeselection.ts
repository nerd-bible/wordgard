import {StateField, EditorState} from "wordgard/state"
import {RangeDecoration, RangeSet} from "wordgard/view"

const selectionDeco = RangeDecoration.create({
  attribute: "class",
  value: "wg-selected-node"
})

function selectionFor(state: EditorState) {
  let {node, from, to} = state.sel
  return node && node.isLeaf && node.type.isSelectable ? RangeSet.create([[from.pos, to.pos, selectionDeco]]) : RangeSet.empty
}

export const NodeSelection = StateField.define<RangeSet<RangeDecoration>>({
  create: state => selectionFor(state),
  update: (_value, tr) => selectionFor(tr.state),
  provide: f => RangeDecoration.source.of(s => s.field(f))
})
