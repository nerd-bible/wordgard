import {showPanel, EditorView, ViewUpdate} from "@wordgard/view"
import {EditorState, Extension} from "@wordgard/state"
import {MenuLabel, MenuButton, Submenu, resolveMenu, staticMenu, ResolvedSubmenu, ResolvedMenuItem} from "./item"

// FIXME redraw when menu-item facets change

type BarElement = BarButton | BarSubmenu

let nextID = 0

function id(prefix: string) {
  return prefix + "-" + (nextID++ % 0xffffff).toString(16)
}

const SVG = "http://www.w3.org/2000/svg"

function labelButton(state: EditorState, button: HTMLElement, label: MenuLabel) {
  button.textContent = ""
  if (typeof label == "string") {
    let span = button.appendChild(document.createElement("span"))
    span.className = "wg-button-label"
    span.textContent = state.phrase(label)
  } else {
    let svg = button.appendChild(document.createElementNS(SVG, "svg"))
    svg.classList.add("wg-icon")
    svg.setAttribute("viewBox", "0 0 16 16")
    let path = svg.appendChild(document.createElementNS(SVG, "path"))
    path.setAttribute("d", label.icon)
  }
}

const enum F {
  // For a submenu element, indicates whether the menu is open
  Open = 2,
  // Whether this element is currently selected
  Selected = 4,
  // Set when the element is disabled
  Disabled = 8,
  // Being active suggests an item's effect applies to the current
  // state, for example with the cursor in emphasized text, the
  // emphasis button will be active
  Active = 16,
  // Set when the element is hidden entirely
  Hidden = 32,
}

class BarButton {
  dom: HTMLElement
  flags: F = 0 as F
  index = 0

  constructor(readonly item: MenuButton, state: EditorState) {
    this.dom = document.createElement("button")
    this.dom.className = "wg-menu-button"
    this.dom.tabIndex = -1
    labelButton(state, this.dom, item.label)
    this.dom.setAttribute("aria-label", this.dom.title = state.phrase(item.description))
  }

  get focusDOM() { return this.dom }

  update(flags: F) {
    if (flags != this.flags) {
      if ((flags & F.Hidden) != (this.flags & F.Hidden))
        this.dom.style.display = flags & F.Hidden ? "none" : ""
      if ((flags & F.Disabled) != (this.flags & F.Disabled)) {
        if (flags & F.Disabled) this.dom.removeAttribute("aria-disabled")
        else this.dom.setAttribute("aria-disabled", "true")
      }
      if ((flags & F.Selected) != (this.flags & F.Selected)) {
        if (flags & F.Selected) this.dom.setAttribute("aria-selected", "true")
        else this.dom.removeAttribute("aria-selected")
        this.dom.tabIndex = flags & F.Selected ? 0 : -1
      }
      if ((flags & F.Active) != (this.flags & F.Active)) {
        if (flags & F.Active) this.dom.setAttribute("aria-pressed", "true")
        else this.dom.removeAttribute("aria-pressed")
      }
      this.flags = flags
    }
  }
}

class BarSubmenu {
  dom: HTMLElement
  button: HTMLElement
  list: HTMLElement
  flags: F = 0 as F
  // Initialized to -3. -2 means the submenu has its own label, > -2
  // means taking label from that active child, -1 is no active child
  activeChild = -3
  index = 0
  children: readonly BarElement[]

  constructor(readonly item: Submenu, children: readonly (BarElement | BarSpacer)[], state: EditorState) {
    this.dom = document.createElement("div")
    this.dom.className = "wg-submenu"
    this.button = this.dom.appendChild(document.createElement("button"))
    this.button.tabIndex = -1
    this.button.className = "wg-menu-button"
    this.button.setAttribute("aria-haspopup", "true")
    this.button.setAttribute("aria-expanded", "false")
    this.button.setAttribute("aria-label", this.button.title = state.phrase(item.description))
    if (item.label) {
      labelButton(state, this.button, item.label)
      this.activeChild = -2
    }
    if (item.width != null) this.dom.style.setProperty("--wg-submenu-width", item.width + "ch")
    if (item.arrow !== false) this.button.classList.add("wg-submenu-arrow")
    this.list = this.dom.appendChild(document.createElement("div"))
    this.list.className = "wg-menu-list"
    this.list.style.display = "none"
    this.list.role = "menu"
    this.list.id = id("wg-popup")
    this.list.setAttribute("aria-label", this.button.title)
    this.button.setAttribute("aria-controls", this.list.id)
    this.children = children.filter((ch): ch is BarElement => !(ch instanceof BarSpacer))
    for (let child of children) {
      this.list.appendChild(child.dom)
      if (!(child instanceof BarSpacer))
        child.focusDOM.role = "menuitem"
    }
  }

