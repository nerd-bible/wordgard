import {EditorView} from "@wordgard/view"
import {EditorState, Transaction, Facet, Extension} from "@wordgard/state"
import {iconAlignLeft, iconAlignRight, iconAlignCenter, iconUndo, iconRedo, iconBold} from "./icon"

export type MenuLabelWidget = {
  render: (view: EditorView) => HTMLElement
  rerender?: (tr: Transaction) => boolean
  update?: (elt: HTMLElement, view: EditorView) => void
}

// FIXME use 100x100 viewport for these, find better icons
export type MenuLabel = string | {icon: string, directional?: boolean} | MenuLabelWidget

export function isMenuLabelWidget(label: MenuLabel): label is MenuLabelWidget {
  return !!(label as any).render
}

export interface MenuItemSpec {
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
  description?: string
}

// FIXME messy
function fillItem(spec: MenuItemSpec, obj: {
  select: ((state: EditorState) => boolean) | undefined
  enable: ((state: EditorState) => boolean) | undefined
  updateFor: ((tr: Transaction) => boolean) | undefined
  parent: MenuGroup | Submenu | undefined
  rank: number
  description: string | undefined
}) {
  obj.select = spec.select
  obj.enable = spec.enable
  obj.updateFor = spec.updateFor
  obj.parent = spec.parent
  obj.rank = spec.rank ?? 100
  obj.description = spec.description
}

export class MenuButton implements MenuItemSpec {
  declare select: ((state: EditorState) => boolean) | undefined
  declare enable: ((state: EditorState) => boolean) | undefined
  declare updateFor: ((tr: Transaction) => boolean) | undefined
  declare parent: MenuGroup | Submenu | undefined
  declare rank: number
  declare description: string | undefined
  label: MenuLabel
  run: (view: EditorView) => void
  active: ((state: EditorState) => boolean) | undefined
  extension: Extension

  constructor(spec: {
    run: (view: EditorView) => void
    active?: (state: EditorState) => boolean
    label: MenuLabel
  } & MenuItemSpec) {
    fillItem(spec, this)
    this.run = spec.run
    this.active = spec.active
    this.label = spec.label
    this.extension = menuItem.of(this)
  }
}

export class Submenu implements MenuItemSpec {
  declare select: ((state: EditorState) => boolean) | undefined
  declare enable: ((state: EditorState) => boolean) | undefined
  declare updateFor: ((tr: Transaction) => boolean) | undefined
  declare parent: MenuGroup | Submenu | undefined
  declare rank: number
  declare description: string | undefined
  label: MenuLabel | undefined
  defaultLabel: MenuLabel | undefined
  arrow: boolean
  width: number | undefined
  extension: Extension

  constructor(spec: {
    label?: MenuLabel
    defaultLabel?: MenuLabel
    arrow?: boolean
    width?: number
  } & MenuItemSpec) {
    fillItem(spec, this)
    this.label = spec.label
    this.defaultLabel = spec.defaultLabel
    this.arrow = !!spec.arrow
    this.width = spec.width
    this.extension = menuItem.of(this)
  }

  template(...content: (MenuTemplate | MenuItem | "...")[]) {
    return new MenuTemplate(this, content.length ? content : ["..."])
  }
}

export class MenuGroup {
  margin: boolean
  extension: Extension
  parent: MenuGroup | Submenu | undefined
  rank: number

  constructor(spec: {
    margin?: boolean
    parent?: MenuGroup | Submenu
    rank?: number
  } = {}) {
    this.margin = !!spec.margin
    this.extension = menuItem.of(this)
    this.parent = spec.parent
    this.rank = spec.rank ?? 100
  }

  template(...content: (MenuTemplate | MenuItem | "...")[]) {
    return new MenuTemplate(this, content.length ? content : ["..."])
  }
}

export type MenuItem = MenuButton | Submenu | MenuGroup

export const menuItem = Facet.define<MenuItem>()

export class MenuTemplate {
  parent: MenuGroup | Submenu | null
  rank: number

