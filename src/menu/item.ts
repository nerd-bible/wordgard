import {EditorView, showDialog} from "wordgard/view"
import {toggleMark, changeTextblockType, toggleBlock, toggleList, listIsActive,
        canAddMarkInRange, setAlignment} from "wordgard/command"
import {GardState, Transaction, Facet} from "wordgard/state"
import {Mark, Plot, Pos, ChangeSet} from "wordgard/doc"
import {Strong, Emphasis, Code, Link,
        Paragraph, CodeBlock, Heading, BulletList, OrderedList, Blockquote,
        Underline, Superscript, Subscript,
        Alignment} from "wordgard/schema"
import {iconUndo, iconRedo, iconBold, iconItalic, iconCode, iconLink, iconBulletList,
        iconOrderedList, iconQuote, iconUnderline, iconSuperscript, iconSubscript,
        iconAlignLeft,
        iconAlignRight,
        iconAlignCenter} from "./icon"

export type MenuLabelWidget = {
  render: (view: EditorView) => HTMLElement
  rerender?: (tr: Transaction) => boolean
  update?: (elt: HTMLElement, view: EditorView) => void
}

export type MenuLabel = string | {icon: string, directional?: boolean} | MenuLabelWidget

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
  description?: string
}

// FIXME messy
function fillItem(spec: MenuItemSpec, obj: {
  select: ((state: GardState) => boolean) | undefined
  enable: ((state: GardState) => boolean) | undefined
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
  declare select: ((state: GardState) => boolean) | undefined
  declare enable: ((state: GardState) => boolean) | undefined
  declare updateFor: ((tr: Transaction) => boolean) | undefined
  declare parent: MenuGroup | Submenu | undefined
  declare rank: number
  declare description: string | undefined
  label: MenuLabel
  run: (view: EditorView) => void
  active: ((state: GardState) => boolean) | undefined
  extension: GardState.Extension

  constructor(spec: {
    run: (view: EditorView) => void
    active?: (state: GardState) => boolean
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
  declare select: ((state: GardState) => boolean) | undefined
  declare enable: ((state: GardState) => boolean) | undefined
  declare updateFor: ((tr: Transaction) => boolean) | undefined
  declare parent: MenuGroup | Submenu | undefined
  declare rank: number
  declare description: string | undefined
  label: MenuLabel | undefined
  defaultLabel: MenuLabel | undefined
  arrow: boolean
  width: number | undefined
  extension: GardState.Extension

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
  extension: GardState.Extension
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

export function toggleInlineMark(config: {
  mark: Mark<any>,
  parent?: MenuGroup | Submenu
  rank?: number
  description?: string
  label: MenuLabel
}) {
  let {mark, parent, rank, description, label} = config
  return new MenuButton({
    run: toggleMark.bind(mark),
    active(state) {
      let {selection} = state
      if (selection.empty)
        return !!mark.isInSet(selection.marks || state.sel.head.marks())
      else
        return !selection.ranges.some(r => canAddMarkInRange(state.doc, r.from, r.to, mark))
    },
    parent,
    rank,
    description,
    label
  })
}

export const ToggleStrong = toggleInlineMark({
  mark: Strong,
  parent: InlineStyles,
  rank: 10,
  description: "Toggle strong emphasis",
  label: iconBold
})

export const ToggleEmphasis = toggleInlineMark({
  mark: Emphasis,
  parent: InlineStyles,
  rank: 12,
  description: "Toggle emphasis",
  label: iconItalic
})

export const ToggleCode = toggleInlineMark({
  mark: Code,
  parent: InlineStyles,
  rank: 30,
  description: "Toggle code font",
  label: iconCode
})

export const ToggleUnderline = toggleInlineMark({
  mark: Underline,
  parent: InlineStyles,
  rank: 14,
  description: "Toggle underline",
  label: iconUnderline
})

export const ToggleSuperscript = toggleInlineMark({
  mark: Superscript,
  parent: InlineStyles,
  rank: 16,
  description: "Toggle superscript",
  label: iconSuperscript
})

export const ToggleSubscript = toggleInlineMark({
  mark: Subscript,
  parent: InlineStyles,
  rank: 18,
  description: "Toggle subscript",
  label: iconSubscript
})

export const ToggleLink = new MenuButton({
  run(view) {
    let {selection, doc} = view.state
    if (selection.empty) return false
    let remove: ChangeSet.Spec[] = []
    for (let {from, to} of selection.ranges) doc.iterate(from, to, (node, pos) => {
      let has = Link.isInSet(node.marks)
      if (has) remove.push({from: pos, to: pos + node.length, remove: has})
    })
    if (remove.length) {
      view.dispatch({changes: remove, userEvent: "mark.remove"})
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
          userEvent: "mark.add"
        })
      })
    }
    return true
  },
  active(state) {
    let {selection, doc} = state, found = false
    if (!selection.empty) for (let {from, to} of selection.ranges) doc.iterate(from, to, node => {
      if (found) return false
      if (Link.isInSet(node.marks)) found = true
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

function selectionInType(tag: Plot.Tag.Any) {
  return (state: GardState) => {
    let {sel} = state, block = sel.head.textblockParent
    return !!block && block.start == sel.anchor.textblockParent?.start && block.node.tag.eq(tag)
  }
}

export const ParagraphButton = new MenuButton({
  run: changeTextblockType.bind(Paragraph),
  active: selectionInType(Paragraph),
  label: "Paragraph",
  parent: TextblockStyle,
  rank: 10
})

export const CodeBlockButton = new MenuButton({
  run: changeTextblockType.bind(CodeBlock),
  active: selectionInType(CodeBlock),
  label: "Code block",
  parent: TextblockStyle,
  rank: 30
})

export const Heading1 = new MenuButton({
  run: changeTextblockType.bind(Heading.of(1)),
  active: selectionInType(Heading.of(1)),
  label: "Heading 1",
  parent: TextblockStyle,
  rank: 50
})

export const Heading2 = new MenuButton({
  run: changeTextblockType.bind(Heading.of(2)),
  active: selectionInType(Heading.of(2)),
  label: "Heading 2",
  parent: TextblockStyle,
  rank: 51
})

export const Heading3 = new MenuButton({
  run: changeTextblockType.bind(Heading.of(3)),
  active: selectionInType(Heading.of(3)),
  label: "Heading 3",
  parent: TextblockStyle,
  rank: 52
})

export const BulletListButton = new MenuButton({
  run: toggleList.bind(BulletList),
  active: listIsActive(BulletList),
  label: iconBulletList,
  description: "Toggle bullet list",
  parent: BlockMenu,
  rank: 20
})

export const OrderedListButton = new MenuButton({
  run: toggleList.bind(OrderedList.default!),
  active: listIsActive(OrderedList.default!),
  label: iconOrderedList,
  description: "Toggle ordered list",
  parent: BlockMenu,
  rank: 30
})

export const BlockquoteButton = new MenuButton({
  run: view => toggleBlock.bind(Blockquote),
  active: state => {
    for (let cur: Pos.Node | null = state.sel.head.parent; cur; cur = cur.parent)
      if (cur.node.type == Blockquote.type) return true
    return false
  },
  label: iconQuote,
  description: "Toggle blockquote",
  parent: BlockMenu,
  rank: 40
})

export const AlignmentMenu = new Submenu({
  description: "Alignment",
  parent: BlockMenu,
  arrow: false,
  rank: 10
})

function alignmentAtCursor(state: GardState): null | "end" | "center" {
  let block = state.sel.head.textblockParent
  return (block && block.node.tag.mark(Alignment)) || null
}

export const AlignStart = new MenuButton({
  run: setAlignment.bind(null),
  active: state => alignmentAtCursor(state) == null,
  label: iconAlignLeft,
  description: "Align text to block start",
  parent: AlignmentMenu,
  rank: 10
})

export const AlignEnd = new MenuButton({
  run: setAlignment.bind("end"),
  active: state => alignmentAtCursor(state) == "end",
  label: iconAlignRight,
  description: "Align text to block end",
  parent: AlignmentMenu,
  rank: 20
})

export const AlignCenter = new MenuButton({
  run: setAlignment.bind("center"),
  active: state => alignmentAtCursor(state) == "center",
  label: iconAlignCenter,
  description: "Center text",
  parent: AlignmentMenu,
  rank: 30
})

// FIXME drop
export const staticMenu: GardState.Extension[] = [
  Undo, Redo, Strong,
  Commands, InlineStyles, BlockMenu, ToggleStrong, ToggleEmphasis, ToggleCode, ToggleLink,
  TextblockStyle, ParagraphButton, CodeBlockButton, Heading1, Heading2, Heading3,
  AlignmentMenu, AlignStart, AlignEnd, AlignCenter,
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
