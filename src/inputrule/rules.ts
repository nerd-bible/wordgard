import {InputRule} from "./inputrule"

/// Converts double dashes to an emdash.
export const emDash = InputRule.define({expr: /--$/, apply: "—"})
/// Converts three dots to an ellipsis character.
export const ellipsis = InputRule.define({expr: /\.\.\.$/, apply: "…"})
/// “Smart” opening double quotes.
export const openDoubleQuote = InputRule.define({expr: /(?:^|[\s\{\[\(\<'"\u2018\u201C])(")$/, apply: "“"})
/// “Smart” closing double quotes.
export const closeDoubleQuote = InputRule.define({expr: /"$/, apply: "”"})
/// ‘Smart’ opening single quotes.
export const openSingleQuote = InputRule.define({expr: /(?:^|[\s\{\[\(\<'"\u2018\u201C])(')$/, apply: "‘"})
/// ‘Smart’ closing single quotes.
export const closeSingleQuote = InputRule.define({expr: /'$/, apply: "’"})

/// Smart-quote related input rules.
export const smartQuotes: readonly InputRule[] = [openDoubleQuote, closeDoubleQuote, openSingleQuote, closeSingleQuote]
