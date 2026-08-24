//!definition

import {Plot, Leaf} from "wordgard/doc"

const Key = Plot.define("Key", {
  inline: true,
  inlineContent: Leaf.Text,
  shape: {element: "kbd"}
})

//!style

import {Wordgard} from "wordgard/editor"

const keyStyle = Wordgard.styles({
  "kbd": {
    backgroundColor: "#eee",
    borderRadius: "3px",
    border: "1px solid #bbb",
    boxShadow: "0 1px 1px #00000022, 0 2px 0 0 #ffffffaa inset",
    color: "#333",
    fontSize: "0.85",
    fontWeight: "bold",
    lineHeight: "1",
    padding: "2px 4px",
    whiteSpace: "pre"
  }
})

//!toggle

import {Command} from "wordgard/command"
import {GardSelection, Transaction} from "wordgard/state"

const toggleKey: Command.Pure = ({state}) => {
  let tr: Transaction.Spec = {
    scrollIntoView: true,
    userEvent: "insert.key"
  }
  let {from, to} = state.sel
  let parent = from.parent.start == to.parent.start
    ? from.parent : null
  if (parent && parent.node.type == Key.type) {
    tr.changes = [{from: parent.before, to: parent.start},
                  {from: parent.end, to: parent.after}]
  } else if (
    parent && !state.selection.empty &&
    state.schema.canContain(parent.node.type, Key.type) &&
    parent.node.content.slice(from.index, to.index)
      .every(n => n.isText)
  ) {
    tr.changes = [{from: from.pos, insert: [Key]},
                  {from: to.pos, insert: [Plot.End]}]
  } else {
    let {from, to} = state.selection.replacementRange
    tr.changes = {from, to, insert: [Key.create([])], fit: true},
    tr.selection = (cx, changes) => {
      let found = changes.findInserted(t => t.type == Key.type)
      if (found == null) return null
      return GardSelection.cursor(found + 1)
    }
  }
  return tr
}

//!bundle

import {Menu} from "wordgard/command"
import {GardState} from "wordgard/state"
import {KeyBinding} from "wordgard/editor"

const keyButton = Menu.Button.define({
  label: "⌨",
  description: "Insert key name",
  run: toggleKey,
  parent: Menu.Group.insert,
  rank: 82
})

const keyShortcut = KeyBinding.of({
  key: "Ctrl-Shift-k",
  run: toggleKey
})

export function key() {
  return [
    GardState.schemaElement.of(Key),
    keyStyle,
    keyButton,
    keyShortcut
  ]
}

//!editor

import {basicSchema} from "wordgard/schema"
import {menuBar} from "wordgard/editor"

;(window as any).wg = Wordgard.create({
  parent: document.body,
  doc: `<p><kbd>Ctrl</kbd> + x</p>`,
  config: [
    basicSchema(),
    menuBar(),
    key()
  ]
})


import {ChangeSet} from "wordgard/doc"
console.log(ChangeSet.create(wg.state.doc, {from: 2, to: 2}).sections)
