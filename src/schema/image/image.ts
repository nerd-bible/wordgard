import {Leaf, Mark, Reject} from "wordgard/doc"
import {StateField, EditorState} from "wordgard/state"
import {RangeDecorationSource, RangeSet} from "wordgard/view"

export const Image = Leaf.Type.defineInline<string>("Image", {
  validateParam: "string",
  shape: {element: "img", attributes: src => ({src}), readElement: elt => (elt as HTMLImageElement).src || Reject}
})

export const ImageAlt = Mark.Type.define<string>("ImageAlt", {
  tags: "Image",
  validate: "string",
  shape: {attribute: "alt", readAttribute: x => x}
})

export const ImageSize = Mark.Type.define<{width: number, height: number}>("ImageSize", {
  tags: "Image",
  validate: value => {
    if (!value || typeof value.width != "number" || value.width < 0 || typeof value.height != "number" || value.height < 0)
      throw new Error("Invalid image size: " + JSON.stringify(value))
  },
  shape: {attribute: "style", value: size => `width: ${size.width}px; height: ${size.height}px`}
})

const selectionSet = RangeSet.for<null>({})

function selectionFor(state: EditorState) {
  let {node, from, to} = state.sel
  if (!node || node.type != Image) return selectionSet.empty
  return selectionSet.create([[from.pos, to.pos, null]])
}

export const ImageSelection = StateField.define<RangeSet<null>>({
  create: state => selectionFor(state),
  update: (_value, tr) => selectionFor(tr.state),
  provide: f => new RangeDecorationSource<null>({
    deco: {
      element: "span",
      attributes: {class: "wg-selected-node"},
    },
    set: state => state.field(f),
  })
})
