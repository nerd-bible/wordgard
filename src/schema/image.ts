import {elt} from "wordgard/doc"
import {Wordgard, PointSet, Decoration, KeyBinding, logException} from "wordgard/editor"
import {GardState, Transaction, GardSelection} from "wordgard/state"
import {ImageSize, ImageAlt, Image, Figure, CaptionedFigure} from "wordgard/schema-def"
import {Command, Menu} from "wordgard/command"
import {imagePhrases} from "wordgard/phrases"
import {imageDialog, insertImage, activeImage, imageUploader} from "./imagedialog"

function baseSupport(): GardState.Extension {
  return [GardState.schemaElement.of(ImageAlt), image.button, imageDialog, image.keymap, image.dropHandler]
}

export function image(): GardState.Extension {
  return [GardState.schemaElement.of(Image), baseSupport()]
}

export function figure(conf: {captioned?: boolean} = {}): GardState.Extension {
  return [GardState.schemaElement.of(Figure), conf?.captioned ? [GardState.schemaElement.of(CaptionedFigure)] : [], baseSupport()]
}

export function imageResizing(): GardState.Extension {
  return [GardState.schemaElement.of(ImageSize), resizeImage.keymap, resizeImage.dragHandle, imageTheme]
}

const imageTheme = Wordgard.theme({
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
    let newPos = mapping.mapPos(value.target, 1, "after")
    return newPos == null ? undefined : {target: newPos, resizing: value.resizing}
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

function imageNode(wg: Wordgard, pos: number) {
  let dom = wg.nodeDOM(pos)!
  return dom.nodeName == "IMG" ? dom : dom.querySelector("img[src]")!
}

const resizeHandlers = Wordgard.domEventHandlers({
  mousedown: (event, wg) => {
    let resizing = wg.state.field(resizeState)
    if (resizing.target < 0) return
    for (let dom = event.target as Element;;) {
      if (dom.classList.contains("wg-resize-handle-active")) break
      let next = dom.parentNode as Element | null
      if (!next || next == wg.contentDOM) return
      dom = next
    }
    let node = wg.state.doc.nodeAt(resizing.target)!
    let width = node.tag.mark(ImageSize) ?? imageNode(wg, resizing.target).getBoundingClientRect().width
    wg.dispatch({effects: setResizing.of({target: resizing.target, resizing: width})})
    event.preventDefault()
  },
  mousemove: (event, wg) => {
    let resizing = wg.state.field(resizeState)
    if (resizing.resizing > -1) {
      let dom = imageNode(wg, resizing.target)
      let width = event.clientX - dom.getBoundingClientRect().left
      if (width >= MIN_SIZE && Math.abs(width - resizing.resizing) >= 1)
        wg.dispatch({effects: setResizing.of({target: resizing.target, resizing: width})})
    } else {
      let elt = (event.target as HTMLElement).closest("img, .wg-resize-handle")
      let node = elt && wg.nodeFromDOM(elt)
      let target = node && wg.state.doc.schema.markAllowed(ImageSize, node.node.type) ? node.pos : -1
      if (target != resizing.target)
        wg.dispatch({effects: setResizing.of({target, resizing: -1})})
    }
  },
  mouseup: (event, wg) => {
    let resizing = wg.state.field(resizeState)
    if (resizing.resizing < 0) return
    wg.dispatch({
      effects: setResizing.of({target: resizing.target, resizing: -1}),
      changes: {from: resizing.target, add: ImageSize.of(Math.round(resizing.resizing))}
    })
  }
})

export namespace resizeImage {
  export const resizeCommand = (by: number, relative = false): Command => wg => {
    let {selection} = wg.state
    if (selection instanceof GardSelection.Node && wg.state.doc.schema.markAllowed(ImageSize, selection.node.type)) {
      let curWidth = selection.node.mark(ImageSize) ?? imageNode(wg, wg.state.selection.from).getBoundingClientRect().width
      let newWidth = Math.max(MIN_SIZE, relative ? curWidth * by : curWidth + by)
      if (newWidth != curWidth) {
        wg.dispatch({
          changes: {from: wg.state.selection.from, add: ImageSize.of(newWidth)},
          userEvent: "image.resize"
        })
        return true
      }
    }
    return false
  }

  export const keymap = [
    KeyBinding.define({key: "Ctrl-Alt-l", mac: "Ctrl-Cmd-l", run: resizeCommand(1.1, true)}),
    KeyBinding.define({key: "Ctrl-Alt-k", mac: "Ctrl-Cmd-k", run: resizeCommand(0.9, true)}),
  ]

  export const dragHandle: GardState.Extension = [
    GardState.prec.high(resizeHandlers),
    resizeState,
    Decoration.source.of(s => s.field(resizeState).deco),
  ]
}

export namespace image {
  export const keymap = [
    KeyBinding.define({key: "Ctrl-Alt-i", mac: "Ctrl-Cmd-i", run: insertImage})
  ]

  export const button = Menu.Button.define({
    run: insertImage,
    active: state => !!activeImage(state.sel),
    label: {
      icon: "M38 34a9 9 0 1 1-19 0 9 9 0 0 1 19 0M9 13A9 9 0 0 0 0 22v56A9 9 0 0 0 9 88h81a9 9 0 0 0 9-9v-56A9 9 0 0 0 91 13zm81 6a3 3 0 0 1 3 3v38l-24-12a3 3 0 0 0-4 1l-23 23-17-11a3 3 0 0 0-4 0L6 75v3L6 78v-56a3 3 0 0 1 3-3z"
    },
    description: imagePhrases.ref("insert_image"),
    parent: Menu.Group.commands, // FIXME better group
    rank: 80,
  })

  export const dropHandler = GardState.prec.lowest(Wordgard.domEventHandlers({
    drop: (event, wg) => {
      let {state} = wg, upload = state.facet(imageUploader)[0]
      const type = state.doc.schema.has(Image) ? Image : state.doc.schema.has(Figure) ? Figure : null
      if (!type || !upload || !event.dataTransfer) return false
      let files = event.dataTransfer.files, uploads: Promise<string>[] = []
      for (let i = 0; i < files.length; i++) {
        let file = files[i]
        if (/^image\//.test(file.type))
          uploads.push(upload(file, wg, () => {}))
      }
      if (!uploads.length) return false
      let dropPos = {x: event.clientX, y: event.clientY}
      Promise.all(uploads).then(urls => {
        wg.dispatch({
          changes: {from: wg.posAtCoords(dropPos).pos, insert: urls.map(u => type.of(u)), fit: true},
          userEvent: "drop.image"
        })
      }, err => {
        logException(state, err, "Dropped image upload")
      })
      return true
    }
  }))

  export const insert = insertImage

  export const uploader = imageUploader
}
