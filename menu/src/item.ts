import {EditorView, toggleProp, setTextblockType, wrapBlock, unwrapBlockType,
        toggleList, listIsActive, showDialog} from "@wordgard/view"
import {EditorState, Transaction, Facet, Extension} from "@wordgard/state"
import {Prop, Tag, NodePos, canAddPropInRange, ChangeSpec,
        Strong, Emphasis, Code, Link,
        Paragraph, CodeBlock, Heading, BulletList, OrderedList, Blockquote} from "@wordgard/doc"
import {iconUndo, iconRedo, iconBold, iconItalic, iconCode, iconLink, iconBulletList, iconOrderedList, iconQuote} from "./icon"

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
    this.arrow = spec.arrow !== false
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
export const BlockMenu = new MenuGroup({parent: Top, rank: 50, margin: true})

export function toggleInlineProp(config: {
  prop: Prop<any>,
  parent?: MenuGroup | Submenu
  rank?: number
  description?: string
  label: MenuLabel
}) {
  let {prop, parent, rank, description, label} = config
  return new MenuButton({
    run: toggleProp(prop),
    active(state) {
      let {selection} = state
      if (selection.empty)
        return !!prop.isInSet(selection.props || state.sel.head.props())
      else
        return !selection.ranges.some(r => canAddPropInRange(state.doc, r.from, r.to, prop))
    },
    parent,
    rank,
    description,
    label
  })
}

export const ToggleStrong = toggleInlineProp({
  prop: Strong,
  parent: InlineStyles,
  rank: 10,
  description: "Toggle strong emphasis",
  label: iconBold
})

export const ToggleEmphasis = toggleInlineProp({
  prop: Emphasis,
  parent: InlineStyles,
  rank: 12,
  description: "Toggle emphasis",
  label: iconItalic
})

export const ToggleCode = toggleInlineProp({
  prop: Code,
  parent: InlineStyles,
  rank: 30,
  description: "Toggle code font",
  label: iconCode
})

export const ToggleLink = new MenuButton({
  run(view) {
    let {selection, doc} = view.state
    if (selection.empty) return false
    let remove: ChangeSpec[] = []
    for (let {from, to} of selection.ranges) doc.iterate(from, to, (node, pos) => {
      let has = node.tag.hasProp(Link)
      if (has) remove.push({from: pos, to: pos + node.length, remove: has})
    })
    if (remove.length) {
      view.dispatch({changes: remove, userEvent: "prop.remove"})
    } else {
      showDialog(view, {
        label: "Link target",
        input: {type: "text", name: "url"},
        submitLabel: "Create link",
        focus: true
      }).result.then(form => {
        view.focus()
        let url = form && (form.elements.namedItem("url") as HTMLInputElement)?.value
        if (url) view.dispatch({
          changes: selection.ranges.map(r => ({from: r.from, to: r.to, add: Link.of(url)})),
          userEvent: "prop.add"
        })
      })
    }
    return true
  },
  active(state) {
    let {selection, doc} = state, found = false
    if (!selection.empty) for (let {from, to} of selection.ranges) doc.iterate(from, to, node => {
      if (found) return false
      if (node.tag.hasProp(Link)) found = true
    })
    return found
  },
  enable(state) {
    return !state.selection.empty
  },
  label: iconLink,
  description: "Create a link",
  parent: InlineStyles,
  rank: 50,
})

// FIXME wire up actual undo/redo commands

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

export const TextblockStyle = new Submenu({
  defaultLabel: "Block style",
  description: "Block style",
  parent: Top,
  rank: 5,
  width: 10,
})

function selectionInType(tag: Tag<any>) {
  return (state: EditorState) => {
    let {sel} = state, block = sel.head.textblockParent
    return !!block && block.start == sel.anchor.textblockParent?.start && block.node.tag.eq(tag)
  }
}

export const ParagraphButton = new MenuButton({
  run: setTextblockType(Paragraph),
  active: selectionInType(Paragraph),
  label: "Paragraph",
  parent: TextblockStyle,
  rank: 10
})

export const CodeBlockButton = new MenuButton({
  run: setTextblockType(CodeBlock),
  active: selectionInType(CodeBlock),
  label: "Code block",
  parent: TextblockStyle,
  rank: 30
})

export const Heading1 = new MenuButton({
  run: setTextblockType(Heading.of(1)),
  active: selectionInType(Heading.of(1)),
  label: "Heading 1",
  parent: TextblockStyle,
  rank: 50
})

export const Heading2 = new MenuButton({
  run: setTextblockType(Heading.of(2)),
  active: selectionInType(Heading.of(2)),
  label: "Heading 2",
  parent: TextblockStyle,
  rank: 51
})

export const Heading3 = new MenuButton({
  run: setTextblockType(Heading.of(3)),
  active: selectionInType(Heading.of(3)),
  label: "Heading 3",
  parent: TextblockStyle,
  rank: 52
})

export const BulletListButton = new MenuButton({
  run: toggleList(BulletList),
  active: listIsActive(BulletList),
  label: iconBulletList,
  description: "Toggle bullet list",
  parent: BlockMenu,
  rank: 20
})

export const OrderedListButton = new MenuButton({
  run: toggleList(OrderedList.default!),
  active: listIsActive(OrderedList.default!),
  label: iconOrderedList,
  description: "Toggle ordered list",
  parent: BlockMenu,
  rank: 30
})

export const BlockquoteButton = new MenuButton({
  run: view => unwrapBlockType(Blockquote)(view) || wrapBlock(Blockquote)(view),
  active: state => {
    for (let cur: NodePos | null = state.sel.head.parent; cur; cur = cur.parent)
      if (cur.node.type == Blockquote.type) return true
    return false
  },
  label: iconQuote,
  description: "Toggle blockquote",
  parent: BlockMenu,
  rank: 40
})

// FIXME drop
export const staticMenu: Extension[] = [
  Undo, Redo, Strong,
  Commands, InlineStyles, BlockMenu, ToggleStrong, ToggleEmphasis, ToggleCode, ToggleLink,
  TextblockStyle, ParagraphButton, CodeBlockButton, Heading1, Heading2, Heading3,
  BulletListButton, OrderedListButton, BlockquoteButton
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
