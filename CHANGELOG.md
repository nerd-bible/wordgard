## 0.3.1 (2026-07-16)

### Bug fixes

Fix an issue where mouse selection on an uneditable instance would update the state selection but not the DOM selection.

Avoid confusion about selection and deletion ranges when Android voice typing or a sloppy virtual keyboard fires a burst of input events.

### New features

Plots now have a `contentEq` method to compare only their content.

## 0.3.0 (2026-07-14)

### Breaking changes

Checking for plot atomicity should now be done with `state.isAtom`.

### Bug fixes

Fix an issue that broke the heading/paragraph block style key bindings.

No longer crash when an update touches part of an atomic plot.

Fix a bug that could prevent range wrapper decorations from properly redrawing.

Fix an issue that caused widgets at the end of the document to not be updated properly.

Fix a bug that broke updates when both point and range decorations changed.

Fix a crash in vertical cursor motion in an inline document.

Make forward cursor motion at line wrapping points eagerly go to the next line instead of first moving after the line-wrapped space.

Properly disable a lot of commands and menu items when the editor is read-only.

### New features

Change sets now have `extend` and `clip` methods that can be used to grow or shrink their extent.

`Wordgard.transactionListener` provides a way to listen in on transactions synchronously, as they are dispatched.

## 0.2.0 (2026-07-09)

### Breaking changes

Flip the order of the first two arguments to `ChangeSet.transform` so that it aligns with the static `transform` function.

Corrections no longer get access to the editor state.

### New features

`Correction.check` can now be used to directly apply corrections for a given set of changes.

`collab.transformUpdate` can be used for server-side change transformation.

wordgard/collab now includes support for applying corrections to changes it transforms.

## 0.1.2 (2026-07-09)

### Bug fixes

Make it possible to override the vertical sticky position of panels with CSS.

Fix incorrect results returned by `coordsAtPos` on line wrap points in Safari.

Fix issue where cutting could produce a broken document.

Fix `ChangeSet.fromJSON`, which was very broken.

## 0.1.1 (2026-07-05)

### Bug fixes

Clicking the link button when the link dialog is already open will now close it.

Work around d.ts bundler issue that caused the types of some fields in the `Pos` namespace to be incorrect in the output.

Fix a bug that caused the definition of the `link` namespace to be incorrectly tree-shaken.

### New features

Add a `Dialog.close` function for closing a dialog by class.

## 0.1.0 (2026-07-02)

### Breaking changes

First numbered release.

