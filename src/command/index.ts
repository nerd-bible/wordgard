/// This module exports abstractions to represent editor commands,
/// which represent user actions, as well as a collection of commands
/// and supporting functions.
///
/// ### Command Abstraction
///
/// Commands functions are used by things like key bindings, menus,
/// and event handlers to dispatch a specific type of user action.
/// They have a parameter type (which may be null and ignored).

export {Command} from "./command"

/// ### Menu System
///
/// A set of abstractions used to define generic menu items and
/// structure. This does not include an actual implementation of a
/// menu component. For that, see {@link editor.menuBar}.

export {Menu} from "./menu"

/// ### Deletion Commands
///
/// Commands that delete content.

export {
  insertText,
  insertLineBreak,
  enter,
  deleteUnit,
  deleteWord,
  deleteToLineEnd,
  deleteLine,
  transposeChars,
  setTextblockType,
  unwrapBlock,
  wrapBlock,
  toggleBlock,
  toggleMark,
  toggleEmphasis,
  toggleStrong,
  toggleUnderline,
  setAlignment,
  setDirection,
  toggleList,
  listIsActive,
  moveByUnit,
  moveByWord,
  moveByLine,
  moveByPage,
  moveToLineSide,
  moveToTextblockSide,
  moveToDocSide,
  selectAll,
  undo,
  redo
} from "./commands"
export {
  liftEmptyBlock,
  splitTextblock,
  deleteSelection,
  deleteEmptyTextblock,
  joinBackward,
  joinListItems,
  joinForward,
  deleteBackward,
  deleteForward,
  selectedTextblocks,
  clearNonFitting,
  findWrappable,
  wrapBlockRange,
  findUnwrappable,
  doUnwrapBlock,
  joinBlocks,
  canAddMarkInRange,
  autoJoinBlocks
} from "./helper"
