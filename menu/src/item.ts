import {EditorView} from "@wordgard/view"
import {EditorState, Transaction, Facet, Extension} from "@wordgard/state"

export type MenuLabelWidget = {
  render: (view: EditorView) => HTMLElement
  rerender?: (tr: Transaction) => boolean
  update?: (elt: HTMLElement, view: EditorView) => void
}

export type MenuLabel = string | {icon: string} | MenuLabelWidget

export function isMenuLabelWidget(label: MenuLabel): label is MenuLabelWidget {
  return !!(label as any).render
}

export interface BaseMenuItem {
  type: string
  select?: (state: EditorState) => boolean
  enable?: (state: EditorState) => boolean
  /// By default, state predicates (`select`, `enable`, and `active`)
  /// are re-checked whenever the document or selection changes. If an
  /// item is sensitive to other aspects of the state, provide a test
  /// here that returns `true` for transactions that might affect the
  /// item state.
  updateFor?: (tr: Transaction) => boolean
  parent?: MenuGroup | Submenu
  rank?: number
}

export interface MenuButton extends BaseMenuItem {
  type: "button"
  run: (view: EditorView) => void
  active?: (state: EditorState) => boolean
  // FIXME use 100x100 viewport for these, find better icons
  label: MenuLabel
  description: string
}

export interface MenuGroup extends BaseMenuItem {
  type: "group"
  margin?: boolean
}

export interface Submenu extends BaseMenuItem {
  type: "submenu"
  description: string
  label?: MenuLabel
  defaultLabel?: MenuLabel
  arrow?: boolean
  width?: number
}

export type MenuItem = MenuButton | MenuGroup | Submenu

export const menuItem = Facet.define<MenuItem>()

export class MenuTemplate {
  parent: MenuGroup | Submenu | null
  rank: number

  private constructor(readonly item: MenuGroup | Submenu, readonly content: readonly (MenuTemplate | MenuItem | "...")[] = []) {
    this.parent = item.parent ?? null
    this.rank = item.rank ?? 100
  }

  static of(item: MenuGroup | Submenu, ...content: (MenuTemplate | MenuItem | "...")[]) {
    return new MenuTemplate(item, content.length ? content : ["..."])
  }
}

export const Top: MenuGroup = {type: "group"}
export const Commands: MenuGroup = {type: "group", parent: Top, rank: 10}
export const InlineStyles: MenuGroup = {type: "group", parent: Top, rank: 30, margin: true}

export const Undo: MenuButton = {
  type: "button",
  run: () => { console.log("undo"); return true },
  label: {icon: "M8 3a5 5 0 1 1-4.55 2.91.5.5 0 0 0-.91-.42A6 6 0 1 0 8 2z M8 4.47V.534.25.25 0 0 0-.41-.19L5.23 2.31a.25.25 0 0 0 0 .38l2.36 1.97A.25.25 0 0 0 8 4.47"},
  description: "Undo",
  parent: Commands,
  rank: 10
}

export const Redo: MenuButton = {
  type: "button",
  run: () => { console.log("redo"); return true },
  label: {icon: "M8 3a5 5 0 1 0 4.55 2.91.5.5 0 0 1 .91-.42A6 6 0 1 1 8 2z M8 4.47V.53a.25.25 0 0 1 .41-.19l2.36 1.97c.12.1.12.28 0 .38L8.41 4.66A.25.25 0 0 1 8 4.47"},
  description: "Redo",
  parent: Commands,
  rank: 20
}

export const Strong: MenuButton = {
  type: "button",
  run: () => { console.log("strong"); return true },
  label: {icon: "M8.21 13c2.11 0 3.41-1.09 3.41-2.82 0-1.31-.98-2.28-2.32-2.39v-.06a2.18 2.18 0 0 0 1.85-2.14c0-1.51-1.16-2.46-3.014-2.46H3.843V13zM5.91 4.67h1.70c.96 0 1.52.45 1.52 1.24 0 .83-.63 1.32-1.73 1.32H5.91V4.67zm0 6.79V8.60h1.73c1.22 0 1.88.49 1.88 1.41 0 .94-.64 1.45-1.83 1.45H5.91z"},
  description: "Toggle strong emphasis",
  parent: InlineStyles,
  rank: 10
}

