import {StateField, EditorState} from "wordgard/state"
import {RangeDecorationSource, RangeSet} from "wordgard/view"

const selectionSet = RangeSet.for<null>({})

function selectionFor(state: EditorState) {
  let {node, from, to} = state.sel
  return node && node.isLeaf && node.type.isSelectable ? selectionSet.create([[from.pos, to.pos, null]]) : selectionSet.empty
}

export const NodeSelection = StateField.define<RangeSet<null>>({
  create: state => selectionFor(state),
  update: (_value, tr) => selectionFor(tr.state),
  provide: f => new RangeDecorationSource<null>({
    deco: {
      attribute: "class",
      value: "wg-selected-node",
    },
    set: state => state.field(f),
  })
})
