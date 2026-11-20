import Std

namespace TachyonDom.ListOrder

/-- Old row indices are nonnegative. A negative entry denotes a new row. -/
def retained (positions : List Int) : List Int :=
  positions.filter (fun position => 0 ≤ position)

/-- Scan only retained rows. The caller starts with sentinel -1. -/
def increasingFrom (previous : Int) : List Int → Bool
  | [] => true
  | position :: rest =>
    if position < 0 then increasingFrom previous rest
    else decide (previous < position) && increasingFrom position rest

theorem increasingFrom_spec (previous : Int) (positions : List Int) :
    increasingFrom previous positions = true ↔
      (retained positions).Pairwise (· < ·) ∧
        (∀ position ∈ retained positions, previous < position) := by
  induction positions generalizing previous with
  | nil => simp [increasingFrom, retained]
  | cons position rest ih =>
    by_cases newRow : position < 0
    · have notRetained : ¬ 0 ≤ position := by omega
      simpa [increasingFrom, retained, newRow, notRetained] using ih previous
    · have isRetained : 0 ≤ position := by omega
      have step : retained (position :: rest) = position :: retained rest := by
        simp [retained, isRetained]
      rw [step]
      simp only [increasingFrom, ite_eq_right newRow, Bool.and_eq_true, decide_eq_true_eq,
        ih, List.pairwise_cons, List.mem_cons]
      constructor
      · rintro ⟨before, sorted, after⟩
        exact ⟨⟨after, sorted⟩, fun p hp => hp.elim (fun eq => eq ▸ before)
          (fun mem => Int.lt_trans before (after p mem))⟩
      · rintro ⟨⟨after, sorted⟩, bound⟩
        exact ⟨bound position (Or.inl rfl), sorted, after⟩

/-- An increasing subsequence of the old row indices, with new rows excluded. -/
def IncreasingCandidate (positions candidate : List Int) : Prop :=
  candidate.Sublist positions ∧ candidate.Pairwise (· < ·) ∧ ∀ p ∈ candidate, 0 ≤ p

/-- If the scan succeeds, retaining every existing row is itself a valid LIS candidate. -/
theorem retainAll_isCandidate (positions : List Int)
    (ordered : increasingFrom (-1) positions = true) :
    IncreasingCandidate positions (retained positions) := by
  refine ⟨List.filter_sublist, ((increasingFrom_spec (-1) positions).mp ordered).1, ?_⟩
  intro p hp
  exact of_decide_eq_true (List.mem_filter.mp hp).2

/-- On the fast path, every longest candidate equals the full retained sequence. -/
theorem longest_eq_retained (positions candidate : List Int)
    (ordered : increasingFrom (-1) positions = true)
    (valid : IncreasingCandidate positions candidate)
    (longest : ∀ other, IncreasingCandidate positions other → other.length ≤ candidate.length) :
    candidate = retained positions := by
  have filtered := valid.1.filter (fun p => 0 ≤ p)
  have allRetained : retained candidate = candidate := by
    apply List.filter_eq_self.mpr
    intro p hp
    exact decide_eq_true (valid.2.2 p hp)
  change (retained candidate).Sublist (retained positions) at filtered
  rw [allRetained] at filtered
  exact filtered.eq_of_length (Nat.le_antisymm filtered.length_le
    (longest _ (retainAll_isCandidate positions ordered)))

end TachyonDom.ListOrder