export const Alignment: Submenu = {
  type: "submenu",
  parent: Top,
  defaultLabel: {icon: "M2 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
  rank: 50,
  description: "Text alignment",
  arrow: false,
}

// FIXME use start/end nomenclature?
export const AlignLeft: MenuButton = {
  type: "button",
  run: () => { console.log("left"); return true },
  label: {icon: "M2 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
  description: "Align left",
  parent: Alignment,
  rank: 10
}

export const AlignRight: MenuButton = {
  type: "button",
  run: () => { console.log("right"); return true },
  label: {icon: "M6 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-4-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m4-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-4-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
  description: "Align right",
  parent: Alignment,
  rank: 20
}

export const AlignCenter: MenuButton = {
  type: "button",
  run: () => { console.log("center"); return true },
  label: {icon: "M4 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
  description: "Center",
  parent: Alignment,
  rank: 30
}

export const TextblockStyle: Submenu = {
  type: "submenu",
  defaultLabel: "Block style",
  description: "Block style",
  parent: Top,
  rank: 5,
  width: 10,
}

export const Paragraph: MenuButton = {
  type: "button",
  run: () => { console.log("para"); return true },
  label: "Paragraph",
  description: "Paragraph",
  parent: TextblockStyle,
  rank: 20
}

export const Header: Submenu = {
  type: "submenu",
  label: "Header",
  description: "Header",
  parent: TextblockStyle,
  rank: 30
}

export const Header1: MenuButton = {
  type: "button",
  run: () => { console.log("h1"); return true },
  label: "Header 1",
  description: "Header level 1",
  parent: Header,
  rank: 30
}

export const Header2: MenuButton = {
  type: "button",
  run: () => { console.log("h2"); return true },
  label: "Header 2",
  description: "Header level 2",
  parent: Header,
  rank: 31
}

export const Header3: MenuButton = {
  type: "button",
  run: () => { console.log("h3"); return true },
  label: "Header 3",
  description: "Header level 3",
  parent: Header,
  rank: 32
}

// FIXME drop
export const staticMenu: Extension[] = [
  Undo, Redo, Strong,
  AlignLeft, AlignRight, AlignCenter,
  Commands, InlineStyles, Alignment,
  TextblockStyle, Paragraph, Header, Header1, Header2, Header3,
].map(i => menuItem.of(i))

export type ResolvedMenuItem = MenuItem | "|" | ResolvedSubmenu

export class ResolvedSubmenu {
  constructor(readonly item: Submenu, readonly content: readonly ResolvedMenuItem[]) {}
}

export function resolveMenu(
  items: readonly MenuItem[],
  template: MenuTemplate | readonly MenuTemplate[] = MenuTemplate.of(Top)
): readonly ResolvedMenuItem[] {
  let used = new Map<MenuItem, number>()
  function scan(template: MenuTemplate) {
    used.set(template.item, 1)
    for (let child of template.content) {
      if (child instanceof MenuTemplate) scan(child)
      else if (typeof child != "string") used.set(child, 1)
    }
  }
  function margin(target: ResolvedMenuItem[]) {
    if (target.length && target[target.length - 1] !== "|") target.push("|")
  }
  function resolve(template: MenuItem | MenuTemplate,
                   content: readonly (MenuTemplate | MenuItem | "...")[] | null,
                   target: ResolvedMenuItem[],
                   fromTemplate: boolean) {
    if (template instanceof MenuTemplate) {
      resolve(template.item, template.content, target, true)
    } else {
      let wasUsed = used.get(template)
      if (fromTemplate ? wasUsed == 2 : wasUsed != null) return
      used.set(template, 2)
      if (template.type == "submenu" || template.type == "group") {
        if (template.type == "group" && template.margin) margin(target)
        let innerTarget: ResolvedMenuItem[] = template.type == "submenu" ? [] : target
        for (let elt of content || ["..."]) {
          if (elt === "...") {
            let found: MenuItem[] = items.filter(i => i.parent == template)
            for (let item of found.sort((a, b) => (a.rank ?? 100) - (b.rank ?? 100))) resolve(item, null, innerTarget, false)
          } else {
            resolve(elt, null, innerTarget, fromTemplate)
          }
        }
        if (innerTarget != target && innerTarget.length) {
          if (innerTarget[innerTarget.length - 1] === "|") innerTarget.pop()
          if (innerTarget.length) target.push(new ResolvedSubmenu(template as Submenu, innerTarget))
        } else if (template.type == "group" && template.margin) {
          margin(target)
        }
      } else {
        target.push(template)
      }
    }
  }

  let top: ResolvedMenuItem[] = []
  if (Array.isArray(template)) {
    for (let elt of template) scan(elt)
    for (let elt of template) resolve(elt, null, top, true)
  } else {
    scan(template as MenuTemplate)
    resolve(template as MenuTemplate, null, top, true)
  }
  if (top.length && top[top.length - 1] === "|") top.pop()
  return top
}
