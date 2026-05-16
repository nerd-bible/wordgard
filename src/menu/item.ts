import {type Wordgard} from "wordgard/editor"
import {Command} from "wordgard/command"
import {GardState, Transaction, Facet, PhraseSet} from "wordgard/state"
import {phrases} from "wordgard/phrases"

export type MenuLabelWidget = {
  render: (wg: Wordgard) => HTMLElement
  rerender?: (tr: Transaction) => boolean
  update?: (elt: HTMLElement, wg: Wordgard) => void
}

export type MenuLabel = PhraseSet.Ref | {icon: string, directional?: boolean} | MenuLabelWidget

export function isMenuLabelWidget(label: MenuLabel): label is MenuLabelWidget {
  return !!(label as any).render
}

export interface MenuItemSpec {
  select?: (state: GardState) => boolean
  enable?: (state: GardState) => boolean
  /// By default, state predicates (`select`, `enable`, and `active`)
  /// are re-checked whenever the document or selection changes. If an
  /// item is sensitive to other aspects of the state, provide a test
  /// here that returns `true` for transactions that might affect the
  /// item state.
  updateFor?: (tr: Transaction) => boolean
  parent?: MenuGroup | Submenu
  rank?: number
  description?: PhraseSet.Ref
}

class BaseItem {
  select: ((state: GardState) => boolean) | undefined
  enable: ((state: GardState) => boolean) | undefined
  updateFor: ((tr: Transaction) => boolean) | undefined
  parent: MenuGroup | Submenu | undefined
  rank: number
  description: PhraseSet.Ref | undefined

  constructor(spec: MenuItemSpec) {
    this.select = spec.select
    this.enable = spec.enable
    this.updateFor = spec.updateFor
    this.parent = spec.parent
    this.rank = spec.rank ?? 100
    this.description = spec.description
  }
}

// FIXME make it easier to modify these
export class MenuButton extends BaseItem {
  label: MenuLabel
  run: Command.Bound | Command
  active: ((state: GardState) => boolean) | undefined
  extension: GardState.Extension

  constructor(spec: {
    run: Command.Bound | Command
    active?: (state: GardState) => boolean
    label: MenuLabel
  } & MenuItemSpec) {
    super(spec)
    this.run = spec.run
    this.active = spec.active
    this.label = spec.label
    this.extension = menuItem.of(this)
  }
}

export class CustomControl extends BaseItem {
  render: (wg: Wordgard, done: () => void) => {dom: HTMLElement, focus?: HTMLElement}
  setEnabled: ((dom: Element, enabled: boolean) => void) | undefined
  extension: GardState.Extension

  constructor(spec: {
    render: (wg: Wordgard, done: () => void) => {dom: HTMLElement, focus?: HTMLElement}
    setEnabled?: (focus: Element, enabled: boolean) => void
  } & MenuItemSpec) {
    super(spec)
    this.render = spec.render
    this.setEnabled = spec.setEnabled
    this.extension = menuItem.of(this)
  }
}

export class Submenu extends BaseItem {
  label: MenuLabel | undefined
  defaultLabel: MenuLabel | undefined
  arrow: boolean
  width: number | undefined
  content: readonly (MenuItem | "...")[] | undefined
  extension: GardState.Extension

  constructor(spec: {
    label?: MenuLabel
    defaultLabel?: MenuLabel
    arrow?: boolean
    width?: number,
    content?: readonly (MenuItem | "...")[]
  } & MenuItemSpec) {
    super(spec)
    this.label = spec.label
    this.defaultLabel = spec.defaultLabel
    this.arrow = spec.arrow !== false
    this.width = spec.width
    this.content = spec.content
    this.extension = menuItem.of(this)
  }

  template(...content: (MenuTemplate | MenuItem | "...")[]) {
    return new MenuTemplate(this, content.length ? content : ["..."])
  }
}

export class MenuGroup {
  margin: boolean
  extension: GardState.Extension
  parent: MenuGroup | Submenu | undefined
  rank: number
  content: readonly (MenuItem | "...")[] | undefined

  constructor(spec: {
    margin?: boolean
    parent?: MenuGroup | Submenu
    rank?: number,
    content?: readonly (MenuItem | "...")[]
  } = {}) {
    this.margin = !!spec.margin
    this.extension = menuItem.of(this)
    this.parent = spec.parent
    this.rank = spec.rank ?? 100
    this.content = spec.content
  }

  template(...content: (MenuTemplate | MenuItem | "...")[]) {
    return new MenuTemplate(this, content.length ? content : ["..."])
  }
}

export type MenuItem = MenuButton | CustomControl | Submenu | MenuGroup

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
export const BlockMenu = new MenuGroup({parent: Top, rank: 50, margin: true})

export const TextblockStyle = new Submenu({
  defaultLabel: phrases.ref("block_style"),
  description: phrases.ref("block_style"),
  parent: Top,
  rank: 5,
  width: 10,
})

// FIXME drop
export const staticMenu: GardState.Extension[] = [
  Commands, BlockMenu,
  TextblockStyle,
]

export type ResolvedMenuItem = MenuButton | CustomControl | "|" | ResolvedSubmenu

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
        for (let elt of content || template.content || ["..."]) {
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
