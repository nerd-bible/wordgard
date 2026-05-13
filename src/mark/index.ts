import {GardState} from "wordgard/state"

import {strong, emphasis, code, underline, superscript, subscript} from "./mark"
import {color, backgroundColor} from "./color"
import {link} from "./link"

export {toggleInlineMarkButton, inlineStyleGroup, strong, emphasis, code,
        underline, superscript, subscript} from "./mark"
export {color, backgroundColor, ColorPicker} from "./color"
export {link} from "./link"

export function basicMarks(): GardState.Extension {
  return [strong(), emphasis(), code(), link()]
}

export function allMarks(): GardState.Extension {
  return [basicMarks(), underline(), superscript(), subscript(), color(), backgroundColor()]
}