  constructor(readonly item: MenuGroup | Submenu, readonly content: readonly (MenuTemplate | MenuItem | "...")[] = []) {
    this.parent = item.parent ?? null
    this.rank = item.rank ?? 100
  }
}

export const Top = new MenuGroup()
export const Commands = new MenuGroup({parent: Top, rank: 10})
export const InlineStyles = new MenuGroup({parent: Top, rank: 30, margin: true})

export const Undo = new MenuButton({
  run: () => { console.log("undo"); return true },
  label: iconUndo,
  description: "Undo",
  parent: Commands,
  rank: 10
})

export const Redo = new MenuButton({
  run: () => { console.log("redo"); return true },
  label: iconRedo,
  description: "Redo",
  parent: Commands,
  rank: 20
})

export const Strong = new MenuButton({
  run: () => { console.log("strong"); return true },
  label: iconBold,
  description: "Toggle strong emphasis",
  parent: InlineStyles,
  rank: 10
})

export const Alignment = new Submenu({
  parent: Top,
  defaultLabel: iconAlignLeft,
  rank: 50,
  description: "Text alignment",
  arrow: false,
})

// FIXME use start/end nomenclature?
export const AlignLeft = new MenuButton({
  run: () => { console.log("left"); return true },
  label: iconAlignLeft,
  description: "Align left",
  parent: Alignment,
  rank: 10
})

export const AlignRight = new MenuButton({
  run: () => { console.log("right"); return true },
  label: iconAlignRight,
  description: "Align right",
  parent: Alignment,
  rank: 20
})

export const AlignCenter = new MenuButton({
  run: () => { console.log("center"); return true },
  label: iconAlignCenter,
  description: "Center",
  parent: Alignment,
  rank: 30
})

export const TextblockStyle = new Submenu({
  defaultLabel: "Block style",
  description: "Block style",
  parent: Top,
  rank: 5,
  width: 10,
})

export const Paragraph = new MenuButton({
  run: () => { console.log("para"); return true },
  label: "Paragraph",
  description: "Paragraph",
  parent: TextblockStyle,
  rank: 20
})

export const Header = new Submenu({
  label: "Header",
  description: "Header",
  parent: TextblockStyle,
  rank: 30
})

export const Header1 = new MenuButton({
  run: () => { console.log("h1"); return true },
  label: "Header 1",
  description: "Header level 1",
  parent: Header,
  rank: 30
})

export const Header2 = new MenuButton({
  run: () => { console.log("h2"); return true },
  label: "Header 2",
  description: "Header level 2",
  parent: Header,
  rank: 31
})

export const Header3 = new MenuButton({
  run: () => { console.log("h3"); return true },
  label: "Header 3",
  description: "Header level 3",
  parent: Header,
  rank: 32
})

// FIXME drop
export const staticMenu: Extension[] = [
  Undo, Redo, Strong,
  AlignLeft, AlignRight, AlignCenter,
  Commands, InlineStyles, Alignment,
  TextblockStyle, Paragraph, Header, Header1, Header2, Header3,
]

export type ResolvedMenuItem = MenuButton | "|" | ResolvedSubmenu

export class ResolvedSubmenu {
  constructor(readonly item: Submenu, readonly content: readonly ResolvedMenuItem[]) {}
}

export function resolveMenu(
  items: readonly MenuItem[],
  template: MenuTemplate | readonly MenuTemplate[] = Top.template(),
  suppress?: readonly MenuItem[]
): readonly ResolvedMenuItem[] {
  // 1 means not used yet, but will be used in template, so ignore
  // when filling items, 2 means used/suppressed
  let used = new Map<MenuItem, number>()
  if (suppress) for (let item of suppress) used.set(item, 2)
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
      if (template instanceof Submenu || template instanceof MenuGroup) {
        if (template instanceof MenuGroup && template.margin) margin(target)
        let innerTarget: ResolvedMenuItem[] = template instanceof Submenu ? [] : target
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
        } else if (template instanceof MenuGroup && template.margin) {
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
