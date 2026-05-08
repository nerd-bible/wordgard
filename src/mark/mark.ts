import {MenuButton, InlineStyles, MenuGroup, Submenu, MenuLabel, icon} from "wordgard/menu"
import {Mark, ChangeSet} from "wordgard/doc"
import {PhraseSet, GardState, Transaction} from "wordgard/state"
import {Command, toggleMark, canAddMarkInRange} from "wordgard/command"
import {Strong, Emphasis, Code, Link, Underline, Superscript, Subscript} from "wordgard/schema"
import {phrases} from "wordgard/phrases"
import {Wordgard, showDialog, KeyBinding, Tooltip} from "wordgard/view"

export function strong(): GardState.Extension {
  return [Strong, strong.button, strong.keyBinding]
}

export namespace strong {
  export const keyBinding = KeyBinding.define({
    key: "Mod-b",
    run: Command.bind(toggleMark, Strong),
  })

  export const button = toggleInlineMarkButton({
    mark: Strong,
    parent: InlineStyles,
    rank: 10,
    description: phrases.ref("toggle_strong"),
    label: icon.Bold
  })
}

export function emphasis(): GardState.Extension {
  return [Emphasis, emphasis.button, emphasis.keyBinding]
}

export namespace emphasis {
  export const keyBinding = KeyBinding.define({
    key: "Mod-i",
    run: Command.bind(toggleMark, Emphasis),
  })

  export const button = toggleInlineMarkButton({
    mark: Emphasis,
    parent: InlineStyles,
    rank: 12,
    description: phrases.ref("toggle_em"),
    label: icon.Italic
  })
}

export function code(): GardState.Extension {
  return [Code, code.button, code.keyBinding]
}

export namespace code {
  export const keyBinding = KeyBinding.define({
    key: "Mod-`",
    run: Command.bind(toggleMark, Code),
  })

  export const button = toggleInlineMarkButton({
    mark: Code,
    parent: InlineStyles,
    rank: 30,
    description: phrases.ref("toggle_code"),
    label: icon.Code
  })
}

export function underline(): GardState.Extension {
  return [Underline, underline.button, underline.keyBinding]
}

export namespace underline {
  export const keyBinding = KeyBinding.define({
    key: "Mod-u",
    run: Command.bind(toggleMark, Underline),
    allowDefault: false
  })

  export const button = toggleInlineMarkButton({
    mark: Underline,
    parent: InlineStyles,
    rank: 14,
    description: phrases.ref("toggle_underline"),
    label: icon.Underline
  })
}

export function superscript(): GardState.Extension {
  return [Superscript, superscript.button, superscript.keyBinding]
}

export namespace superscript {
  export const keyBinding = KeyBinding.define({
    key: "Mod-.",
    run: Command.bind(toggleMark, Superscript),
  })

  export const button = toggleInlineMarkButton({
    mark: Superscript,
    parent: InlineStyles,
    rank: 16,
    description: phrases.ref("toggle_super"),
    label: icon.Superscript
  })
}

export function subscript(): GardState.Extension {
  return [Subscript, subscript.button, subscript.keyBinding]
}

export namespace subscript {
  export const keyBinding = KeyBinding.define({
    key: "Mod-,",
    run: Command.bind(toggleMark, Subscript),
  })

  export const button = toggleInlineMarkButton({
    mark: Subscript,
    parent: InlineStyles,
    rank: 18,
    description: phrases.ref("toggle_sub"),
    label: icon.Subscript
  })
}

function createLink(view: Wordgard) {
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
}

function computeLinkTooltip(state: GardState): Tooltip | null {
  if (!state.selection.isCursor) return null
  let {head} = state.sel, before = head.nodeBefore, link = before && Link.isInSet(before.marks)
  if (!link) return null
  let start = head.pos - before!.length, end = head.pos, siblings = head.parent.node.content
  for (let index = head.index - 1; index > 0 && link.isInSet(siblings[index - 1].marks);)
    start -= siblings[--index].length
  for (let index = head.index; index < siblings.length && link.isInSet(siblings[index].marks);)
    end += siblings[index++].length
  return {
    pos: start,
    end,
    above: false,
    create: () => renderLinkTooltip(link.value)
  }
}

const closeLinkTooltip = Transaction.Effect.define<null>()
  
const linkTooltipField = GardState.Field.define<Tooltip | null>({
  create: computeLinkTooltip,
  update(value, tr) {
    if (tr.effects.some(e => e.is(closeLinkTooltip))) return null
    let sel = tr.selection
    if (!tr.docChanged && (!sel || value && sel.isCursor && sel.head >= value.pos && sel.head <= value.end!)) return value
    return computeLinkTooltip(tr.state)
  },
  provide: f => Tooltip.show.from(f)
})

function renderLinkTooltip(target: string) {
  let dom = document.createElement("wg-link-tooltip")
  let link = dom.appendChild(document.createElement("a"))
  link.href = target
  link.textContent = target
  return {dom}
}

const linkTooltipTheme = Wordgard.baseTheme({
  "wg-link-tooltip": {
    maxWidth: "30em",
    fontSize: "80%",
    textOverflow: "ellipsis",
    whiteSpace: "pre",
    overflow: "hidden",
    borderRadius: "3px",
    padding: "2px 5px",
    marginTop: "2px",
    "& a": {
      textDecoration: "none",
    }
  }
})

export function link(): GardState.Extension {
  return [Link, link.button, link.keyBinding, link.tooltip]
}

export namespace link {
  export const keyBinding = KeyBinding.define({
    key: "Mod-k",
    run: createLink,
  })

  export const button = new MenuButton({
    run: createLink,
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

  export const tooltip: GardState.Extension = [
    linkTooltipField,
    GardState.prec.low(KeyBinding.define({
      key: "Escape",
      run: view => {
        if (!view.state.field(linkTooltipField)) return false
        view.dispatch({effects: closeLinkTooltip.of(null)})
        return true
      }
    })),
    linkTooltipTheme
  ]
}

/// Creates a menu button that toggles an inline mark via {@link
/// toggleMark}, and is shown as active when either that mark is part
/// of the marks associated with the current cursor, or the selection
/// covers only content with that mark.
export function toggleInlineMarkButton(config: {
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
