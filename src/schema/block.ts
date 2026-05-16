import {Plot, Pos, ChangeSet} from "wordgard/doc"
import {GardState, GardSelection} from "wordgard/state"
import {Doc, Paragraph, Heading, CodeBlock, Blockquote, Alignment, HorizontalRule} from "wordgard/schema-def"
import {phrases} from "wordgard/phrases"
import {MenuButton, Submenu, TextblockStyle, BlockMenu, icon} from "wordgard/menu"
import {Command, setTextblockType, setAlignment, toggleBlock} from "wordgard/command"
import {history} from "wordgard/history"
import {KeyBinding} from "wordgard/editor"
import {InputRule} from "wordgard/inputrule"

export function blockDoc(): GardState.Extension {
  return Doc
}

function selectionInType(tag: Plot.Tag.Any) {
  return (state: GardState) => {
    let {sel} = state, block = sel.head.textblockParent
    return !!block && block.start == sel.anchor.textblockParent?.start && block.node.tag.eq(tag)
  }
}

export function paragraph(): GardState.Extension {
  return [Paragraph, paragraph.button, paragraph.keyBinding]
}

export namespace paragraph {
  export const keyBinding = KeyBinding.define({
    key: "Ctrl-Shift-0",
    run: Command.bind(setTextblockType, Paragraph)
  })

  export const button = new MenuButton({
    run: Command.bind(setTextblockType, Paragraph),
    active: selectionInType(Paragraph),
    label: phrases.ref("paragraph"),
    parent: TextblockStyle,
    rank: 10
  })
}

export function heading(): GardState.Extension {
  return [Heading, heading.button1, heading.button2, heading.button3, heading.keyBindings, heading.createOnHash]
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

  export const button1 = new MenuButton({
    run: Command.bind(setTextblockType, Heading.of(1)),
    active: selectionInType(Heading.of(1)),
    label: phrases.ref("heading_1"),
    parent: TextblockStyle,
    rank: 50
  })

  export const button2 = new MenuButton({
    run: Command.bind(setTextblockType, Heading.of(2)),
    active: selectionInType(Heading.of(2)),
    label: phrases.ref("heading_2"),
    parent: TextblockStyle,
    rank: 51
  })

  export const button3 = new MenuButton({
    run: Command.bind(setTextblockType, Heading.of(3)),
    active: selectionInType(Heading.of(3)),
    label: phrases.ref("heading_3"),
    parent: TextblockStyle,
    rank: 52
  })

  export const createOnHash = InputRule.textblockType(/^(#{1,6}) $/, m => Heading.of(m[1]!.to.pos - m[1]!.from.pos))
}

export function codeBlock(): GardState.Extension {
  return [CodeBlock, codeBlock.button, codeBlock.keyBinding, codeBlock.createOnBackticks]
}

export namespace codeBlock {
  export const keyBinding = KeyBinding.define({
    key: "Ctrl-Shift-\\",
    run: Command.bind(setTextblockType, CodeBlock)
  })

  export const button = new MenuButton({
    run: Command.bind(setTextblockType, CodeBlock),
    active: selectionInType(CodeBlock),
    label: phrases.ref("code_block"),
    parent: TextblockStyle,
    rank: 30
  })

  export const createOnBackticks = InputRule.textblockType(/^```$/, CodeBlock)
}

export function alignment(): GardState.Extension {
  return [
    Alignment,
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

  export const button = new Submenu({
    description: phrases.ref("alignment"),
    parent: BlockMenu,
    arrow: false,
    rank: 10
  })

  export const buttonStart = new MenuButton({
    run: Command.bind(setAlignment, null),
    active: state => alignmentAtCursor(state) == null,
    label: icon.AlignLeft,
    description: phrases.ref("align_start"),
    parent: button,
    rank: 10
  })

  export const buttonEnd = new MenuButton({
    run: Command.bind(setAlignment, "end"),
    active: state => alignmentAtCursor(state) == "end",
    label: icon.AlignRight,
    description: phrases.ref("align_end"),
    parent: button,
    rank: 20
  })

  export const buttonCenter = new MenuButton({
    run: Command.bind(setAlignment, "center"),
    active: state => alignmentAtCursor(state) == "center",
    label: icon.AlignCenter,
    description: phrases.ref("align_center"),
    parent: button,
    rank: 30
  })
}

export function blockquote(): GardState.Extension {
  return [Blockquote, blockquote.button, blockquote.createOnGT]
}

export namespace blockquote {
  export const button = new MenuButton({
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

  export const createOnGT = InputRule.wrapping(/^> $/, Blockquote)
}

export function horizontalRule(): GardState.Extension {
  return [HorizontalRule, horizontalRule.createOnDashes]
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
