import {Wordgard, showDialog} from "wordgard/view"
import {Command, toggleMark, setTextblockType, toggleBlock, toggleList, listIsActive,
        canAddMarkInRange, setAlignment} from "wordgard/command"
import {GardState, Transaction, Facet, PhraseSet} from "wordgard/state"
import {Mark, Plot, Pos, ChangeSet} from "wordgard/doc"
import {Strong, Emphasis, Code, Link,
        Paragraph, CodeBlock, Heading, BulletList, OrderedList, Blockquote,
        Underline, Superscript, Subscript,
        Alignment} from "wordgard/schema"
import {icon} from "./icon"

export type MenuLabelWidget = {
  render: (view: Wordgard) => HTMLElement
  rerender?: (tr: Transaction) => boolean
  update?: (elt: HTMLElement, view: Wordgard) => void
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
  render: (view: Wordgard, done: () => void) => {dom: HTMLElement, focus?: HTMLElement}
  setEnabled: ((dom: Element, enabled: boolean) => void) | undefined
  extension: GardState.Extension

  constructor(spec: {
    render: (view: Wordgard, done: () => void) => {dom: HTMLElement, focus?: HTMLElement}
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
  extension: GardState.Extension

  constructor(spec: {
    label?: MenuLabel
    defaultLabel?: MenuLabel
    arrow?: boolean
    width?: number
  } & MenuItemSpec) {
    super(spec)
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
export const InlineStyles = new MenuGroup({parent: Top, rank: 30, margin: true})
export const BlockMenu = new MenuGroup({parent: Top, rank: 50, margin: true})

// FIXME split up, move out of here with the items
export const phrases = PhraseSet.define({
  block_style: "Block style",
  toggle_strong: "Toggle strong emphasis",
  toggle_em: "Toggle emphasis",
  toggle_code: "Toggle code font",
  toggle_underline: "Toggle underline",
  toggle_super: "Toggle superscript",
  toggle_sub: "Toggle subscript",
  create_link: "Create a link",
  undo: "Undo",
  redo: "Redo",
  paragraph: "Paragraph",
  code_block: "Code block",
  heading_1: "Heading 1",
  heading_2: "Heading 2",
  heading_3: "Heading 3",
  toggle_bullet_list: "Toggle bullet list",
  toggle_ordered_list: "Toggle ordered list",
  toggle_quote: "Toggle blockquote",
  alignment: "Alignment",
  align_start: "Align text to block start",
  align_end: "Align text to block end",
  align_center: "Center text",
})

export function toggleInlineMark(config: {
  mark: Mark<any>,
  parent?: MenuGroup | Submenu
  rank?: number
  description?: PhraseSet.Ref
  label: MenuLabel
}) {
  let {mark, parent, rank, description, label} = config
  return new MenuButton({
    run: Command.bind(toggleMark, mark),
    active(state) {
      let {selection} = state
      if (selection.isCursor)
        return !!mark.isInSet(state.sel.activeMarks)
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
  description: phrases.ref("toggle_strong"),
  label: icon.Bold
})

export const ToggleEmphasis = toggleInlineMark({
  mark: Emphasis,
  parent: InlineStyles,
  rank: 12,
  description: phrases.ref("toggle_em"),
  label: icon.Italic
})

export const ToggleCode = toggleInlineMark({
  mark: Code,
  parent: InlineStyles,
  rank: 30,
  description: phrases.ref("toggle_code"),
  label: icon.Code
})

export const ToggleUnderline = toggleInlineMark({
  mark: Underline,
  parent: InlineStyles,
  rank: 14,
  description: phrases.ref("toggle_underline"),
  label: icon.Underline
})

export const ToggleSuperscript = toggleInlineMark({
  mark: Superscript,
  parent: InlineStyles,
  rank: 16,
  description: phrases.ref("toggle_super"),
  label: icon.Superscript
})

export const ToggleSubscript = toggleInlineMark({
  mark: Subscript,
  parent: InlineStyles,
  rank: 18,
  description: phrases.ref("toggle_sub"),
  label: icon.Subscript
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
  label: icon.Link,
  description: phrases.ref("create_link"),
  parent: InlineStyles,
  rank: 50,
})

// FIXME wire up actual undo/redo commands

export const Undo = new MenuButton({
  run: () => { console.log("undo"); return true },
  label: icon.Undo,
  description: phrases.ref("undo"),
  parent: Commands,
  rank: 10
})

export const Redo = new MenuButton({
  run: () => { console.log("redo"); return true },
  label: icon.Redo,
  description: phrases.ref("redo"),
  parent: Commands,
  rank: 20
})

export const TextblockStyle = new Submenu({
  defaultLabel: phrases.ref("block_style"),
  description: phrases.ref("block_style"),
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
  run: Command.bind(setTextblockType, Paragraph),
  active: selectionInType(Paragraph),
  label: phrases.ref("paragraph"),
  parent: TextblockStyle,
  rank: 10
})

export const CodeBlockButton = new MenuButton({
  run: Command.bind(setTextblockType, CodeBlock),
  active: selectionInType(CodeBlock),
  label: phrases.ref("code_block"),
  parent: TextblockStyle,
  rank: 30
})

export const Heading1 = new MenuButton({
  run: Command.bind(setTextblockType, Heading.of(1)),
  active: selectionInType(Heading.of(1)),
  label: phrases.ref("heading_1"),
  parent: TextblockStyle,
  rank: 50
})

export const Heading2 = new MenuButton({
  run: Command.bind(setTextblockType, Heading.of(2)),
  active: selectionInType(Heading.of(2)),
  label: phrases.ref("heading_2"),
  parent: TextblockStyle,
  rank: 51
})

export const Heading3 = new MenuButton({
  run: Command.bind(setTextblockType, Heading.of(3)),
  active: selectionInType(Heading.of(3)),
  label: phrases.ref("heading_3"),
  parent: TextblockStyle,
  rank: 52
})

export const BulletListButton = new MenuButton({
  run: Command.bind(toggleList, BulletList),
  active: listIsActive(BulletList),
  label: icon.BulletList,
  description: phrases.ref("toggle_bullet_list"),
  parent: BlockMenu,
  rank: 20
})

export const OrderedListButton = new MenuButton({
  run: Command.bind(toggleList, OrderedList.default!),
  active: listIsActive(OrderedList.default!),
  label: icon.OrderedList,
  description: phrases.ref("toggle_ordered_list"),
  parent: BlockMenu,
  rank: 30
})

export const BlockquoteButton = new MenuButton({
  run: Command.bind(toggleBlock, Blockquote),
  active: state => {
    for (let cur: Pos.Node | null = state.sel.head.parent; cur; cur = cur.parent)
      if (cur.node.type == Blockquote.type) return true
    return false
  },
  label: icon.Quote,
  description: phrases.ref("toggle_quote"),
  parent: BlockMenu,
  rank: 40
})

export const AlignmentMenu = new Submenu({
  description: phrases.ref("alignment"),
  parent: BlockMenu,
  arrow: false,
  rank: 10
})

function alignmentAtCursor(state: GardState): null | "end" | "center" {
  let block = state.sel.head.textblockParent
  return (block && block.node.tag.mark(Alignment)) || null
}

export const AlignStart = new MenuButton({
  run: Command.bind(setAlignment, null),
  active: state => alignmentAtCursor(state) == null,
  label: icon.AlignLeft,
  description: phrases.ref("align_start"),
  parent: AlignmentMenu,
  rank: 10
})

export const AlignEnd = new MenuButton({
  run: Command.bind(setAlignment, "end"),
  active: state => alignmentAtCursor(state) == "end",
  label: icon.AlignRight,
  description: phrases.ref("align_end"),
  parent: AlignmentMenu,
  rank: 20
})

export const AlignCenter = new MenuButton({
  run: Command.bind(setAlignment, "center"),
  active: state => alignmentAtCursor(state) == "center",
  label: icon.AlignCenter,
  description: phrases.ref("align_center"),
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
