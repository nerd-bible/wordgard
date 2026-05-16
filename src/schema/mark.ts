import {icon} from "wordgard/menu"
import {GardState} from "wordgard/state"
import {Command, Menu, toggleMark} from "wordgard/command"
import {Strong, Emphasis, Code, Underline, Superscript, Subscript} from "wordgard/schema-def"
import {phrases} from "wordgard/phrases"
import {KeyBinding} from "wordgard/editor"

export function strong(): GardState.Extension {
  return [Strong, strong.button, Menu.Group.inlineStyle, strong.keyBinding]
}

export namespace strong {
  export const keyBinding = KeyBinding.define({
    key: "Mod-b",
    run: Command.bind(toggleMark, Strong),
  })

  export const button = Menu.Button.toggleMark({
    mark: Strong,
    parent: Menu.Group.inlineStyle,
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

  export const button = Menu.Button.toggleMark({
    mark: Emphasis,
    parent: Menu.Group.inlineStyle,
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

  export const button = Menu.Button.toggleMark({
    mark: Code,
    parent: Menu.Group.inlineStyle,
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

  export const button = Menu.Button.toggleMark({
    mark: Underline,
    parent: Menu.Group.inlineStyle,
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

  export const button = Menu.Button.toggleMark({
    mark: Superscript,
    parent: Menu.Group.inlineStyle,
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

  export const button = Menu.Button.toggleMark({
    mark: Subscript,
    parent: Menu.Group.inlineStyle,
    rank: 18,
    description: phrases.ref("toggle_sub"),
    label: icon.Subscript
  })
}
