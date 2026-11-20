# Formal verification

Install [Elan](https://lean-lang.org/install/) and run these commands in this directory. Elan selects the version in `lean-toolchain`.

```sh
lake build
lake env leanchecker TachyonDom
```

`TachyonDom/ListOrder.lean` models the middle of a keyed list after removing its shared prefix and suffix. Nonnegative values identify positions in the previous order. Negative values denote new rows. The scan starts at `-1` and compares each retained position with the previous retained position.

If the scan succeeds, the entire retained sequence is strictly increasing, and every longest increasing subsequence contains every retained row. The runtime can use the sign of each old position to pick stable rows in this case. The proof addresses that selection rule on the abstract sequence. The TypeScript regressions exercise the implementation, the fallback to the existing LIS algorithm, and the subsequent DOM placement.

`CompilerValidation` proves that a successful expression check stays successful when inherited raw-text restrictions are dropped, that removing successful checks preserves the first structural diagnostic, and that freezing the cache wrapper freezes every reachable payload object.

`ListAppend` proves that after validating a retained prefix and a new suffix, selecting the suffix produces the same rows in the same order as filtering by membership in the previous list.

`HtmlWhitespace` proves that an input with no whitespace edit candidates has only unchanged tag slices, regardless of quote state. It abstracts source spans as contiguous slices and models the four code-unit classes used by the guard.
