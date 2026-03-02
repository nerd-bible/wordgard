import {Leaf, Mark, elt, MapMode} from "wordgard/doc"
import {EditorView, tagDecoration, RangeSet, RangeDecorationSource} from "wordgard/view"
import {EditorState, StateField, StateEffect, Prec} from "wordgard/state"

export const Image = Leaf.Type.defineInline<string>("Image", {
  validateParam: "string",
  shape: {structure: src => elt({_: "span", class: "wg-image"}, elt({_: "img", src}))},
  selectable: true,
  parseRules: [{
    selector: "img[src]",
    readElement: elt => (elt as HTMLImageElement).src
  }]
})

export const ImageAlt = Mark.Type.define<string>("ImageAlt", {
  tags: "Image",
  validate: "string",
  shape: {attribute: "alt", readAttribute: x => x}
})

export const ImageSize = Mark.Type.define<number>("ImageSize", {
  tags: "Image",
  validate: "number",
  shape: {attribute: "style", value: size => `width: ${size}px`}
})

// FIXME make it possible to attach extensions to schema elements
export const imageTheme = EditorView.theme({
  ".wg-image": {
    display: "inline-block",
    lineHeight: "0.1",
    position: "relative",
    "& img": {
      width: "100%"
    }
  },

  ".wg-resizeable-image": {
  },
  ".wg-resizeable-image:hover:after": {
    content: "''",
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    border: "10px solid #00000055",
    borderLeft: "10px solid transparent",
    borderTop: "10px solid transparent",
    cursor: "nwse-resize"
  }
})

const resizeDecoSet = RangeSet.for<number>()

const setResizing = StateEffect.define<{pos: number, width: number} | null>({
  map: (value, mapping) => {
    if (!value) return null
    let newPos = mapping.mapPos(value.pos, MapMode.TrackAfter)
    return value == null ? undefined : {pos: newPos, width: value.width}
  }
})

const dragState = StateField.define<RangeSet<number>>({
  create: () => resizeDecoSet.empty,
  update: (value, tr) => {
    for (let e of tr.effects) {
      if (e.is(setResizing))
        return e.value ? resizeDecoSet.create([[e.value.pos, e.value.pos + 1, e.value.width]]) : resizeDecoSet.empty
    }
    return value.map(tr.changes)
  }
})

function getDragState(state: EditorState) {
  let f = state.field(dragState)
  if (!f || !f.length) return null
  return {pos: f.from[0], width: f.values[0]} // FIXME
}

export const dragHandle = [
  tagDecoration({
    tag: Image,
    deco: {
      attribute: "class",
      value: "wg-resizeable-image"
    }
  }),
  Prec.high(EditorView.domEventHandlers({
    mousedown: (event, view) => {
      for (let n = event.target as HTMLElement; n != view.contentDOM; n = n.parentNode as HTMLElement) {
        if (n.classList.contains("wg-resizeable-image")) {
          let rect = n.getBoundingClientRect()
          if (event.clientX >= rect.right - 10 && event.clientY >= rect.bottom - 10) {
            let pos = view.posAtDOM(n)
            view.dispatch({effects: setResizing.of({pos, width: rect.width})})
            event.preventDefault()
            return
          }
        }
      }
    },
    mousemove: (event, view) => {
      let dragging = getDragState(view.state)
      if (!dragging) return
      let dom = view.nodeDOM(dragging.pos)!
      let width = event.clientX - dom.getBoundingClientRect().left
      if (width > 0) view.dispatch({effects: setResizing.of({pos: dragging.pos, width})})
    },
    mouseup: (event, view) => {
      let dragging = getDragState(view.state)
      if (!dragging) return
      view.dispatch({
        effects: setResizing.of(null),
        changes: {from: dragging.pos, add: ImageSize.of(dragging.width)}
      })
    }
  })),
  dragState,
  new RangeDecorationSource<number>({
    set: s => s.field(dragState),
    deco: {
      attribute: "style",
      value: width => `width: ${width}px`
    }
  })
]
