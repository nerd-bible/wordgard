import {Node, Mark, ChangeSet, Plot} from "wordgard/doc"
import {Wordgard, Panel, showDialog} from "wordgard/view"
import {GardState, Transaction, GardSelection, Facet, Direction, PhraseSet} from "wordgard/state"
import {ImageSize, ImageAlt, Image, Figure, CaptionedFigure, Alignment} from "wordgard/schema"
import {Command} from "wordgard/command"
import {phrases} from "wordgard/phrases"
import cr from "crelt"

export const imageUploader = Facet.define<(file: File, view: Wordgard, progress: (percent: number) => void) => Promise<string>>()

const imageTypes = [Image, Figure, CaptionedFigure]

export function activeImage(sel: GardSelection.Resolved) {
  if (sel.selection instanceof GardSelection.Node && imageTypes.includes(sel.selection.node.type)) return sel.selection.node.tag
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

function imageTypeButtons(state: GardState, active: Node.Tag | null) {
  let hasImg = state.doc.schema.has(Image), hasFig = state.doc.schema.has(Figure), hasCap = state.doc.schema.has(CaptionedFigure)
  let align = (hasFig || hasCap) && state.doc.schema.markAllowed(Alignment, hasFig ? Figure : CaptionedFigure)
  if (!align && !(hasImg && (hasFig || hasCap))) return null
  let buttons: HTMLElement[] = []
  function button(type: "inline" | "start" | "center" | "end", label: PhraseSet.Tag<typeof phrases>, active: boolean | null) {
    let labelText = phrases.get(state, label)
    let icon = document.createElementNS(svg, "svg")
    icon.setAttribute("viewbox", "0 0 24 22")
    icon.setAttribute("width", "24"); icon.setAttribute("height", "22")
    icon.appendChild(rect(1, 1, 22, 3, "wg-img-icon-text"))
    let flip = state.textDirection() == Direction.RTL
    icon.appendChild(rect(type == "start" ? (flip ? 12 : 2) : type == "end" ? (flip ? 2 : 12) : 7, 6, 10, 10, "wg-img-icon-image"))
    if (type == "inline") {
      icon.appendChild(rect(1, 12, 5, 3, "wg-img-icon-text"))
      icon.appendChild(rect(18, 12, 5, 3, "wg-img-icon-text"))
    }
    icon.appendChild(rect(1, 18, 22, 3, "wg-img-icon-text"))
    return cr("label", {class: "wg-img-radio", title: labelText},
              cr("input", {type: "radio", "aria-label": labelText,
                           name: "type", value: type, checked: active ? "checked" : null}), icon)
  }
  let aligned = !active || active.type == Image ? null : active.mark(Alignment) || "start" as const
  if (hasImg) buttons.push(button("inline", "inline", aligned == null))
  buttons.push(button("start", "figure", aligned == "start"))
  if (align) {
    buttons.push(button("center", "figure_center", aligned == "center"))
    buttons.push(button("end", "figure_end", aligned == "end"))
  }
  if (hasFig && hasCap) {
    let caption = cr(
      "label", " ",
      cr("input", {type: "checkbox", name: "caption",
                   checked: active && active.type == CaptionedFigure ? "checked" : null}),
      " ", phrases.get(state, "captioned"))
    if (hasImg) {
      let imageRadio = buttons[0].querySelector("input") as HTMLInputElement
      for (let b of buttons) b.querySelector("input")!.addEventListener("change", () => {
        caption.style.display = imageRadio.checked ? "none" : ""
      })
      if (!aligned) caption.style.display = "none"
    }
    buttons.push(caption)
  }
  return [cr("span", {class: "wg-label"}, phrases.get(state, "image_style"), ":"), cr("span", buttons)]
}

const setImageDialog = Transaction.Effect.define<boolean>()

const createImagePanel: Panel.Constructor = view => {
  let dom = buildImagePanel(view), mustFocus = true
  return {
    top: true,
    dom,
    connect() {
      if (mustFocus) {
        mustFocus = false
        let target = dom.querySelector("input[name=src]") as HTMLElement | null
        if (target) target.focus()
      }
    }
  }
}

function startUpload(view: Wordgard, file: HTMLInputElement, set: (url: string) => void) {
  let imageFile = file.files?.[0], handler = view.state.facet(imageUploader)[0]
  if (!imageFile || !handler) return
  let promise = handler(imageFile, view, percent => {
    progress.lastChild!.textContent = Math.round(percent) + "%"
  })
  let progress = cr("span", {class: "wg-img-upload", style: `width: ${file!.offsetWidth}px`},
                    phrases.get(view.state, "uploading"), " ", cr("span"))
  file.parentNode!.replaceChild(progress, file)
  function reset() {
    if (progress.parentNode) progress.parentNode.replaceChild(file, progress)
  }
  promise.then(url => {
    reset()
    set(url)
  }, err => {
    reset()
    showDialog(view, {label: phrases.get(view.state, "upload_failed") + ": " + err})
  })
}

// FIXME add support for custom mark fields. Move size into that.

function buildImagePanel(view: Wordgard) {
  let {state} = view
  let sel = (state.field(imageDialog) || state.selection).resolve(state.doc)
  let active = activeImage(sel)
  let size = !view.state.doc.schema.has(ImageSize) ? null :
    [cr("label", {for: "wg-img-size"}, phrases.get(state, "width"), ":"),
     cr("input", {type: "number", id: "wg-img-size", name: "size", value: active ? active.mark(ImageSize) : ""})]
  let src = cr("input", {type: "text", id: "wg-img-src", name: "src", required: "required",
                         value: active ? active.param : "", placeholder: "https://..."})
  let file: HTMLInputElement | null = null
  if (view.state.facet(imageUploader).length) {
    file = cr("input", {type: "file", id: "wg-img-file", name: "file", "aria-label": phrases.get(state, "upload_image"),
                        onchange: (e: Event) => startUpload(view, e.target as HTMLInputElement, url => src.value = url)})
  }

  let form = cr(
    "form", {class: "wg-img-form", onkeydown},
    cr("div", {class: "wg-dialog-title"}, phrases.get(state, active ? "update_image" : "insert_image")),
    cr("label", {for: "wg-img-src"}, phrases.get(state, "image_source"), ":"),
    cr("span", {class: "wg-img-src-line"}, src, file),
    cr("label", {for: "wg-img-alt"}, phrases.get(state, "alt_text"), ":"),
    cr("input", {type: "text", id: "wg-img-alt", name: "alt",
                 value: active && active.mark(ImageAlt) || "",
                 placeholder: phrases.get(state, "describe_image")}),
    imageTypeButtons(state, active),
    size,
    cr("div", {class: "wg-img-buttons"},
       cr("button", {type: "submit", class: "wg-dialog-button"}, phrases.get(state, active ? "update" : "insert")), " ",
       cr("button", {type: "button", class: "wg-dialog-button", onclick: close}, phrases.get(state, "cancel"))))

  function onsubmit(e: Event) {
    e.preventDefault()
    let {state} = view, sel = (state.field(imageDialog) || state.selection).resolve(state.doc)

    let data = new FormData(form)
    let src = data.get("src") as string
    if (!src) return
    let type = data.get("type") as string | null, cap = !!data.get("caption") || !state.doc.schema.has(Figure)
    let marks: readonly Mark<any>[] = []
    if (type == "center" || type == "end") marks = Alignment.of(type).addToSet(marks)
    if (data.get("alt")) marks = ImageAlt.of(data.get("alt") as string).addToSet(marks)
    if (data.get("size")) marks = ImageSize.of(Number(data.get("size") as string)).addToSet(marks)
    let tag = type == "inline" ? Image.of(src, marks) : cap ? CaptionedFigure.of(src, marks) : Figure.of(src, marks)

    let change: ChangeSet.Spec
    if (sel.from.parent.node.type == CaptionedFigure && sel.to.parent.start == sel.from.parent.start) {
      let from = sel.from.parent.before
      // Replacing a captioned figure
      if (tag instanceof Plot.Tag)
        change = {from, to: from + 1, insert: [tag]}
      else
        change = {from, to: sel.from.parent.after, insert: [tag], fit: true}
    } else {
      change = {from: sel.from.pos, to: sel.to.pos, insert: [tag instanceof Plot.Tag ? tag.create() : tag], fit: true}
    }

    view.focus()
    let changes = ChangeSet.create(state.doc, change), pos = changes.findInserted(t => t == tag) ?? change.from
    view.dispatch({
      changes: change,
      effects: setImageDialog.of(false),
      userEvent: "insert.image",
      selection: tag instanceof Plot.Tag ? {anchor: pos + 1} : GardSelection.node(pos, tag)
    })
  }

  function close() {
    view.focus()
    view.dispatch({effects: setImageDialog.of(false)})
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key == "Escape") {
      e.preventDefault()
      close()
    }
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

const imageDialogTheme = Wordgard.baseTheme({
  ".wg-img-dialog": {
    borderBottom: "1px solid var(--wg-border-color)"
  },
  ".wg-img-form": {
    padding: "5px 3px",
    display: "grid",
    gap: "8px",
    alignItems: "center",
    gridTemplateColumns: "max-content auto",
    "& label, & .wg-label": {
      textAlign: "right"
    }
  },
  ".wg-dialog-title": {
    gridColumn: "span 2",
    fontSize: "90%",
    fontWeight: "bold",
    textAlign: "center"
  },
  ".wg-img-buttons": {
    gridColumn: "2"
  },
  ".wg-img-src-line": {
    display: "flex",
    gap: "7px",
    "& [type=text]": {
      flex: "1"
    }
  },
  ".wg-img-radio": {
    display: "inline-block",
    verticalAlign: "middle",
    "& input[type=radio]": {
      opacity: "0",
      position: "absolute",
      pointerEvents: "none"
    },
    "& svg": {
      marginRight: "6px",
      width: "24px",
      "& .wg-img-icon-text": {fill: "#bbb"},
      "& .wg-img-icon-image": {fill: "#888"},
    },
    "& input:checked + svg .wg-img-icon-image": {
      fill: "var(--wg-highlight-color)"
    },
    "& input:focus + svg": {
      borderRadius: "2px",
      outline: "2px solid var(--wg-highlight-color)",
    },
  },
  ".wg-img-upload": {
    boxSizing: "border-box",
    padding: "4px",
    fontSize: "80%"
  }
})

export const imageDialog = GardState.Field.define<null | GardSelection>({
  create: () => null,
  update(value, tr) {
    for (let e of tr.effects) if (e.is(setImageDialog)) return e.value ? tr.state.selection : null
    return value && value.map(tr.changes, tr.newDoc)
  },
  provide: f => [
    GardState.prec.lowest(Panel.show.from(f, val => val && createImagePanel)),
    imageDialogTheme
  ]
})

