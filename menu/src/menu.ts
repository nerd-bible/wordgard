import {showPanel, EditorView, ViewUpdate} from "@wordgard/view"
import {EditorState, Extension} from "@wordgard/state"
import {MenuLabel, MenuItem, MenuButton, MenuSelect, resolveMenu, staticMenu, ResolvedGroup} from "./item"

// FIXME use view.dom.ownerDocument
// FIXME redraw when menu-item facets change

type BarElement = BarButton | BarSelect

let nextID = 0

function id(prefix: string) {
  return prefix + "-" + (nextID++ % 0xffffff).toString(16)
}

const SVG = "http://www.w3.org/2000/svg"

function labelButton(state: EditorState, button: HTMLElement, label: MenuLabel) {
  if (typeof label == "string") {
    button.textContent = state.phrase(label)
  } else {
    button.textContent = ""
    let svg = button.appendChild(document.createElementNS(SVG, "svg"))
    svg.classList.add("wg-icon")
    svg.setAttribute("viewBox", "0 0 16 16")
    let path = svg.appendChild(document.createElementNS(SVG, "path"))
    path.setAttribute("d", label.icon)
  }
}

class BarButton {
  dom: HTMLElement
  hidden = false
  active = false
  enabled = true

  constructor(readonly item: MenuButton, view: EditorView) {
    this.dom = document.createElement("button")
    this.dom.className = "wg-menu-button"
    this.dom.tabIndex = -1
    labelButton(view.state, this.dom, item.label)
    this.dom.setAttribute("aria-label", this.dom.title = view.state.phrase(item.description))
    this.update(view.state)
  }

  get focusDOM() { return this.dom }

  run(view: EditorView) {
    if (!this.hidden && this.enabled)
      this.item.run(view)
  }

  update(state: EditorState) {
    if (this.item.select && !this.item.select(state)) {
      this.setHidden(true)
    } else {
      this.setHidden(false)
      if (this.item.enable && !this.item.enable(state)) {
        this.setEnabled(false)
        this.setActive(false)
      } else if (this.item.active) {
        this.setEnabled(true)
        this.setActive(this.item.active(state))
      }
    }
  }

  setHidden(value: boolean) {
    if (value != this.hidden) {
      this.hidden = value
      this.dom.style.display = value ? "none" : ""
    }
  }

  setEnabled(value: boolean) {
    if (value != this.enabled) {
      this.enabled = value
      if (value) this.dom.removeAttribute("aria-disabled")
      else this.dom.setAttribute("aria-disabled", "true")
    }
  }

  setActive(value: boolean) {
    if (value != this.active) {
      this.active = value
      if (value) this.dom.setAttribute("aria-pressed", "true")
      else this.dom.removeAttribute("aria-pressed")
    }
  }
}

// FIXME handle hidden items
function setSelected(target: {elts: readonly BarElement[], selected: number}, index: number, focus = true) {
  if (focus && index >= 0) target.elts[index].focusDOM.focus()
  if (index != target.selected) {
    if (index > -1) {
      let dom = target.elts[index].focusDOM
      dom.setAttribute("aria-selected", "true")
      dom.tabIndex = 0
    }
    if (target.selected >= 0) {
      let dom = target.elts[target.selected].focusDOM
      dom.removeAttribute("aria-selected")
      dom.tabIndex = -1
    }
    target.selected = index
  }
}


class BarSelect {
  dom: HTMLElement
  button: HTMLElement
  list: HTMLElement
  open = false
  selected = -1
  activeChild: BarElement | null | undefined = null

  constructor(readonly item: MenuSelect, readonly elts: readonly BarElement[], readonly view: EditorView) {
    this.dom = document.createElement("wg-menu-select")
    this.button = this.dom.appendChild(document.createElement("button"))
    this.button.className = "wg-menu-button"
    this.button.setAttribute("aria-haspopup", "true")
    this.button.setAttribute("aria-expanded", "false")
    this.button.setAttribute("aria-label", this.button.title = view.state.phrase(item.description))
    if (item.label) labelButton(view.state, this.button, item.label)
    this.list = this.dom.appendChild(document.createElement("wg-menu-list"))
    this.list.style.display = "none"
    this.list.role = "menu"
    this.list.id = id("wg-popup")
    this.list.setAttribute("aria-label", this.dom.title)
    this.button.setAttribute("aria-controls", this.list.id)
    for (let elt of elts) {
      this.list.appendChild(elt.dom)
      elt.dom.role = "menuitemradio"
    }
    this.list.addEventListener("mousedown", event => this.click(event))
    this.list.addEventListener("keydown", event => this.key(event))
    this.list.addEventListener("focusout", () => {
      setTimeout(() => {
        if (!this.list.contains(document.activeElement)) this.setOpen(false)
      }, 20)
    })
    this.updateActive(view.state)
    setSelected(this, 0, false)
  }

  get focusDOM() { return this.button }

  run(view: EditorView) {
    this.setOpen(!this.open)
  }

  setOpen(open: boolean) {
    if (this.open == open) return
    this.open = open
    this.button.setAttribute("aria-expanded", String(open))
    if (open) {
      this.list.style.display = "block"
      setSelected(this, this.activeChild ? this.elts.indexOf(this.activeChild) : this.selected, true)
    } else {
      this.list.style.display = "none"
    }
  }

