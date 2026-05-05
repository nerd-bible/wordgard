import {PhraseSet} from "wordgard/state"
import {Command, toggleList, listIsActive} from "wordgard/command"
import {BulletList, OrderedList, ListItem} from "wordgard/schema"
import {MenuButton, BlockMenu, icon} from "wordgard/menu"
import {InputRule} from "wordgard/inputrule"

export const phrases = PhraseSet.define({
  toggle_bullet_list: "Toggle bullet list",
  toggle_ordered_list: "Toggle ordered list",
})

export const menu = {
  toggleBulletList: new MenuButton({
    run: Command.bind(toggleList, BulletList),
    active: listIsActive(BulletList),
    label: icon.BulletList,
    description: phrases.ref("toggle_bullet_list"),
    parent: BlockMenu,
    rank: 20
  }),

  toggleOrderedList: new MenuButton({
    run: Command.bind(toggleList, OrderedList.default!),
    active: listIsActive(OrderedList.default!),
    label: icon.OrderedList,
    description: phrases.ref("toggle_ordered_list"),
    parent: BlockMenu,
    rank: 30
  })
}

export const listOnDash = InputRule.wrapping(/^ ?- $/, BulletList)

export const listOnNumber = InputRule.wrapping(/^ ?(\d+)\. $/, match => OrderedList.of(+match[1]!.text))

// FIXME support inline list items?

export function bulletList() {
  return [BulletList, ListItem, menu.toggleBulletList, listOnDash]
}

export function orderedList() {
  return [OrderedList, ListItem, menu.toggleOrderedList, listOnNumber]
}
