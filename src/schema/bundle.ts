import {GardState} from "wordgard/state"
import {LineBreak} from "wordgard/schema-def"

import {strong, emphasis, code, underline, strikethrough, superscript, subscript} from "./mark"
import {blockDoc, inlineDoc, paragraph, heading, codeBlock, alignment, direction, blockquote, horizontalRule} from "./block"
import {bulletList, orderedList} from "./list"
import {image, figure, imageResizing} from "./image"
import {color, backgroundColor} from "./color"
import {link} from "./link"

export function lineBreak(): GardState.Extension {
  return GardState.schemaElement.of(LineBreak)
}

export function basicMarks(): GardState.Extension {
  return [strong(), emphasis(), code(), link()]
}

export function allMarks(): GardState.Extension {
  return [basicMarks(), underline(), strikethrough(), superscript(), subscript(), color(), backgroundColor()]
}

export function basicSchema(): GardState.Extension {
  return [blockDoc(), basicMarks(), paragraph(), heading(), lineBreak()]
}

export function inlineSchema(): GardState.Extension {
  return [inlineDoc(), basicMarks(), image(), lineBreak()]
}

export function fullSchema(): GardState.Extension {
  return [
    basicSchema(), codeBlock(), alignment(), direction(), blockquote(), horizontalRule(),
    bulletList(), orderedList(),
    image(), figure(), imageResizing(),
    underline(), strikethrough(), superscript(), subscript(), color(), backgroundColor()
  ]
}
