// The corpus pins, in one place.
//
// This file exists because the pins were three hand-maintained literals in three test files, and
// they had been wrong three times - 648, 669, and the cdf6986 baseline in MAX-47 - each time
// caught by a person reading a diff rather than by a check. The pin is worth keeping: a loader
// that silently drops exercises is invisible otherwise, because a 404-per-exercise is the only
// symptom and nothing in the request path complains. But a pin nobody raises in the same commit
// as the content is a coin flip, so the pin lives here, next to the loader it is compared against,
// and both the test suite and the content gate read it.
//
// MAX-64 merged MAX-58 into this file. MAX-58 wanted the assertion in scripts/check-content-math.mjs
// and the values read out of the tests; this is the same check with the values moved out of the
// tests, because three copies of the same number is the thing being fixed.
//
// COUNTING RECORDS, NOT FILES. A file in content/exercises/ is either one record or an array of
// them, so the file count and the record count are different numbers (228 files hold 723 records
// at this pin). Anything that counts files reports roughly two thirds of the corpus and passes
// anyway. api/src/content.js documents this in its header comment; read the loader's readRecords()
// before writing a new gate that counts anything here.

export const CORPUS_PINS = {
  lessons: 36,
  exercises: 723,
  // Which commit the numbers describe, so "the pin is stale" and "the pin is wrong" are
  // distinguishable. Move this in the same commit that moves the counts above it.
  baseline: "769a33e",
};

// The failure message is the deliverable of this gate, not decoration. `669 == 648` was the
// whole of what MAX-52 left behind, and it names neither the corpus nor the fix. Name both
// numbers, name both sides, and say where the pin lives.
export function stalePinMessage(pinned, observed) {
  return (
    `corpus pins are stale: tests assert ${pinned.lessons} lessons / ${pinned.exercises} exercises,\n` +
    `content/ holds ${observed.lessons} lessons / ${observed.exercises} exercises\n` +
    `Raise CORPUS_PINS in lib/corpus-pins.mjs to ${observed.lessons} / ${observed.exercises} in the same commit.`
  );
}

// observed: { lessons, exercises } as reported by the thing that loaded the corpus - the
// ContentStore for the tests, the preflight loader for the content gate. Nothing here re-counts
// anything, so the gate cannot disagree with the loader about what the corpus holds.
export function checkCorpusPins(observed) {
  if (!observed || typeof observed.lessons !== "number" || typeof observed.exercises !== "number") {
    return ["corpus pins could not be checked: the loader reported no lesson/exercise counts"];
  }
  if (observed.lessons === CORPUS_PINS.lessons && observed.exercises === CORPUS_PINS.exercises) {
    return [];
  }
  return [stalePinMessage(CORPUS_PINS, observed)];
}
