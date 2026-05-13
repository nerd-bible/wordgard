import {MenuButton, Top, MenuGroup, Submenu, MenuLabel, icon} from "wordgard/menu"
import {Mark} from "wordgard/doc"
import {PhraseSet, GardState} from "wordgard/state"
import {Command, toggleMark, canAddMarkInRange} from "wordgard/command"
import {Strong, Emphasis, Code, Underline, Superscript, Subscript} from "wordgard/schema"
import {phrases} from "wordgard/phrases"
import {KeyBinding} from "wordgard/view"

export const inlineStyleMenu = new MenuGroup({parent: Top, rank: 30, margin: true})

export function strong(): GardState.Extension {
  return [Strong, strong.button, inlineStyleMenu, strong.keyBinding]
}

export namespace strong {
  export const keyBinding = KeyBinding.define({
    key: "Mod-b",
    run: Command.bind(toggleMark, Strong),
  })

  export const button = toggleInlineMarkButton({
    mark: Strong,
    parent: inlineStyleMenu,
    rank: 10,
    description: phrases.ref("toggle_strong"),
    label: icon.Bold
  })
}

export function emphasis(): GardState.Extension {
  return [Emphasis, emphasis.button, inlineStyleMenu, emphasis.keyBinding]
}

export namespace emphasis {
  export const keyBinding = KeyBinding.define({
    key: "Mod-i",
    run: Command.bind(toggleMark, Emphasis),
  })

  export const button = toggleInlineMarkButton({
    mark: Emphasis,
    parent: inlineStyleMenu,
    rank: 12,
    description: phrases.ref("toggle_em"),
    label: icon.Italic
  })
}

export function code(): GardState.Extension {
  return [Code, code.button, inlineStyleMenu, code.keyBinding]
}

export namespace code {
  export const keyBinding = KeyBinding.define({
    key: "Mod-`",
    run: Command.bind(toggleMark, Code),
  })

  export const button = toggleInlineMarkButton({
    mark: Code,
    parent: inlineStyleMenu,
    rank: 30,
    description: phrases.ref("toggle_code"),
    label: icon.Code
  })
}

export function underline(): GardState.Extension {
  return [Underline, underline.button, inlineStyleMenu, underline.keyBinding]
}

export namespace underline {
  export const keyBinding = KeyBinding.define({
    key: "Mod-u",
    run: Command.bind(toggleMark, Underline),
    allowDefault: false
  })

  export const button = toggleInlineMarkButton({
    mark: Underline,
    parent: inlineStyleMenu,
    rank: 14,
    description: phrases.ref("toggle_underline"),
    label: icon.Underline
  })
}

export function superscript(): GardState.Extension {
  return [Superscript, superscript.button, inlineStyleMenu, superscript.keyBinding]
}

export namespace superscript {
  export const keyBinding = KeyBinding.define({
    key: "Mod-.",
    run: Command.bind(toggleMark, Superscript),
  })

  export const button = toggleInlineMarkButton({
    mark: Superscript,
    parent: inlineStyleMenu,
    rank: 16,
    description: phrases.ref("toggle_super"),
    label: icon.Superscript
  })
}

export function subscript(): GardState.Extension {
  return [Subscript, subscript.button, inlineStyleMenu, subscript.keyBinding]
}

export namespace subscript {
  export const keyBinding = KeyBinding.define({
    key: "Mod-,",
    run: Command.bind(toggleMark, Subscript),
  })

  export const button = toggleInlineMarkButton({
    mark: Subscript,
    parent: inlineStyleMenu,
    rank: 18,
    description: phrases.ref("toggle_sub"),
    label: icon.Subscript
  })
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
