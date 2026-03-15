import {Leaf, Mark, elt, MapMode} from "wordgard/doc"
import {EditorView, PointSet, Decoration, KeyBinding} from "wordgard/view"
import {StateField, StateEffect, Prec} from "wordgard/state"

export const Image = Leaf.Type.defineInline<string>("Image", {
  validateParam: "string",
  shape: {structure: src => elt({_: "img", src})},
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
  ".wg-resize-hover": {
    display: "inline-block",
    lineHeight: "0.1",
    position: "relative"
  },
  ".wg-resize-handle": {
    position: "absolute",
    right: "1px", bottom: "1px",
    width: "min(60%, 20px)",
    height: "min(60%, 20px)",
  },
  ".wg-resize-handle-active": {
    cursor: "nwse-resize"
  }
})

const setResizing = StateEffect.define<{target: number, resizing: number}>({
  map: (value, mapping) => {
    let newPos = mapping.mapPos(value.target, MapMode.TrackAfter)
    return value == null ? undefined : {target: newPos, resizing: value.resizing}
  }
})

const handleElt = elt({_: "svg:svg", class: "wg-resize-handle", viewBox: "0 0 20 20"},
                      elt({_: "svg:path", d: "M20 0L0 20M20 5L5 20M20 10L10 20", stroke: "#000000aa", "stroke-width": "1.5"}),
                      elt({_: "svg:polygon", points: "0,20 20,20 20,0", fill: "transparent", class: "wg-resize-handle-active"}))

const resizeWrapper = Decoration.wrapper(
  shape => elt({_: "span", class: "wg-resize-hover"}, handleElt, shape))

const resizeState = StateField.define<{target: number, resizing: number, deco: PointSet<Decoration>}>({
  create: () => ({target: -1, resizing: -1, deco: PointSet.empty}),
  update: (value, tr) => {
    for (let e of tr.effects) {
      if (e.is(setResizing)) {
        let {target, resizing} = e.value
        if (target < 0)
          return {target: -1, resizing: -1, deco: PointSet.empty}
        let deco: [number, Decoration][] = [[target, resizeWrapper]]
        if (resizing > -1)
          deco.push([target, Decoration.attribute("style", `width: ${resizing}px`, {selector: "img"})])
        return {target, resizing, deco: PointSet.create(deco)}
      }
    }
    return value.target < 0 || !tr.docChanged ? value
      : {target: value.target, resizing: value.resizing, deco: value.deco.map(tr.changes)}
  }
})

const MIN_SIZE = 10

const resizeHandlers = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    let resizing = view.state.field(resizeState)
    if (resizing.target < 0) return
    for (let dom = event.target as Element;;) {
      if (dom.classList.contains("wg-resize-handle-active")) break
      let next = dom.parentNode as Element | null
      if (!next || next == view.contentDOM) return
      dom = next
    }
    let node = view.state.doc.nodeAt(resizing.target)!
    let width = node.tag.mark(ImageSize) ?? view.nodeDOM(resizing.target)!.getBoundingClientRect().width
    view.dispatch({effects: setResizing.of({target: resizing.target, resizing: width})})
    event.preventDefault()
  },
  mousemove: (event, view) => {
    let resizing = view.state.field(resizeState)
    if (resizing.resizing > -1) {
      let dom = view.nodeDOM(resizing.target)!
      let width = event.clientX - dom.getBoundingClientRect().left
      if (width >= MIN_SIZE && Math.abs(width - resizing.resizing) >= 1)
        view.dispatch({effects: setResizing.of({target: resizing.target, resizing: width})})
    } else {
      let node = view.nodeFromDOM(event.target as HTMLElement)
      let target = node && ImageSize.canTarget(node.node.type) ? node.pos : -1
      if (target != resizing.target)
        view.dispatch({effects: setResizing.of({target, resizing: -1})})
    }
  },
  mouseup: (event, view) => {
    let resizing = view.state.field(resizeState)
    if (resizing.resizing < 0) return
    view.dispatch({
      effects: setResizing.of({target: resizing.target, resizing: -1}),
      changes: {from: resizing.target, add: ImageSize.of(Math.round(resizing.resizing))}
    })
  }
})

export const dragHandle = [
  Prec.high(resizeHandlers),
  resizeState,
  Decoration.source.of(s => s.field(resizeState).deco),
]

export const resizeImage = (by: number, relative = false) => (view: EditorView) => {
  let {node} = view.state.sel
  if (node && ImageSize.canTarget(node.type)) {
    let curWidth = node.mark(ImageSize) ?? view.nodeDOM(view.state.selection.from)!.getBoundingClientRect().width
    let newWidth = Math.max(MIN_SIZE, relative ? curWidth * by : curWidth + by)
    if (newWidth != curWidth) {
      view.dispatch({
        changes: {from: view.state.selection.from, add: ImageSize.of(newWidth)},
        userEvent: "image.resize"
      })
      return true
    }
  }
  return false
}

export const resizeImageKeymap = [
  KeyBinding.define({key: "Ctrl-Alt-l", mac: "Ctrl-Cmd-l", run: resizeImage(1.1, true)}),
  KeyBinding.define({key: "Ctrl-Alt-k", mac: "Ctrl-Cmd-k", run: resizeImage(0.9, true)}),
]