  get focusDOM() { return this.button }

  update(flags: F, state: EditorState) {
    if (flags != this.flags) {
      if ((flags & F.Hidden) != (this.flags & F.Hidden))
        this.dom.style.display = flags & F.Hidden ? "none" : ""
      if ((flags & F.Disabled) != (this.flags & F.Disabled)) {
        if (flags & F.Disabled) this.button.removeAttribute("aria-disabled")
        else this.button.setAttribute("aria-disabled", "true")
      }
      if ((flags & F.Selected) != (this.flags & F.Selected)) {
        if (flags & F.Selected) this.button.setAttribute("aria-selected", "true")
        else this.button.removeAttribute("aria-selected")
        this.button.tabIndex = flags & F.Selected ? 0 : -1
      }
      if ((flags & F.Open) != (this.flags & F.Open))
        this.list.style.display = flags & F.Open ? "" : "none"
      this.flags = flags
    }
    if (this.activeChild != -2) {
      let activeChild = this.children.findIndex(ch => ch.flags & F.Active)
      if (this.activeChild != activeChild) {
        this.activeChild = activeChild
        let label = (activeChild < 0 ? this.item.defaultLabel : (this.children[activeChild].item as MenuButton).label) ?? ""
        labelButton(state, this.button, label)
      }
    }
  }
}

class BarSpacer {
  dom: HTMLElement

  constructor() {
    this.dom = document.createElement("div")
    this.dom.className = "wg-menu-spacer"
  }
}

function instantiate(item: ResolvedMenuItem, state: EditorState, flat: BarElement[]): BarElement | BarSpacer {
  let elt
  if (item instanceof ResolvedSubmenu)
    elt = new BarSubmenu(item.item as Submenu /* FIXME */,
                         item.content.map(i => instantiate(i, state, flat)), state)
  else if (item === "|")
    return new BarSpacer()
  else if (item.type == "button")
    elt = new BarButton(item, state)
  else
    throw new Error("No implementation for menu item type " + item.type)
  elt.index = flat.length
  flat.push(elt)
  return elt
}

const menuPlugin = showPanel.of(view => new MenuBar(view))

