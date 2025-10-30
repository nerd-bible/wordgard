import {showPanel, EditorView, ViewUpdate} from "@wordgard/view"
import {EditorState, Extension} from "@wordgard/state"
import {MenuItem, staticMenu} from "./item"

type BarElement = BarButton | BarDropDown

let nextID = 0

function id(prefix: string) {
  return prefix + "-" + (nextID++ % 0xffffff).toString(16)
}

const SVG = "http://www.w3.org/2000/svg"

class BarButton {
  dom: HTMLElement
  hidden = false
  active = false
  enabled = true

  constructor(readonly item: MenuItem, state: EditorState) {
    this.dom = document.createElement("wg-menu-item")
    this.dom.role = "button"
    this.dom.id = id("wg-menubar-item")
    if (typeof item.label == "string") {
      this.dom.textContent = state.phrase(item.label)
    } else {
      this.dom.className = "wg-icon"
      let svg = this.dom.appendChild(document.createElementNS(SVG, "svg"))
      svg.setAttribute("viewBox", "0 0 16 16")
      let path = svg.appendChild(document.createElementNS(SVG, "path"))
      path.setAttribute("d", item.label.icon)
    }
    let desc = state.phrase(item.description)
    this.dom.title = desc
    this.dom.setAttribute("aria-label", desc)
    this.update(state)
  }

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

class BarDropDown {
  dom: HTMLElement
  list: HTMLElement
  elts: readonly BarElement[]

  constructor(items: readonly MenuItem[], state: EditorState) {
    this.dom = document.createElement("wg-menu-item")
    this.dom.role = "button"
    this.dom.setAttribute("aria-haspopup", "true")
    this.dom.setAttribute("aria-expanded", "false")
    this.dom.setAttribute("aria-controls", "FIXME")
    this.list = document.createElement("wg-menu-list")
    this.dom.appendChild(this.list)
    this.elts = items.map(i => new BarButton(i, state))
    for (let elt of this.elts) this.list.appendChild(elt.dom)
  }

  run(view: EditorView) {
    // FIXME
  }

  update(state: EditorState) {
    for (let elt of this.elts) elt.update(state)
  }
}

const menuPlugin = showPanel.of(view => new MenuBar(view))

class MenuBar {
  dom: HTMLElement
  elts: readonly BarElement[]
  selected = -1

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("wg-menubar")
    this.dom.role = "toolbar"
    this.dom.tabIndex = 0
    this.dom.setAttribute("aria-controls", view.contentDOM.id)
    this.dom.addEventListener("keydown", this.key.bind(this))
    this.dom.addEventListener("mousedown", this.click.bind(this))
    this.elts = staticMenu.map(i => new BarButton(i, view.state))
    for (let elt of this.elts) this.dom.appendChild(elt.dom)
    this.setSelected(0)
  }

  update(update: ViewUpdate) {
    for (let elt of this.elts) elt.update(update.state)
  }

  key(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key == "ArrowLeft") {
      this.setSelected((this.selected ? this.selected : this.elts.length) - 1)
    } else if (event.key == "ArrowRight") {
      this.setSelected(this.selected == this.elts.length - 1 ? 0 : this.selected + 1)
    } else if (event.key == "Home" || event.key == "End") {
      this.setSelected(event.key == "Home" ? 0 : this.elts.length - 1)
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
    this.setSelected(i)
    this.elts[i].run(this.view)
    event.preventDefault()
  }

  // FIXME somehow skip hidden items
  setSelected(index: number) {
    if (index == this.selected) return
    if (this.selected >= 0) this.elts[this.selected].dom.removeAttribute("aria-selected")
    let elt = this.elts[this.selected = index]
    elt.dom.setAttribute("aria-selected", "true")
    this.dom.setAttribute("aria-activedescendant", elt.dom.id)
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
    outline: 0,

    "&:focus [aria-selected=true]": {
      outline: "1.5px solid var(--wg-menu-highlight)"
    }
  },

  "wg-menu-item": {
    display: "block",
    padding: "1px",
    borderRadius: "2px",
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
    "&.wg-icon": {
      "& svg": {
        fill: "currentColor",
        width: "var(--wg-menu-item-size)",
        height: "var(--wg-menu-item-size)",
      }
    },
  }
})

export function menuBar(): Extension {
  return [menuPlugin, theme]
}
