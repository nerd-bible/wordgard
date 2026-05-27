import {Plot, Leaf, Pos, ChangeSet} from "wordgard/doc"
import {GardState, GardSelection, BidiSpan} from "wordgard/state"
import {Doc, Paragraph, Heading, CodeBlock, Blockquote, Alignment, Direction, HorizontalRule} from "wordgard/schema-def"
import {phrases} from "wordgard/phrases"
import {Command, Menu, setTextblockType, setAlignment, setDirection, toggleBlock} from "wordgard/command"
import {history} from "wordgard/history"
import {Wordgard, KeyBinding, InputRule} from "wordgard/editor"

export function blockDoc(): GardState.Extension {
  return GardState.schemaElement.of(Doc)
}

function selectionInType(tag: Plot.Tag.Any) {
  return (state: GardState) => {
    let {sel} = state, block = sel.head.textblockParent
    return !!block && block.start == sel.anchor.textblockParent?.start && block.node.tag.eq(tag)
  }
}

export function paragraph(): GardState.Extension {
  return [GardState.schemaElement.of(Paragraph), paragraph.button, paragraph.keyBinding]
}

export namespace paragraph {
  export const keyBinding = KeyBinding.define({
    key: "Ctrl-Shift-0",
    run: Command.bind(setTextblockType, Paragraph)
  })

  export const button = Menu.Button.define({
    run: Command.bind(setTextblockType, Paragraph),
    active: selectionInType(Paragraph),
    label: phrases.ref("paragraph"),
    parent: Menu.Submenu.textblockStyle,
    rank: 10
  })
}

export function heading(): GardState.Extension {
  return [GardState.schemaElement.of(Heading),
          heading.button1, heading.button2, heading.button3,
          heading.keyBindings, heading.createOnHash]
}

export namespace heading {
  export const keyBindings = [
    KeyBinding.define({key: "Ctrl-Shift-1", run: Command.bind(setTextblockType, Heading.of(1))}),
    KeyBinding.define({key: "Ctrl-Shift-2", run: Command.bind(setTextblockType, Heading.of(2))}),
    KeyBinding.define({key: "Ctrl-Shift-3", run: Command.bind(setTextblockType, Heading.of(3))}),
    KeyBinding.define({key: "Ctrl-Shift-4", run: Command.bind(setTextblockType, Heading.of(4))}),
    KeyBinding.define({key: "Ctrl-Shift-5", run: Command.bind(setTextblockType, Heading.of(5))}),
    KeyBinding.define({key: "Ctrl-Shift-6", run: Command.bind(setTextblockType, Heading.of(6))})
  ]

  export const button1 = Menu.Button.define({
    run: Command.bind(setTextblockType, Heading.of(1)),
    active: selectionInType(Heading.of(1)),
    label: phrases.ref("heading_1"),
    parent: Menu.Submenu.textblockStyle,
    rank: 50
  })

  export const button2 = Menu.Button.define({
    run: Command.bind(setTextblockType, Heading.of(2)),
    active: selectionInType(Heading.of(2)),
    label: phrases.ref("heading_2"),
    parent: Menu.Submenu.textblockStyle,
    rank: 51
  })

  export const button3 = Menu.Button.define({
    run: Command.bind(setTextblockType, Heading.of(3)),
    active: selectionInType(Heading.of(3)),
    label: phrases.ref("heading_3"),
    parent: Menu.Submenu.textblockStyle,
    rank: 52
  })

