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
// them, so the file count and the record count are different numbers (264 files hold 759 records
// at this pin, 236 of them a single object). Anything that counts files reports roughly two thirds of the corpus and passes
// anyway. api/src/content.js documents this in its header comment; read the loader's readRecords()
// before writing a new gate that counts anything here.

export const CORPUS_PINS = {
  lessons: 38,
  exercises: 759,
  // Which commit the numbers describe, so "the pin is stale" and "the pin is wrong" are
  // distinguishable. Move this in the same commit that moves the counts above it.
  baseline: "2716a44",
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

// The module catalogue's own numbers, checked the same way (MAX-65).
//
// content/modules.json carried a targetExerciseCount per module that no module page could agree
// with: the nine summed to 1,050 against a corpus of 759, so every module under-reported against
// it permanently and two already met or beat it. Its `note` field then narrated which lessons
// were still unauthored, which was false within two merges. Both were one hand-edited JSON file
// with nothing comparing it to the corpus, so the fix that is actually worth keeping is not the
// new numbers - it is this check. The counts are now the measured corpus, and the catalogue
// carries no claim the loader can contradict.
//
// observedModules: the module objects GET /api/modules reports, i.e. [{ code, exerciseCount,
// targetExerciseCount }]. exerciseCount comes from the loaded corpus and targetExerciseCount from
// the catalogue, in the same payload a client reads, so this cannot pass while the route lies.
// Nothing here recounts the corpus.
export function checkCatalogueTargets(observedModules) {
  if (!Array.isArray(observedModules) || observedModules.length === 0) {
    return ["catalogue targets could not be checked: no modules were reported"];
  }
  const problems = [];
  for (const m of observedModules) {
    if (typeof m.targetExerciseCount !== "number") {
      problems.push(`catalogue: ${m.code} declares no targetExerciseCount, so GET /api/modules reports null for it`);
    } else if (m.targetExerciseCount !== m.exerciseCount) {
      problems.push(
        `catalogue: ${m.code} declares targetExerciseCount ${m.targetExerciseCount} but its corpus holds ${m.exerciseCount}\n` +
        `Set targetExerciseCount in content/modules.json to ${m.exerciseCount} in the same commit as the content change.`,
      );
    }
  }
  return problems;
}