// FIXME separate from tooltip, export as utility
class MenuBar {
  dom: HTMLElement
  elts: readonly BarElement[]
  children: readonly BarElement[]
  selection: readonly BarElement[]
  focusTimeout = -1

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("wg-menubar")
    this.dom.role = "toolbar"
    this.dom.setAttribute("aria-controls", view.contentDOM.id)
    this.dom.addEventListener("keydown", this.key.bind(this))
    this.dom.addEventListener("mousedown", this.click.bind(this))
    this.dom.addEventListener("focusout", this.focusout.bind(this))
    let elts: BarElement[] = []
    this.elts = elts
    let children = resolveMenu(staticMenu).map(i => instantiate(i, view.state, elts))
    this.children = children.filter((ch): ch is BarElement => !(ch instanceof BarSpacer))
    for (let elt of children) this.dom.appendChild(elt.dom)
    this.selection = this.children.length ? [this.children[0]] : []
    this.updateElts(view.state, true, this.selection)
    this.globalClick = this.globalClick.bind(this)
  }

  update(update: ViewUpdate) {
    this.updateElts(update.state, update, this.selection)
  }

  updateElts(state: EditorState, update: ViewUpdate | boolean, selection: readonly BarElement[]) {
    let changed = typeof update == "boolean" ? update : update.docChanged || update.selectionSet
    for (let i = this.elts.length - 1; i >= 0; i--) {
      let elt = this.elts[i], flags
      if (update && (update === true || (elt.item.updateFor ? update.transactions.some(tr => elt.item.updateFor!(tr)) : changed))) {
        flags = ((elt.item.select ? elt.item.select(state) : true) ? 0 : F.Hidden) |
          ((elt.item.enable ? elt.item.enable(state) : true) ? 0 : F.Disabled) |
          ((elt instanceof BarButton && elt.item.active ? elt.item.active(state) : false) ? F.Active : 0)
      } else {
        flags = elt.flags & (F.Hidden | F.Disabled | F.Active)
      }
      if (selection.length) {
        let selected = selection.indexOf(elt)
        if (selected == selection.length - 1) flags |= F.Selected
        else if (selected > -1) flags |= F.Open
      }
      elt.update(flags, state)
    }
    if (update && selection.some(e => e.flags & F.Hidden)) {
      let reset = selection[0].flags & F.Hidden ? findChild(this.children, true) : selection[0]
      this.setSelection(reset ? [reset] : [])
    }
  }

  setSelection(selection: readonly BarElement[], focus = true) {
    this.updateElts(this.view.state, false, selection)
    if (selection.length > 1 && this.selection.length <= 1)
      this.dom.ownerDocument.addEventListener("mousedown", this.globalClick)
    this.selection = selection
    if (focus && selection.length) selection[selection.length - 1].focusDOM.focus()
  }

  key(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    let sLen = this.selection.length
    if (event.key == "ArrowLeft" || event.key == "ArrowRight") {
      if (sLen) {
        let forward = (event.key == "ArrowRight") == (getComputedStyle(this.dom).direction == "ltr")
        let next = findNextChild(this.children, this.selection[0], forward ? 1 : -1)
        this.setSelection(next ? [next] : [])
      }
    } else if (event.key == "ArrowDown" || event.key == "ArrowUp") {
      if (sLen > 1) {
        let parent = this.selection[sLen - 2] as BarSubmenu
        let next = findNextChild(parent.children, this.selection[sLen - 1], event.key == "ArrowUp" ? -1 : 1)
        if (next) this.setSelection(this.selection.slice(0, sLen - 1).concat(next))
      } else if (sLen == 1 && this.selection[0] instanceof BarSubmenu) {
        let inner = defaultChild(this.selection[0].children)
        if (inner) this.setSelection([this.selection[0], inner])
      }
    } else if (event.key == "Home" || event.key == "End") {
      let child = findChild(sLen > 1 ? (this.selection[sLen - 2] as BarSubmenu).children : this.children, event.key == "Home")
      if (child) this.setSelection(this.selection.slice(0, sLen - 1).concat(child))
    } else if (event.key == " " || event.key == "Enter") {
      if (sLen) {
        let child = this.selection[sLen - 1]
        if (child.flags & F.Disabled) {
        } else if (child instanceof BarButton) { // FIXME
          child.item.run(this.view)
          this.setSelection([this.selection[0]])
        } else {
          let inner = defaultChild(child.children)
          if (inner) this.setSelection(this.selection.concat(inner))
        }
      }
    } else if (event.key == "Escape" && sLen > 1) {
      this.setSelection(this.selection.slice(0, sLen - 1))
    } else {
      return
    }
    event.preventDefault()
  }

  click(event: MouseEvent) {
    let target: BarElement | undefined, idx
    for (let node = event.target as Node | null;; node = node.parentNode) {
      if (!node || node == this.dom) return
      target = this.elts.find(e => e.dom == node)
      if (target) break
    }

    if (target instanceof BarButton) { // FIXME
      target.item.run(this.view)
      this.setSelection(this.children.includes(target) ? [target] : this.selection.length ? [this.selection[0]] : [], false)
    } else if ((idx = this.selection.indexOf(target)) > -1 && idx < this.selection.length - 1) {
      // Closing an open submenu
      this.setSelection(this.selection.slice(0, idx + 1), false)
    } else {
      for (let i = 0; i < this.selection.length; i++) {
        let {children} = i ? this.selection[i - 1] as BarSubmenu : this
        if (children.includes(target)) {
          let next = defaultChild(target.children)
          if (next) this.setSelection(this.selection.slice(0, i).concat([target, next]), false)
        }
      }
    }
    event.preventDefault()
  }

  globalClick(event: MouseEvent) {
    if (!this.dom.contains(event.target as HTMLElement)) {
      this.dom.ownerDocument.removeEventListener("mousedown", this.globalClick)
      if (this.selection.length > 1) this.setSelection([this.selection[0]], false)
    }
  }

  focusout() {
    clearTimeout(this.focusTimeout)
    if (this.selection.length > 1) {
      this.focusTimeout = setTimeout(() => {
        let active = this.view.root.activeElement
        for (let i = 0; i < this.selection.length - 1; i++) {
          if (!active || !this.selection[i].dom.contains(active)) {
            this.setSelection([this.selection[0]], false)
            break
          }
        }
      }, 20)
    }
  }

  get top() { return true }
}

