/// This module defines an editor component for use in the browser, on
/// top of the editing model defined in the other modules. It _can_ be
/// loaded outside the browser, but won't do anything useful there.
///
/// ### Editor Component
///
/// The {@link Wordgard} class is responsible for displaying an editor
/// interface and the document inside of it. It captures basic user
/// events, such as typing and pointer clicks, and converts them into
/// editing actions.

export {Wordgard} from "./editor"

export {MouseSelectionStyle} from "./input"

/// ### Key Bindings
///
/// Functionality used for binding keys to editing commands.

export {KeyBinding, defaultKeymap} from "./keymap"

/// ### Decoration
///
/// Decorations provide a way to influence the way the document is
/// displayed without changing the document itself, via editor
/// extensions. They are useful for showing out-of-band information or
/// editing controls directly in the editable content.

export {Decoration, Widget, PointSet, RangeSet} from "./decoration"

/// ### Panels
///
/// Panels are interface elements displayed above or below the editor.
/// They use sticky positioning to stay in view even when the editor
/// is partially scrolled out of view. They are a good way to display
/// things like dialogs, status bars, and menu bars.

export {Panel} from "./panel"
export {showDialog, getDialog} from "./dialog"

/// ### Tooltips
///
/// Tooltips are small elements displayed over the editor near a
/// specific document position.

export {Tooltip} from "./tooltip"

/// ### Menu Bar
///
/// The {@link menuBar} extension displays menu items defined via the
/// {@link command.Menu menu system} in a button bar at the top of the
/// editor. It is possible to replace it with your own custom menu
/// implementation, but 

export {menuBar} from "./menubar"

/// ### Input Rules
///
/// Input rules are a way to respond to certain patterns of text input
/// with an action, such as replacing sequences of dashes with emdash
/// characters or automatically creating lists when a textblock is
/// started with a number and a period.

export {InputRule} from "./inputrule"
import "./drawcursor"
