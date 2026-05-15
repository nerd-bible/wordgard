import {PhraseSet} from "wordgard/state"

/// The phrase set for the core packages. You can translate this to
/// internationalize the menus and dialogs created by those packages.
export const phrases = PhraseSet.define({
  dialog_close: "close",

  // Menu labels
  block_style: "Block style",
  toggle_strong: "Toggle strong emphasis",
  toggle_em: "Toggle emphasis",
  toggle_code: "Toggle code font",
  toggle_underline: "Toggle underline",
  toggle_super: "Toggle superscript",
  toggle_sub: "Toggle subscript",
  create_link: "Create a link",
  text_color: "Text color",
  background_color: "Background color",
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