function findChild(children: readonly BarElement[], start: boolean) {
  for (let i = start ? 0 : children.length - 1; start ? i < children.length : i >= 0; start ? i++ : i--) {
    let child = children[i]
    if (!(child.flags & F.Disabled)) return child
  }
  return null
}

function findNextChild(children: readonly BarElement[], child: BarElement, dir: -1 | 1) {
  let index = children.indexOf(child)
  if (index < 0) return null
  for (let i = index + dir;; i += dir) {
    if (i < 0) i = children.length - 1
    else if (i >= children.length) i = 0
    if (i == index) return null
    let child = children[i]
    if (!(child.flags & F.Hidden)) return child
  }
}

function defaultChild(children: readonly BarElement[]) {
  return children.length ? children.find(ch => ch.flags & F.Active) || children[0] : null
}

const theme = EditorView.baseTheme({
  "&": {
    "--wg-menu-item-size": "20px",
    "--wg-menu-highlight": "#6af"
  },
  "&light": {
    "--wg-menu-color": "#555"
  },
  "&dark": {
    "--wg-menu-color": "#ccc"
  },

  "wg-menubar": {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    padding: "2px",
    color: "var(--wg-menu-color)",
    borderBottom: "1px solid var(--wg-border-color)",
  },

  ".wg-menu-button:focus": {
    outline: "1.5px solid var(--wg-menu-highlight)"
  },

  ".wg-menu-button": {
    border: 0,
    padding: "1px",
    borderRadius: "2px",
    backgroundColor: "transparent",
    font: "inherit",
    color: "inherit",
    height: "var(--wg-menu-item-size)",
    textAlign: "left",
    "&[aria-disabled]": {
      opacity: "0.3"
    },
    "&[aria-pressed]": {
      color: "var(--wg-menu-highlight)"
    },
    "&:hover": {
      backgroundColor: "#88888820",
    },
  },

  ".wg-button-label": {
    display: "inline-block",
    minWidth: "var(--wg-submenu-width)",
    padding: "0 3px",
  },

  "svg.wg-icon": {
    fill: "currentColor",
    width: "var(--wg-menu-item-size)",
    height: "var(--wg-menu-item-size)",
  },

  ".wg-menu-spacer": {
    width: "3px"
  },

  ".wg-submenu": {
    position: "relative",
    lineHeight: ".6",
    whiteSpace: "nowrap"
  },

  ".wg-menu-list": {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "2px",
    borderRadius: "2px",
    padding: "1.5px",
    backgroundColor: "var(--wg-panel-color)",
    position: "absolute",
    left: "-1.5px",
    top: "100%",
    border: "1px solid var(--wg-border-color)",
    "& .wg-menu-list": {
      left: "100%",
      top: 0
    }
  },

  ".wg-submenu-arrow:after": {
    padding: "0 2px",
    fontSize: "80%",
    verticalAlign: "10%",
    opacity: "0.4",
    content: "'▾'"
  },
  ".wg-submenu-arrow.wg-submenu-arrow-open:after": {
    content: "'▴'"
  },
})

export function menuBar(): Extension {
  return [menuPlugin, theme]
}
