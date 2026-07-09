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

