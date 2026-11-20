import Std

namespace TachyonDom.Utf8Length

/-- Widths after grouping UTF-16 surrogate pairs and decoding isolated surrogates as U+FFFD. -/
inductive Unit
  | ascii | twoByte | threeByte | replacement | surrogatePair
  deriving DecidableEq

def Unit.utf16Width : Unit → Nat
  | .surrogatePair => 2
  | _ => 1

def Unit.utf8Width : Unit → Nat
  | .ascii => 1
  | .twoByte => 2
  | .threeByte | .replacement => 3
  | .surrogatePair => 4

def utf16Length (input : List Unit) : Nat :=
  (input.map Unit.utf16Width).sum

def utf8Length (input : List Unit) : Nat :=
  (input.map Unit.utf8Width).sum

theorem utf16_le_utf8 (input : List Unit) : utf16Length input ≤ utf8Length input := by
  induction input with
  | nil => simp [utf16Length, utf8Length]
  | cons unit rest ih =>
    have width : unit.utf16Width ≤ unit.utf8Width := by cases unit <;> decide
    simpa [utf16Length, utf8Length] using Nat.add_le_add width ih

theorem utf16_eq_utf8_of_ascii (input : List Unit) (ascii : ∀ unit ∈ input, unit = .ascii) :
    utf16Length input = utf8Length input := by
  induction input with
  | nil => rfl
  | cons unit rest ih =>
    have head := ascii unit (by simp)
    have tail := ih (fun item h => ascii item (List.mem_cons_of_mem _ h))
    simp_all [utf16Length, utf8Length, Unit.utf16Width, Unit.utf8Width]

/-- Coalescing resets the measurement at each flush, so an above-target total needs no exact value. -/
def flushStep (target total : Nat) : Bool × Nat :=
  if target ≤ total then (true, 0) else (false, total)

def measuredTotal (target pending probeMax : Nat) (input : List Unit) : Nat :=
  let lowerBound := pending + utf16Length input
  if target ≤ lowerBound ∨ (utf16Length input ≤ probeMax ∧ input.all (· == .ascii)) then lowerBound
  else lowerBound + (utf8Length input - utf16Length input)

/-- The same chunks flush, and any retained byte count stays exact. -/
theorem measuredFlush_eq_encodedFlush (target pending probeMax : Nat) (input : List Unit) :
    flushStep target (measuredTotal target pending probeMax input) =
      flushStep target (pending + utf8Length input) := by
  unfold measuredTotal
  by_cases enough : target ≤ pending + utf16Length input
  · have larger := Nat.add_le_add_left (utf16_le_utf8 input) pending
    have enoughBytes := Nat.le_trans enough larger
    simp [enough, enoughBytes, flushStep]
  · by_cases probe : utf16Length input ≤ probeMax ∧ input.all (· == .ascii) = true
    · have same := utf16_eq_utf8_of_ascii input (by simpa [List.all_eq_true] using probe.2)
      rw [ite_eq_left (Or.inr probe), same]
    · have exactBytes : pending + utf16Length input + (utf8Length input - utf16Length input) =
          pending + utf8Length input := by
        have bound := utf16_le_utf8 input
        omega
      rw [ite_eq_right (fun guard => guard.elim enough probe), exactBytes]

end TachyonDom.Utf8Length
