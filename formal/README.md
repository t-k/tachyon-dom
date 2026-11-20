# Formal verification

Install [Elan](https://lean-lang.org/install/) and run these commands in this directory. Elan selects the version in `lean-toolchain`.

```sh
lake build
lake env leanchecker TachyonDom.ListOrder
```

`TachyonDom/ListOrder.lean` models the middle of a keyed list after removing its shared prefix and suffix. Nonnegative values identify positions in the previous order. Negative values denote new rows. The scan starts at `-1` and compares each retained position with the previous retained position.

If the scan succeeds, the entire retained sequence is strictly increasing, and every longest increasing subsequence contains every retained row. The runtime can use the sign of each old position to pick stable rows in this case. The proof addresses that selection rule on the abstract sequence. The TypeScript regressions exercise the implementation, the fallback to the existing LIS algorithm, and the subsequent DOM placement.
