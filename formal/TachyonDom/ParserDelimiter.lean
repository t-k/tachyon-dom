import Std

namespace TachyonDom.ParserDelimiter

/-- Offset within the remaining UTF-16 code units, with length for a missing delimiter. -/
def scalarOffset {α : Type} [BEq α] (delimiter : α) : List α → Nat
  | [] => 0
  | unit :: rest => if unit == delimiter then 0 else scalarOffset delimiter rest + 1

theorem scalarOffset_eq_idxOf {α : Type} [BEq α] (delimiter : α) (suffix : List α) :
    scalarOffset delimiter suffix = suffix.idxOf delimiter := by
  induction suffix with
  | nil => rfl
  | cons unit rest ih => simp [scalarOffset, List.idxOf_cons, ih]

/-- The option represents the native search result, whose absent case is represented by -1 in JavaScript. -/
def nativeOffset {α : Type} [BEq α] (delimiter : α) (suffix : List α) : Option Nat :=
  let index := suffix.idxOf delimiter
  if index = suffix.length then none else some index

theorem nativeOffsetWithEnd_eq_scalarOffset {α : Type} [BEq α]
    (delimiter : α) (suffix : List α) :
    (nativeOffset delimiter suffix).getD suffix.length = scalarOffset delimiter suffix := by
  rw [scalarOffset_eq_idxOf]
  by_cases absent : suffix.idxOf delimiter = suffix.length <;> simp [nativeOffset, absent]

end TachyonDom.ParserDelimiter
