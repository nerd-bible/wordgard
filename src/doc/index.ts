/// This module defines the library's document data structure. A
/// document consists of _{@link Plot plots}_ (nodes that wrap
/// content) and _{@link Leaf leaves}_ (no content). The {@link
/// Plot.Doc document} itself is a plot.

export {Node, Leaf, Plot} from "./node"
export {Mark} from "./mark"

/// ### Shapes

export {Elt, Attributes, Shape, ParseRule} from "./shape"

/// ### Schema
///
/// Each document has a {@link Schema schema} associated with it that
/// configures the set of nodes and marks that can occur in it, and
/// their relations.

export {Schema} from "./schema"
export {SchemaError, ValidationError} from "./error"

/// ### Changes
///
/// Document changes are represented as a series of replaced or
/// updated (adding or removing marks) ranges.

export {Token, Slice} from "./slice"
export {ChangeSet} from "./change"

/// ### Resolved Positions

export {Pos} from "./pos"

/// ### Parsing

export {parse} from "./parse"

/// ### Serialization

export {serialize} from "./serialize"
