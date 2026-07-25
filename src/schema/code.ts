import {GardState} from "wordgard/state"
import {CodeBlock} from "wordgard/types"
import {phrases} from "wordgard/phrases"
import {Command, Menu, setTextblockType} from "wordgard/command"
import {KeyBinding, InputRule} from "wordgard/editor"
import {selectionInType} from "./block"

/// Extensions to add support for code blocks. Includes the {@link
/// CodeBlock schema element}, a {@link codeBlock.keyBinding key
/// binding}, a {@link codeBlock.button menu button}, and an {@link
/// codeBlock.createOnBackticks input rule}.
export function codeBlock(): GardState.Extension {
  return [GardState.schemaElement.of(CodeBlock),
          codeBlock.button, codeBlock.keyBinding, codeBlock.createOnBackticks]
}

export namespace codeBlock {
  /// Binds `Ctrl-Shift-\` to switch the selected textblocks to a code
  /// block.
  export const keyBinding = KeyBinding.of({
    key: "Ctrl-Shift-\\",
    run: Command.bind(setTextblockType, CodeBlock)
  })

  /// Button for the {@link Menu.Submenu.textblockStyle textblock
  /// style} menu that switches to a code block.
  export const button = Menu.Button.define({
    run: Command.bind(setTextblockType, CodeBlock),
    active: selectionInType(CodeBlock),
    label: phrases.ref("code_block"),
    enable: s => !s.readOnly,
    parent: Menu.Submenu.textblockStyle,
    rank: 30
  })

  /// Input rule that switches the current textblock to a code block
  /// when you type three backticks at its start.
  export const createOnBackticks = InputRule.textblockType(/^```$/, CodeBlock)
}