  export const createOnHash = InputRule.textblockType(/^(#{1,6}) $/, m => Heading.of(m[1]!.to.pos - m[1]!.from.pos))
}

export function codeBlock(): GardState.Extension {
  return [GardState.schemaElement.of(CodeBlock),
          codeBlock.button, codeBlock.keyBinding, codeBlock.createOnBackticks]
}

export namespace codeBlock {
  export const keyBinding = KeyBinding.define({
    key: "Ctrl-Shift-\\",
    run: Command.bind(setTextblockType, CodeBlock)
  })

  export const button = Menu.Button.define({
    run: Command.bind(setTextblockType, CodeBlock),
    active: selectionInType(CodeBlock),
    label: phrases.ref("code_block"),
    parent: Menu.Submenu.textblockStyle,
    rank: 30
  })

  export const createOnBackticks = InputRule.textblockType(/^```$/, CodeBlock)
}

export function alignment(): GardState.Extension {
  return [
    GardState.schemaElement.of(Alignment),
    alignment.button, alignment.buttonStart, alignment.buttonEnd, alignment.buttonCenter,
    alignment.keyBindings
  ]
}

function alignmentAtCursor(state: GardState): null | "end" | "center" {
  let block = state.sel.head.textblockParent
  return (block && block.node.tag.mark(Alignment)) || null
}

export namespace alignment {
  export const keyBindings = [
    KeyBinding.define({key: "Mod-Shift-l", run: Command.bind(setAlignment, "left")}),
    KeyBinding.define({key: "Mod-Shift-r", run: Command.bind(setAlignment, "right")}),
    KeyBinding.define({key: "Mod-Shift-e", run: Command.bind(setAlignment, "center")})
  ]

  export const button = Menu.Submenu.define({
    description: phrases.ref("alignment"),
    parent: Menu.Group.block,
    arrow: false,
    rank: 10
  })

  export const buttonStart = Menu.Button.define({
    run: Command.bind(setAlignment, null),
    active: state => alignmentAtCursor(state) == null,
    label: {
      icon: "M16 81a3 3 0 0 1 0-6h44a3 3 0 0 1 0 6h-44m0-19a3 3 0 0 1 0-6h69a3 3 0 0 1 0 6h-69m0-19a3 3 0 0 1 0-6h44a3 3 0 0 1 0 6h-44m0-19a3 3 0 0 1 0-6h69a3 3 0 0 1 0 6h-69",
      directional: true
    },
    description: phrases.ref("align_start"),
    parent: button,
    rank: 10
  })

  export const buttonEnd = Menu.Button.define({
    run: Command.bind(setAlignment, "end"),
    active: state => alignmentAtCursor(state) == "end",
    label: {
      icon: "M41 81a3 3 0 0 1 0-6h44a3 3 0 0 1 0 6h-44m-25-19a3 3 0 0 1 0-6h69a3 3 0 0 1 0 6h-69m25-19a3 3 0 0 1 0-6h44a3 3 0 0 1 0 6h-44m-25-19a3 3 0 0 1 0-6h69a3 3 0 0 1 0 6h-69",
      directional: true
    },
    description: phrases.ref("align_end"),
    parent: button,
    rank: 20
  })

  export const buttonCenter = Menu.Button.define({
    run: Command.bind(setAlignment, "center"),
    active: state => alignmentAtCursor(state) == "center",
    label: {
      icon: "M29 81a3 3 0 0 1 0-6h44a3 3 0 0 1 0 6h-44m-13-19a3 3 0 0 1 0-6h69a3 3 0 0 1 0 6h-69m13-19a3 3 0 0 1 0-6h44a3 3 0 0 1 0 6h-44m-13-19a3 3 0 0 1 0-6h69a3 3 0 0 1 0 6h-69"
    },
    description: phrases.ref("align_center"),
    parent: button,
    rank: 30
  })
}

export function direction(): GardState.Extension {
  return [GardState.schemaElement.of(Direction),
          direction.textblockDir, direction.button, direction.buttonLTR, direction.buttonRTL, direction.buttonAuto]
}

function autoDir(plot: Plot) {
  for (let ch of plot.content) if (ch.is(Leaf.Text)) {
    for (let i = 0; i < ch.param.length; i++) {
      let dir = BidiSpan.strongDir(ch.param.charCodeAt(i))
      if (dir != null) return dir
    }
  }
  return null
}

function directionAtCursor(state: GardState): "ltr" | "rtl" | "auto" {
  let block = state.sel.head.textblockParent
  return (block && block.node.mark(Direction)) || (state.textLTR ? "ltr" : "rtl")
}

export namespace direction {
  export const textblockDir = GardState.textblockLTR.of(plot => {
    let dir = plot.mark(Direction)
    return !dir ? null : dir == "auto" ? autoDir(plot) : dir == "ltr"
  })

  export const button = Menu.Submenu.define({
    description: phrases.ref("text_dir"),
    parent: Menu.Group.block,
    arrow: false,
    rank: 20
  })

  export const buttonLTR = Menu.Button.define({
    run: Command.bind(setDirection, "ltr"),
    active: state => directionAtCursor(state) == "ltr",
    label: {
      icon: "M70 35l20 15l-20 15l0-30M45 83v-63h-5v63a3 3 0 0 1-6 0v-28h-4a20 20 0 1 1 0-40h28a3 3 0 0 1 0 6h-7v62a3 3 0 0 1-6 0"
    },
    description: phrases.ref("text_dir_ltr"),
    parent: button,
    rank: 10
  })

  export const buttonRTL = Menu.Button.define({
    run: Command.bind(setDirection, "rtl"),
    active: state => directionAtCursor(state) == "rtl",
    label: {
      icon: "M30 35l-20 15l20 15l0-30M75 83v-63h-5v63a3 3 0 0 1-6 0v-28h-4a20 20 0 1 1 0-40h28a3 3 0 0 1 0 6h-7v62a3 3 0 0 1-6 0"
    },
    description: phrases.ref("text_dir_rtl"),
    parent: button,
    rank: 20
  })

  export const buttonAuto = Menu.Button.define({
    run: Command.bind(setDirection, "auto"),
    active: state => directionAtCursor(state) == "auto",
    label: {
      icon: "M35 30l-23 20l23 20l0-40M60 30l23 20l-23 20l0-40"
    },
    description: phrases.ref("text_dir_auto"),
    parent: button,
    rank: 30
  })
}

export function blockquote(): GardState.Extension {
  return [GardState.schemaElement.of(Blockquote), blockquote.button, blockquote.createOnGT, blockquote.theme]
}

export namespace blockquote {
  export const button = Menu.Button.define({
    run: Command.bind(toggleBlock, Blockquote),
    active: state => {
      for (let cur: Pos.Node | null = state.sel.head.parent; cur; cur = cur.parent)
        if (cur.node.type == Blockquote.type) return true
      return false
    },
    label: {
      icon: "M75 75a6 6 0 0 0 6-6V53a6 6 0 0 0-6-6h-9q0-3 0-7 1-3 2-6t3-4q2-2 5-2V19q-5 0-9 2a21 21 0 0 0-7 6 31 31 0 0 0-4 9A48 48 0 0 0 56 47V69a5 5 0 0 0 6 6zm-37 0a6 6 0 0 0 6-6V53a6 6 0 0 0-6-6H29q0-3 0-7 1-3 2-6 1-3 3-4 2-2 5-2V19q-5 0-9 2a21 21 0 0 0-7 6 31 31 0 0 0-4 9A48 48 0 0 0 19 47V69a6 6 0 0 0 6 6z"
    },
    description: phrases.ref("toggle_quote"),
    parent: Menu.Group.block,
    rank: 40
  })

  export const createOnGT = InputRule.wrapping(/^> $/, Blockquote)

  export const theme = Wordgard.theme({
    blockquote: {
      marginInline: "3px",
      paddingInlineStart: "12px",
      borderInlineStart: "4px solid silver"
    }
  })
}

export function horizontalRule(): GardState.Extension {
  return [GardState.schemaElement.of(HorizontalRule), horizontalRule.createOnDashes]
}

export namespace horizontalRule {
  export const createOnDashes = InputRule.define({
    expr: /^---$/,
    lookahead: /^$/,
    apply: (wg, m) => {
      let changes = ChangeSet.create(wg.state.doc, {
        from: m[0].from.pos, to: m[0].to.pos,
        insert: [HorizontalRule],
        fit: true
      })
      let hr = changes.findInserted(t => t == HorizontalRule)
      if (hr == null) return false
      wg.dispatch({
        changes,
        selection: cx => GardSelection.near(cx, hr + 1, 1),
        annotations: history.isolate.of("full"),
        userEvent: "insert.horizontalrule"
      })
      return true
    }
  })
}
