import {elt, MapMode, Node, Mark} from "wordgard/doc"
import {Wordgard, PointSet, Decoration, KeyBinding, Panel} from "wordgard/view"
import {GardState, Transaction, GardSelection} from "wordgard/state"
import {Command} from "wordgard/command"
import {ImageSize, ImageAlt, Image, Figure, CaptionedFigure, Alignment} from "wordgard/schema"
import {MenuButton, iconImage, Commands} from "wordgard/menu"
import cr from "crelt"

export {Image, Figure, CaptionedFigure, ImageSize, ImageAlt}

const imageTypes = [Image, Figure, CaptionedFigure]

export const imageTheme = Wordgard.theme({
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

const setResizing = Transaction.Effect.define<{target: number, resizing: number}>({
  map: (value, mapping) => {
    let newPos = mapping.mapPos(value.target, MapMode.TrackAfter)
    return value == null ? undefined : {target: newPos, resizing: value.resizing}
  }
})

const handleElt = elt({_: "svg:svg", class: "wg-resize-handle", viewBox: "0 0 20 20"},
                      elt({_: "svg:path", d: "M20 0L0 20M20 5L5 20M20 10L10 20", stroke: "#000000aa", "stroke-width": "1.5"}),
                      elt({_: "svg:polygon", points: "0,20 20,20 20,0", fill: "transparent", class: "wg-resize-handle-active"}))

const resizeWrapper = Decoration.wrapper(elt({_: "span", class: "wg-resize-hover"}, handleElt, 0), {target: "img"})

const resizeState = GardState.Field.define<{target: number, resizing: number, deco: PointSet<Decoration>}>({
  create: () => ({target: -1, resizing: -1, deco: PointSet.empty}),
  update: (value, tr) => {
    for (let e of tr.effects) {
      if (e.is(setResizing)) {
        let {target, resizing} = e.value
        if (target < 0)
          return {target: -1, resizing: -1, deco: PointSet.empty}
        let deco: [number, Decoration][] = [[target, resizeWrapper]]
        if (resizing > -1)
          deco.push([target, Decoration.attribute("style", `width: ${resizing}px`, {target: "img"})])
        return {target, resizing, deco: PointSet.create(deco)}
      }
    }
    return value.target < 0 || !tr.docChanged ? value
      : {target: value.target, resizing: value.resizing, deco: value.deco.map(tr.changes)}
  }
})

const MIN_SIZE = 10

function imageNode(view: Wordgard, pos: number) {
  let dom = view.nodeDOM(pos)!
  return dom.nodeName == "IMG" ? dom : dom.querySelector("img[src]")!
}

const resizeHandlers = Wordgard.domEventHandlers({
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
    let width = node.tag.mark(ImageSize) ?? imageNode(view, resizing.target).getBoundingClientRect().width
    view.dispatch({effects: setResizing.of({target: resizing.target, resizing: width})})
    event.preventDefault()
  },
  mousemove: (event, view) => {
    let resizing = view.state.field(resizeState)
    if (resizing.resizing > -1) {
      let dom = imageNode(view, resizing.target)
      let width = event.clientX - dom.getBoundingClientRect().left
      if (width >= MIN_SIZE && Math.abs(width - resizing.resizing) >= 1)
        view.dispatch({effects: setResizing.of({target: resizing.target, resizing: width})})
    } else {
      let elt = (event.target as HTMLElement).closest("img, .wg-resize-handle")
      let node = elt && view.nodeFromDOM(elt)
      let target = node && view.state.doc.schema.markAllowed(ImageSize, node.node.type) ? node.pos : -1
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
  GardState.prec.high(resizeHandlers),
  resizeState,
  Decoration.source.of(s => s.field(resizeState).deco),
]

export const resizeImage = (by: number, relative = false) => (view: Wordgard) => {
  let {node} = view.state.sel
  if (node && view.state.doc.schema.markAllowed(ImageSize, node.type)) {
    let curWidth = node.mark(ImageSize) ?? imageNode(view, view.state.selection.from).getBoundingClientRect().width
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

function activeImage(sel: GardSelection.Resolved) {
  if (sel.node && imageTypes.includes(sel.node.type)) return sel.node.tag
  if (sel.head.parent.start == sel.anchor.parent.start && sel.head.parent.node.type == CaptionedFigure)
    return sel.head.parent.node.tag
  return null
}

const svg = "http://www.w3.org/2000/svg"

function rect(x: number, y: number, w: number, h: number, cls: string) {
  let elt = document.createElementNS(svg, "rect")
  elt.setAttribute("x", String(x)); elt.setAttribute("y", String(y))
  elt.setAttribute("width", String(w)); elt.setAttribute("height", String(h))
  elt.setAttribute("class", cls)
  return elt
}

function alignButtons(state: GardState, active: Node.Tag | null) {
  let fig = state.doc.schema.has(Figure) ? Figure : state.doc.schema.has(CaptionedFigure) ? CaptionedFigure : null
  let img = state.doc.schema.has(Image)
  let align = fig && state.doc.schema.markAllowed(Alignment, fig)
  if (!align && !(fig && img)) return null
  let buttons: HTMLElement[] = []
  function button(type: "inline" | "start" | "center" | "end", label: string, active: boolean | null) {
    let icon = document.createElementNS(svg, "svg")
    icon.setAttribute("viewbox", "0 0 24 22")
    icon.setAttribute("width", "24"); icon.setAttribute("height", "22")
    icon.appendChild(rect(1, 1, 22, 3, "wg-img-icon-text"))
    // FIXME flip if RTL
    icon.appendChild(rect(type == "start" ? 2 : type == "end" ? 12 : 7, 6, 10, 10, "wg-img-icon-image"))
    if (type == "inline") {
      icon.appendChild(rect(1, 12, 4, 3, "wg-img-icon-text"))
      icon.appendChild(rect(19, 12, 4, 3, "wg-img-icon-text"))
    }
    icon.appendChild(rect(1, 18, 22, 3, "wg-img-icon-text"))
    return cr("label", {class: "wg-img-radio"},
              cr("input", {type: "radio", "aria-label": state.phrase(label),
                           name: "type", value: type, checked: active ? "checked" : null}), icon)
  }
  let aligned = !active || active.type == Image ? null : active.mark(Alignment) || "start" as const
  if (img) buttons.push(button("inline", "Inline", aligned == null))
  buttons.push(button("start", "Figure", aligned == "start"))
  if (align) {
    buttons.push(button("center", "Centered figure", aligned == "center"))
    buttons.push(button("end", "Figure aligned to end", aligned == "end"))
  }
  return [cr("span", {class: "wg-label"}, state.phrase("Image style:")), cr("span", buttons)]
}

const setImageDialog = Transaction.Effect.define<boolean>()

const createImagePanel: Panel.Constructor = view => {
  return {
    top: true,
    dom: buildImagePanel(view)
  }
}

function buildImagePanel(view: Wordgard) {
  let {state} = view
  let sel = (state.field(imageDialog) || state.selection).resolve(state.doc)
  let active = activeImage(sel)
  let size = !view.state.doc.schema.has(ImageSize) ? null :
    [cr("label", {for: "wg-img-size"}, state.phrase("Width in pixels:")),
     cr("input", {type: "number", id: "wg-img-size", name: "size", value: active ? active.mark(ImageSize) : ""})]
  let form = cr(
    "form", {class: "wg-img-form"},
    cr("div", {class: "wg-form-line wg-dialog-title"}, state.phrase(active ? "Update image" : "Insert image")),
    cr("label", {for: "wg-img-src"}, state.phrase("Image source:")),
    cr("input", {type: "text", id: "wg-img-src", name: "src",
                 value: active ? active.param : "", placeholder: "https://..."}),
    cr("label", {for: "wg-img-file"}, state.phrase("Or upload a file:")),
    cr("input", {type: "file", id: "wg-img-file", name: "file"}), // FIXME hide if no upload hook
    cr("label", {id: "wg-img-alt"}, state.phrase("Alternative text:")),
    cr("input", {type: "text", id: "wg-img-alt", name: "alt",
                 value: active && active.mark(ImageAlt) || "",
                 placeholder: state.phrase("Describe the image:")}),
    alignButtons(state, active),
    size,
    cr("div", {class: "wg-form-line"},
       cr("button", {type: "submit", class: "wg-dialog-button"}, state.phrase(active ? "Update" : "Insert")), " ",
       cr("button", {type: "button", class: "wg-dialog-button", onclick: close}, state.phrase("Cancel")))) as HTMLFormElement

  function onsubmit(e: Event) {
    e.preventDefault()
    let {state} = view, sel = (state.field(imageDialog) || state.selection).resolve(state.doc)
    let from = sel.from.pos, to = sel.to.pos
    if (sel.from.parent.node.type == CaptionedFigure && sel.to.parent.start == sel.from.parent.start) {
      from = sel.from.parent.before
      to = sel.from.parent.after
    }

    // FIXME validate
    let data = new FormData(form)
    let src = data.get("src") as string
    let type = data.get("type") as string | null
    let marks: readonly Mark<any>[] = []
    if (type == "center" || type == "end") marks = Alignment.of(type).addToSet(marks)
    if (data.get("alt")) marks = ImageAlt.of(data.get("alt") as string).addToSet(marks)
    if (data.get("size")) marks = ImageSize.of(Number(data.get("size") as string)).addToSet(marks)
    let tag = type == "inline" ? Image.of(src, marks) : Figure.of(src, marks)
    view.focus()
    view.dispatch({
      changes: {from, to, insert: [tag], fit: true},
      effects: setImageDialog.of(false),
      userEvent: "insert.image"
    })
  }

  function close() {
    view.focus()
    view.dispatch({effects: setImageDialog.of(false)})
  }

  return cr("wg-dialog", {class: "wg-img-dialog", onsubmit}, form)
}

export const insertImage: Command = view => {
  let val = view.state.field(imageDialog, false)
  if (val) {
    view.dispatch({effects: setImageDialog.of(false)})
  } else {
    let effects: Transaction.Effect<any>[] = [setImageDialog.of(true)]
    if (val === undefined) effects.push(Transaction.Effect.appendConfig.of(imageDialog))
    view.dispatch({effects})
  }
  return true
}

export const InsertImageButton = new MenuButton({
  run: insertImage,
  active: state => !!activeImage(state.sel),
  label: iconImage,
  description: "Insert an image",
  parent: Commands, // FIXME better group
  rank: 80,
})

const imageDialogTheme = Wordgard.baseTheme({
  ".wg-img-dialog": {
    borderBottom: "1px solid var(--wg-border-color)"
  },
  ".wg-img-form": {
    fontFamily: "sans-serif",
    padding: "5px 3px",
    display: "grid",
    gap: "8px 10px",
    alignItems: "center",
    gridTemplateColumns: "max-content auto",
    "& .wg-form-line": {
      gridColumn: "span 2",
    },
    "& label, & .wg-label": {
      textAlign: "right"
    }
  },
  ".wg-dialog-title": {
    fontSize: "80%",
    fontWeight: "bold",
  },
  ".wg-img-radio": {
    "& input[type=radio]": {
      opacity: "0",
      position: "absolute",
      pointerEvents: "none"
    },
    "& svg": {
      marginRight: "6px",
      width: "25px",
      "& .wg-img-icon-text": {fill: "#999"},
      "& .wg-img-icon-image": {fill: "#47e"},
    },
  },
  ".wg-img-radio input:checked + svg": {
    borderRadius: "2px",
    outline: "2px solid var(--wg-menu-highlight)"
  }
})

const imageDialog = GardState.Field.define<null | GardSelection>({
  create: () => null,
  update(value, tr) {
    for (let e of tr.effects) if (e.is(setImageDialog)) return e.value ? tr.state.selection : null
    return value && value.map(tr.changes)
  },
  provide: f => [
    GardState.prec.lowest(Panel.show.from(f, val => val && createImagePanel)),
    imageDialogTheme
  ]
})

// FIXME creation menu item, with hooks to customize

const baseSupport = [ImageAlt, InsertImageButton, imageDialog]

export function image(): GardState.Extension {
  return [Image, baseSupport]
}

export function figure(conf: {captioned?: boolean} = {}): GardState.Extension {
  return [Figure, conf?.captioned ? [CaptionedFigure] : [], baseSupport]
}

export function imageResizing(): GardState.Extension {
  return [ImageSize, resizeImageKeymap, dragHandle, imageTheme]
}
