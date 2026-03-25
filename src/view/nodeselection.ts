import {EditorState} from "wordgard/state"
import {Decoration, PointSet} from "wordgard/view"

const selectionDeco = Decoration.attribute("class", "wg-selected-node")

function selectionFor(state: EditorState) {
  let {node, from} = state.sel
  return node && node.isLeaf && node.type.isSelectable ? PointSet.create([[from.pos, selectionDeco]]) : PointSet.empty
}

export const NodeSelection = EditorState.Field.define<PointSet<Decoration>>({
  create: state => selectionFor(state),
  update: (_value, tr) => selectionFor(tr.state),
  provide: f => Decoration.source.of(s => s.field(f))
})