  update(state: EditorState) {
    for (let elt of this.elts) elt.update(state)
    this.updateActive(state)
  }

  updateActive(state: EditorState) {
    if (this.item.label) return
    let active = this.elts.find(e => e instanceof BarButton && e.active)
    if (active !== this.activeChild) {
      this.activeChild = active
      labelButton(state, this.button, (active?.item as MenuButton)?.label || this.item.defaultLabel) // FIXME
    }
  }

  key(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key == "ArrowUp") {
      setSelected(this, (this.selected ? this.selected : this.elts.length) - 1)
    } else if (event.key == "ArrowDown") {
      setSelected(this, this.selected == this.elts.length - 1 ? 0 : this.selected + 1)
    } else if (event.key == "ArrowLeft" || event.key == "ArrowRight") {
      this.setOpen(false)
      // FIXME can we be sure parent is appropriate here?
      this.dom.parentElement!.focus()
      return
    } else if (event.key == "Home" || event.key == "End") {
      setSelected(this, event.key == "Home" ? 0 : this.elts.length - 1)
    } else if (event.key == " " || event.key == "Enter") {
      this.focusDOM.focus()
      this.setOpen(false)
      this.elts[this.selected].run(this.view)
    } else if (event.key == "Escape") {
      this.focusDOM.focus()
      this.setOpen(false)
    } else {
      return
    }
    event.stopPropagation()
    event.preventDefault()
  }

  click(event: MouseEvent) {
    let i = this.elts.findIndex(e => e.dom.contains(event.target as HTMLElement))
    if (i < 0) return
    setSelected(this, i)
    this.elts[i].run(this.view)
    event.preventDefault()
  }
}

function instantiate(item: MenuItem | ResolvedGroup, view: EditorView): BarElement {
  if (item instanceof ResolvedGroup) return new BarSelect(item.item as MenuSelect /* FIXME */,
                                                          item.content.map(i => instantiate(i, view)), view)
  else if (item.type == "button") return new BarButton(item, view)
  else throw new Error("No implementation for menu item type " + item.type)
}

const menuPlugin = showPanel.of(view => new MenuBar(view))

class MenuBar {
  dom: HTMLElement
  elts: readonly BarElement[]
  selected = -1

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("wg-menubar")
    this.dom.role = "toolbar"
    this.dom.setAttribute("aria-controls", view.contentDOM.id)
    this.dom.addEventListener("keydown", this.key.bind(this))
    this.dom.addEventListener("mousedown", this.click.bind(this))
    this.elts = resolveMenu(staticMenu).map(i => instantiate(i, view))
    for (let elt of this.elts) this.dom.appendChild(elt.dom)
    if (this.elts.length) setSelected(this, 0, false)
  }

  update(update: ViewUpdate) {
    for (let elt of this.elts) elt.update(update.state)
  }

  key(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key == "ArrowLeft") {
      setSelected(this, (this.selected ? this.selected : this.elts.length) - 1)
    } else if (event.key == "ArrowRight") {
      setSelected(this, this.selected == this.elts.length - 1 ? 0 : this.selected + 1)
    } else if (event.key == "Home" || event.key == "End") {
      setSelected(this, event.key == "Home" ? 0 : this.elts.length - 1)
    } else if (event.key == " " || event.key == "Enter") {
      this.elts[this.selected].run(this.view)
    } else {
      return
    }
    event.preventDefault()
  }

  click(event: MouseEvent) {
    let i = this.elts.findIndex(e => e.dom.contains(event.target as HTMLElement))
    if (i < 0) return
    setSelected(this, i)
    this.elts[i].run(this.view)
    event.preventDefault()
  }

  get top() { return true }
}

const theme = EditorView.baseTheme({
  "&": {
    "--wg-menu-item-size": "20px",
    "--wg-menu-highlight": "#6af"
  },

  "wg-menubar": {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    padding: "2px",
    // FIXME light/dark colors
    color: "#555",
    borderBottom: "1px solid var(--wg-border-color)",
  },

  ".wg-menu-button:focus": {
    outline: "1.5px solid var(--wg-menu-highlight)"
  },

  ".wg-menu-button": {
    display: "block",
    border: 0,
    padding: "1px",
    borderRadius: "2px",
    backgroundColor: "transparent",
    font: "inherit",
    height: "var(--wg-menu-item-size)",
    "&[aria-disabled]": {
      opacity: "0.4"
    },
    "&[aria-pressed]": {
      color: "var(--wg-menu-highlight)"
    },
    "&:hover": {
      backgroundColor: "#88888827",
    },
  },

  "svg.wg-icon": {
    fill: "currentColor",
    width: "var(--wg-menu-item-size)",
    height: "var(--wg-menu-item-size)",
  },

  "wg-menu-select": {
    position: "relative",
  },

  "wg-menu-list": {
    borderRadius: "2px",
    padding: "1.5px",
    backgroundColor: "var(--wg-panel-color)",
    position: "absolute",
    left: "-1.5px",
    top: "100%",
    border: "1px solid var(--wg-border-color)",
  },
})

export function menuBar(): Extension {
  return [menuPlugin, theme]
}
