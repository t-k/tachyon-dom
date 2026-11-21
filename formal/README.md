# Formal verification

Install [Elan](https://lean-lang.org/install/) and run these commands in this directory. Elan selects the version in `lean-toolchain`.

```sh
lake build
lake env leanchecker TachyonDom
```

`CompilerValidation` proves that a successful expression check stays successful when inherited raw-text restrictions are dropped, that removing successful checks preserves the first structural diagnostic, and that freezing the cache wrapper freezes every reachable payload object.

`HtmlWhitespace` proves that an input with no whitespace edit candidates has only unchanged tag slices, regardless of quote state. It abstracts source spans as contiguous slices and models the four code-unit classes used by the guard.

`Utf8Length` proves that UTF-16 code-unit length is a lower bound for UTF-8 byte length, that ASCII fragments have equal lengths, and that skipping an exact measurement after the lower bound reaches the flush threshold leaves the coalesced stream unchanged.

`QueryGrouping` proves that stable grouping preserves duplicate values in their original order for each schema key. Grouped lookup applies to well-formed schema keys, while other keys use the native query name conversion.

`HydrationMarkers` proves that classifying comments during the DOM walk produces the same marker buckets as collecting them first, preserving document order and duplicate markers.
