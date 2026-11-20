import Std

namespace TachyonDom.RouteIndex

/-- The regex requires a leading slash, a non-slash literal segment, and a second slash before any remainder can match. -/
theorem firstSegmentOfMatchingPrefix (segment suffix : List Char)
    (literal : ∀ c ∈ segment, c ≠ '/') :
    ((segment ++ '/' :: suffix).takeWhile (· != '/')) = segment := by
  induction segment with
  | nil => simp
  | cons c rest ih =>
    have head := literal c List.mem_cons_self
    have tail := ih (fun d hd => literal d (List.mem_cons_of_mem c hd))
    simp [head, tail]

/-- A miss changes nothing, a fallback replaces the previous fallback, and a decisive
result stops the search. A decisive result may be a match or a server diagnostic. -/
inductive Outcome (α : Type) where
  | miss
  | fallback (value : α)
  | decisive (value : α)

def scan (evaluate : α → Outcome β) : List α → Option β → Option β
  | [], fallback => fallback
  | candidate :: rest, fallback =>
    match evaluate candidate with
    | .miss => scan evaluate rest fallback
    | .fallback value => scan evaluate rest (some value)
    | .decisive value => some value

/-- Removing only impossible matches preserves both the first decisive result and
the last fallback if no decisive result exists. -/
theorem scan_filter_misses (eligible : α → Bool) (evaluate : α → Outcome β) (candidates : List α)
    (excludedMisses : ∀ candidate ∈ candidates, eligible candidate = false → evaluate candidate = .miss)
    (fallback : Option β) :
    scan evaluate (candidates.filter eligible) fallback = scan evaluate candidates fallback := by
  induction candidates generalizing fallback with
  | nil => rfl
  | cons candidate rest ih =>
    have tail := fun c h => excludedMisses c (List.mem_cons_of_mem candidate h)
    cases allowed : eligible candidate with
    | false =>
      have miss := excludedMisses candidate (List.mem_cons_self) allowed
      simp [allowed, scan, miss, ih tail]
    | true =>
      cases result : evaluate candidate <;> simp [allowed, scan, result, ih tail]

private def compareRank (rank : α → Nat) (a b : α) : Bool := decide (rank a ≤ rank b)

private theorem merge_left_first (rank : α → Nat) (a : α) (left right : List α)
    (before : ∀ b ∈ right, rank a < rank b) :
    List.merge (a :: left) right (compareRank rank) =
      a :: List.merge left right (compareRank rank) := by
  cases right with
  | nil => simp
  | cons b rest =>
    have h : compareRank rank a b = true :=
      decide_eq_true (Nat.le_of_lt (before b List.mem_cons_self))
    simp [h]

private theorem merge_right_first (rank : α → Nat) (a : α) (left right : List α)
    (before : ∀ b ∈ left, rank a < rank b) :
    List.merge left (a :: right) (compareRank rank) =
      a :: List.merge left right (compareRank rank) := by
  cases left with
  | nil => simp
  | cons b rest =>
    have h : compareRank rank b a = false :=
      decide_eq_false (Nat.not_le_of_lt (before b List.mem_cons_self))
    simp [h]

/-- With distinct ranks, merging the disjoint lists for the requested segment
and generic routes is exactly stable filtering of the original ranked table. -/
theorem rankMerge_eq_filter (rank : α → Nat) (bucket generic : α → Bool) (routes : List α)
    (sorted : routes.Pairwise (fun a b => rank a < rank b))
    (disjoint : ∀ a ∈ routes, bucket a = true → generic a = false) :
    List.merge (routes.filter bucket) (routes.filter generic) (compareRank rank) =
      routes.filter (fun a => bucket a || generic a) := by
  induction routes with
  | nil => simp
  | cons route rest ih =>
    obtain ⟨before, tailSorted⟩ := List.pairwise_cons.mp sorted
    have tail := ih tailSorted (fun a h => disjoint a (List.mem_cons_of_mem route h))
    cases inBucket : bucket route with
    | true =>
      have notGeneric := disjoint route List.mem_cons_self inBucket
      have beforeGeneric : ∀ other ∈ rest.filter generic, rank route < rank other :=
        fun other h => before other (List.mem_filter.mp h).1
      simp [inBucket, notGeneric, merge_left_first rank route _ _ beforeGeneric, tail]
    | false =>
      cases inGeneric : generic route with
      | false => simp [inBucket, inGeneric, tail]
      | true =>
        have beforeBucket : ∀ other ∈ rest.filter bucket, rank route < rank other :=
          fun other h => before other (List.mem_filter.mp h).1
        simp [inBucket, inGeneric, merge_right_first rank route _ _ beforeBucket, tail]

/-- Indexed search is equivalent once the known first-segment mismatch rules out
every excluded match. The proof keeps both successful and diagnostic decisive results. -/
theorem indexedScan_eq_scan (rank : α → Nat) (bucket generic : α → Bool)
    (evaluate : α → Outcome β) (routes : List α) (fallback : Option β)
    (sorted : routes.Pairwise (fun a b => rank a < rank b))
    (disjoint : ∀ a ∈ routes, bucket a = true → generic a = false)
    (excludedMisses : ∀ a ∈ routes, (bucket a || generic a) = false → evaluate a = .miss) :
    scan evaluate (List.merge (routes.filter bucket) (routes.filter generic) (compareRank rank)) fallback =
      scan evaluate routes fallback := by
  rw [rankMerge_eq_filter rank bucket generic routes sorted disjoint]
  exact scan_filter_misses _ evaluate routes excludedMisses fallback

end TachyonDom.RouteIndex
