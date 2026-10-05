// The corpus, read once at startup and served from memory.
//
// Every route in this service answers from one ContentStore. That is a deliberate constraint
// rather than an optimisation: the UI/UX spec (IA §7) asks for a lesson list with prerequisite
// titles resolved server-side "one call, no N+1", which is only possible if the store already
// holds the whole prerequisite graph. Reading 100 files per request would also make the answer
// depend on the filesystem mid-session, which is a harder class of bug to find than a slow one.
//
// Three things are load-bearing here and each is easy to get quietly wrong:
//
//  1. Exercise files are sometimes a single record and sometimes an array of records. At the
//     corpus pin (lib/corpus-pins.mjs) 264 files hold 759 records, and 236 of those files are a
//     single object. A loader that assumes one shape silently drops roughly two thirds of the
//     corpus, and a 404-per-exercise is the only symptom. Anything that counts the corpus - this
//     loader, the content gate, the pins - has to count records. Counting files is how a gate
//     passes on a corpus it is not looking at.
//
//  2. Figure bytes do not travel here. A lesson or exercise carries figureReference() -- a
//     figureKey, the authored description, and the build's §5.5 cache key -- and the nine payload
//     fields stay behind the figure route. So a client learns "this exercise has a figure, and
//     here is what it shows" from the lesson/exercise payload, and learns the SVG, the hash and
//     the declared aspect ratio from the figure route, which is the split the figure contract
//     mandates.
//
//     The description is on the reference rather than on the route because of the degraded
//     state (Rendering Conventions §5.6): when the build has produced no usable manifest the
//     figure route is a hard 503 for every key, so the only moment the description is needed is
//     the moment the route cannot supply it. asymptoteSource -- kilobytes of build input per
//     figure -- still never leaves the build; the cache key is the hash of it, computed by the
//     build and attached from the figure store.
//
//  3. Dangling references are reported, not patched. A practice list naming an exercise id that
//     does not exist is a content bug. Serving the list anyway with the id quietly missing would
//     hand the client a short session it cannot explain, so the id is kept and surfaced in
//     warnings() instead.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exerciseFigureKey, exampleFigureKey, lessonFigureKey, figureReference } from "../../lib/figure-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

export const DEFAULT_CONTENT_ROOT = join(REPO, "content");

// A tier is the contest the exercise is drawn for. The corpus writes them as strings ("10",
// "12", "A"), and they are compared and sorted as strings so "A" does not sort before "10".
function tierOrder(tier) {
  return /^\d+$/.test(tier) ? Number(tier) : Number.POSITIVE_INFINITY;
}

function sortTiers(tiers) {
  return [...new Set(tiers)].sort((a, b) => tierOrder(a) - tierOrder(b) || String(a).localeCompare(String(b)));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Files may hold one record or many; accept both and say so in a single place.
function readRecords(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw new Error(`content directory ${dir} is unreadable: ${err.message}`);
  }
  for (const file of entries.sort()) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    const parsed = readJson(path);
    if (Array.isArray(parsed)) out.push(...parsed.filter((r) => r && r.id));
    else if (parsed && parsed.id) out.push(parsed);
    else throw new Error(`${path} is neither an exercise/lesson record nor an array of them`);
  }
  return out;
}

// The section a lesson's exercise lists live in. The spec asks for practiceIds / masteryIds on
// the lesson route, which is the same information under a name that says what the client does
// with it; solutions get the same treatment because lesson spec S3.6 renders them as their own
// list and the client cannot build that from an unnamed field.
//
// The corpus section name is carried explicitly rather than derived by stripping the Ids
// suffix. Deriving it is a one-line guess that is wrong exactly where the naming is irregular:
// "solutionIds" strips to "solution", the corpus section is "solutions", and the lookup misses
// so every lesson reports zero solutions while the two lists beside it look healthy.
const SECTION_ID_FIELDS = [
  { section: "practice", field: "practiceIds" },
  { section: "mastery", field: "masteryIds" },
  { section: "solutions", field: "solutionIds" },
];

export class ContentStore {
  constructor({ root = DEFAULT_CONTENT_ROOT, modules = [], figureCacheKeys = null } = {}) {
    this.root = root;
    this.figureCacheKeys = figureCacheKeys;
    this.lessons = new Map();
    this.exercises = new Map();
    this.warnings = [];

    for (const record of readRecords(join(root, "lessons"))) {
      if (this.lessons.has(record.id)) this.warnings.push(`duplicate lesson id ${record.id}`);
      this.lessons.set(record.id, record);
    }
    for (const record of readRecords(join(root, "exercises"))) {
      if (this.exercises.has(record.id)) this.warnings.push(`duplicate exercise id ${record.id}`);
      this.exercises.set(record.id, record);
    }

    this.moduleMeta = new Map(modules.map((m) => [m.id || m.code, m]));

    // Exercise ids per lesson, in the order the lesson lists them, then anything the lesson did
    // not list. Authored order is the order a learner is meant to meet them, so it wins over
    // filename order.
    this.exerciseIdsByLesson = new Map();
    for (const lesson of this.lessons.values()) {
      const ordered = [];
      const seen = new Set();
      for (const { section } of SECTION_ID_FIELDS) {
        for (const id of lessonExerciseIds(lesson, section)) {
          if (!seen.has(id)) {
            seen.add(id);
            ordered.push(id);
          }
        }
      }
      for (const ex of this.exercises.values()) {
        if (ex.lessonId === lesson.id && !seen.has(ex.id)) ordered.push(ex.id);
      }
      this.exerciseIdsByLesson.set(lesson.id, ordered);
    }

    this.checkReferences();
  }

  // A practice list that names an id nothing serves is reported and kept. Keeping it means the
  // lesson route stays faithful to the content and the client sees exactly what content asked
  // for; removing it would hide the bug behind a plausible-looking shorter list.
  checkReferences() {
    for (const lesson of this.lessons.values()) {
      for (const { section, field } of SECTION_ID_FIELDS) {
        for (const id of lessonExerciseIds(lesson, section)) {
          if (!this.exercises.has(id)) this.warnings.push(`lesson ${lesson.id} lists ${id} in ${field}, which no exercise file defines`);
        }
      }
      for (const id of lesson.prerequisites || []) {
        if (!this.lessons.has(id)) this.warnings.push(`lesson ${lesson.id} names prerequisite ${id}, which no lesson file defines`);
      }
    }
    for (const ex of this.exercises.values()) {
      if (!this.lessons.has(ex.lessonId)) this.warnings.push(`exercise ${ex.id} claims lesson ${ex.lessonId}, which no lesson file defines`);
    }
  }

  moduleIds() {
    const ids = new Set();
    for (const lesson of this.lessons.values()) ids.add(lesson.moduleId);
    // A module can legitimately have no lessons yet - the catalogue is wider than the corpus -
    // so declared modules are included even when nothing authored them.
    for (const id of this.moduleMeta.keys()) ids.add(id);
    return [...ids].sort(moduleCompare);
  }

  getModule(moduleId) {
    const lessons = [...this.lessons.values()]
      .filter((l) => l.moduleId === moduleId)
      .sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
    const meta = this.moduleMeta.get(moduleId) || null;
    const exerciseCount = lessons.reduce((n, l) => n + this.exerciseIdsByLesson.get(l.id).length, 0);
    const corpusTiers = sortTiers(lessons.flatMap((l) => l.tiers || []));
    // tiers answers "which tiers does this module cover", and the catalogue is where a module
    // declares its own coverage. Deriving it from lessons alone reported [] for a module whose
    // lessons have not been authored yet (M7), which is a tier badge that renders as nothing -
    // not an error, so nothing downstream noticed. Both numbers are reported so a client can
    // still tell "declared" from "authored".
    const tiers = corpusTiers.length ? corpusTiers : sortTiers(meta?.tiers || []);

    const module = {
      id: moduleId,
      code: moduleId,
      // title is null rather than a guess when no catalogue entry exists. The catalogue names
      // modules that the corpus does not yet author and numbers them differently from the
      // corpus (see the mismatch reported in warnings), so inferring a title from a lesson would
      // confidently mislabel the module. A null with a warning is the honest answer; the UI has
      // a documented fallback and content-ops owns the fix.
      title: meta?.title ?? null,
      summary: meta?.summary ?? null,
      topicSlug: meta?.topicSlug ?? lessons[0]?.topicSlug ?? null,
      order: meta?.order ?? moduleOrder(moduleId),
      targetExerciseCount: meta?.targetExerciseCount ?? null,
      tiers,
      declaredTiers: sortTiers(meta?.tiers || []),
      topicCount: lessons.length,
      lessonCount: lessons.length,
      exerciseCount,
    };
    return { module, lessons };
  }

  listModules() {
    const modules = this.moduleIds().map((id) => this.getModule(id).module);
    const missingTitle = modules.filter((m) => m.title === null).map((m) => m.code);
    return { modules, missingTitle };
  }

  // The figure build's cache key for a figureKey, or null. This is the one field on a figure
  // reference that a content record cannot supply: §5.5's key is a hash of the Asymptote source
  // folded with the pipeline version, and asymptoteSource never leaves the build. The keys come
  // from the figure store (api/src/figures.js) and are attached here once, so the response
  // builders below never have to know a manifest exists.
  //
  // Null is the honest answer when the build has produced no usable manifest, and it is what the
  // degraded state looks like: no compiled figure, no key, nothing for the client to cache.
  figureCacheKeyFor(figureKey) {
    if (!this.figureCacheKeys) return null;
    return this.figureCacheKeys.get(figureKey) ?? null;
  }

  getLesson(lessonId) {
    const lesson = this.lessons.get(lessonId);
    if (!lesson) return null;
    return toLessonResponse(this, lesson);
  }

  getExercise(exerciseId) {
    const ex = this.exercises.get(exerciseId);
    return ex ? toExerciseResponse(this, ex) : null;
  }

  // Batched fetch (IA S7: one call, ids or lessonId). Ids win when both are given, because a
  // client that knows exactly what it wants should not have it widened by a second filter.
  //
  // Every other filter the route accepts is honoured here too, by handing the request to
  // searchExercises. A filter this method silently ignored was worse than a missing one: the
  // result was the whole corpus, sorted by id, which reads like a plausible answer to
  // `?moduleId=M3` instead of like the bug it is.
  queryExercises(filters = {}) {
    const { ids, lessonId, ...rest } = filters;
    const hasOtherFilter = Object.values(rest).some((v) => v !== undefined && v !== null && v !== "");
    let out;
    if (Array.isArray(ids) && ids.length > 0) {
      out = ids.map((id) => this.exercises.get(id)).filter(Boolean);
    } else if (lessonId && !hasOtherFilter) {
      // The lesson's own order, which is the order a learner is meant to meet the exercises in.
      out = (this.exerciseIdsByLesson.get(lessonId) || [])
        .map((id) => this.exercises.get(id))
        .filter(Boolean);
    } else {
      out = this.searchExercises(filters);
    }
    // A deterministic order is what makes a batched fetch cacheable and diffable; the client
    // does its own queue ordering on top of this.
    return out
      .slice()
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((ex) => toExerciseResponse(this, ex));
  }

  // The search the practice session builder filters on. Every filter is optional and unknown
  // values produce an empty set rather than an error: a filter that matches nothing is a
  // normal outcome with a designed empty state in the UI ("No exercises match these
  // filters."), not a client mistake.
  searchExercises(filters = {}) {
    const { moduleId, lessonId, tiers, tags, difficultyMin, difficultyMax, includeMastery } = filters;
    const tierSet = tiers && tiers.length ? new Set(tiers.map(String)) : null;
    const tagSet = tags && tags.length ? new Set(tags) : null;
    const min = difficultyMin === undefined || difficultyMin === null ? null : Number(difficultyMin);
    const max = difficultyMax === undefined || difficultyMax === null ? null : Number(difficultyMax);

    let pool = [...this.exercises.values()];
    if (lessonId) pool = pool.filter((e) => e.lessonId === lessonId);
    if (moduleId) pool = pool.filter((e) => e.moduleId === moduleId);
    if (tierSet) pool = pool.filter((e) => tierSet.has(String(e.tier)));
    if (tagSet) pool = pool.filter((e) => (e.tags || []).some((t) => tagSet.has(t)));
    if (min !== null && !Number.isNaN(min)) pool = pool.filter((e) => Number(e.difficulty) >= min);
    if (max !== null && !Number.isNaN(max)) pool = pool.filter((e) => Number(e.difficulty) <= max);

    // Ids sorted, not filesystem order: a session built from the same filters must produce the
    // same itemIds on every host, or resume breaks the moment the corpus is re-indexed.
    return pool.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  // The exerciseIds the lesson's own sections name, keyed the way the lesson route reports them.
  practiceIds(lessonId) {
    return this.exerciseIdsByLesson.get(lessonId) || [];
  }

  stats() {
    return {
      lessons: this.lessons.size,
      exercises: this.exercises.size,
      modules: this.moduleIds().length,
      warnings: this.warnings.length,
    };
  }
}

function moduleOrder(moduleId) {
  const n = /(\d+)/.exec(String(moduleId));
  return n ? Number(n[1]) : Number.MAX_SAFE_INTEGER;
}

// M2 before M10, and M1 before M2 - a plain string sort puts M10 first and every catalogue
// rendered by one would be wrong in the same way.
function moduleCompare(a, b) {
  return moduleOrder(a) - moduleOrder(b) || String(a).localeCompare(String(b));
}

function lessonExerciseIds(lesson, sectionName) {
  const section = lesson?.sections?.[sectionName];
  return Array.isArray(section?.exerciseIds) ? section.exerciseIds : [];
}

// The lesson route's shape (IA S7). Two transformations, both deliberate:
//
//   * sections.practice.exerciseIds becomes sections.practiceIds. Same data, name that says what
//     the client does with it, and it keeps the concept/pitfalls/techniques prose sections
//     addressing the client can index into unchanged.
//   * every figure list is replaced by figure references. figureKey is the address; the payload
//     is fetched from the figure route.
export function toLessonResponse(store, lesson) {
  const sections = {};
  const source = lesson.sections || {};

  for (const [name, section] of Object.entries(source)) {
    if (!section || typeof section !== "object") continue;
    if (name === "figures") continue;
    const copy = { ...section };
    if (Array.isArray(section.figures)) copy.figures = lessonFigureRefs(store, lesson, name, section.figures);
    // Worked examples carry their own figure fields, and a worked example is a section member
    // like any other, so the same projection applies to it. Without this the asymptoteSource of
    // every figure-bearing example rides along on every lesson response, which is exactly the
    // build input the figure contract keeps behind the build.
    if (Array.isArray(section.examples)) {
      copy.examples = section.examples.map((example, i) => toExampleResponse(store, lesson, name, example, i));
    }
    sections[name] = copy;
  }
  for (const { section, field } of SECTION_ID_FIELDS) sections[field] = lessonExerciseIds(lesson, section).slice();

  return {
    id: lesson.id,
    moduleId: lesson.moduleId,
    title: lesson.title,
    topicSlug: lesson.topicSlug ?? null,
    order: lesson.order ?? null,
    tiers: lesson.tiers || [],
    tags: lesson.tags || [],
    estimatedMinutes: lesson.estimatedMinutes ?? null,
    lockMode: lesson.lockMode || "soft",
    prerequisites: (lesson.prerequisites || []).slice(),
    sections,
    exerciseCount: store.practiceIds(lesson.id).length,
  };
}

function lessonFigureRefs(store, lesson, sectionName, figures) {
  return figures
    .map((fig, i) => {
      if (!fig || !fig.asymptoteSource) return null;
      const figureKey = lessonFigureKey(lesson.id, sectionName, i);
      return figureReference(figureKey, fig.asymptoteAlt, store.figureCacheKeyFor(figureKey));
    })
    .filter(Boolean);
}

// A worked example, with its figure reduced to a reference. The build input is dropped rather than
// blanked: an empty asymptoteSource would read as "this figure has no source", which is a
// different and wrong claim. When there is a figure, figureKey and the description are there
// instead, and the payload comes from the figure route.
function toExampleResponse(store, lesson, sectionName, example, index) {
  if (!example || typeof example !== "object") return example;
  const { asymptoteSource, asymptoteAlt, asymptoteAspectRatio, ...rest } = example;
  if (!asymptoteSource) return rest;
  const figureKey = exampleFigureKey(lesson.id, sectionName, index);
  return { ...rest, ...figureReference(figureKey, asymptoteAlt, store.figureCacheKeyFor(figureKey)) };
}

// The exercise route's shape. Raw LaTeX in, raw LaTeX out - never pre-rendered HTML (IA S7): the
// frontend owns the KaTeX options and the per-route render budget, and a server-rendered
// formula would be rendered with the wrong options or at the wrong size.
//
// The answer travels with the record on purpose for multiple choice and withheld for
// free response, per lesson spec S3.3: "for MC the client knows the correct index (the exercise
// record ships the answer with the exercise; MC answers aren't secret in the same way) ... v1
// ships the answer for MC, withholds it for free-response." The withholding is done here, once,
// so it cannot be forgotten by a route that forgets to ask.
export function toExerciseResponse(store, ex) {
  const isChoice = Array.isArray(ex.choices) && ex.choices.length > 0;
  const response = {
    id: ex.id,
    moduleId: ex.moduleId,
    lessonId: ex.lessonId,
    tier: ex.tier,
    difficulty: ex.difficulty ?? null,
    tags: ex.tags || [],
    promptLatex: ex.promptLatex,
    choices: Array.isArray(ex.choices) ? ex.choices : null,
    hintLatex: ex.hintLatex || [],
    techniqueSlugs: ex.techniqueSlugs || [],
    // Lesson spec §3.1: "plus, when present, a one-line explanation field" on a correct answer.
    // No exercise in the corpus carries one yet; it is passed through when authored so the
    // frontend does not need a second change when it starts appearing.
    explanation: ex.explanation ?? null,
    angleUnit: ex.angleUnit ?? null,
    answerAngle: ex.answerAngle ?? null,
    mode: isChoice ? "choice" : "free-response",
  };

  if (isChoice) {
    response.answerLatex = ex.answerLatex ?? null;
    response.answerAlternatives = ex.answerAlternatives || [];
    // The worked solution is the answer written out, so it rides on the same rule the key does. A
    // record that ships answerWithheld: true and then prints the derivation is not withholding
    // anything, and it makes the solution route's three-attempt lock decorative: the client
    // already has the text the lock exists to protect.
    response.solutionLatex = ex.solutionLatex ?? null;
  } else {
    // Withheld, not blanked: a client that needs the free-response key has to ask the server.
    response.answerWithheld = true;
    response.solutionWithheld = true;
  }

  // The reference carries the description as well as the key, because the degraded state renders
  // it and the degraded state is the one where this route's figure cannot be fetched.
  if (ex.asymptoteSource) {
    const figureKey = exerciseFigureKey(ex.id);
    return { ...response, ...figureReference(figureKey, ex.asymptoteAlt, store.figureCacheKeyFor(figureKey)) };
  }
  return response;
}

// The full record, answer included. Only the grading path uses this, and it exists so that the
// answer key has exactly one reader in the service.
export function toGradingRecord(ex) {
  return {
    id: ex.id,
    tier: ex.tier,
    difficulty: ex.difficulty ?? null,
    choices: Array.isArray(ex.choices) ? ex.choices : null,
    answerLatex: ex.answerLatex ?? "",
    answerAlternatives: ex.answerAlternatives || [],
    solutionLatex: ex.solutionLatex ?? null,
    hintLatex: ex.hintLatex || [],
    angleUnit: ex.angleUnit ?? null,
    answerAngle: ex.answerAngle ?? null,
  };
}

// Optional module catalogue. content/modules.json is not in the repository today; when it lands
// the API picks it up with no change here. A missing catalogue is a warning, not a crash:
// eight modules of lessons and 474 exercises are perfectly servable without titles.
export function loadModuleMeta(root = DEFAULT_CONTENT_ROOT) {
  const path = join(root, "modules.json");
  let parsed;
  try {
    parsed = readJson(path);
  } catch (err) {
    if (err.code === "ENOENT") return { modules: [], present: false, path };
    throw new Error(`module catalogue ${path} is unreadable: ${err.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed.modules;
  if (!Array.isArray(list)) throw new Error(`module catalogue ${path} must be an array or {modules:[...]}`);
  return { modules: list.filter((m) => m && (m.id || m.code)), present: true, path };
}

export function loadContentStore(root = process.env.CONTENT_ROOT || DEFAULT_CONTENT_ROOT, { figureCacheKeys = null } = {}) {
  const { modules, present, path } = loadModuleMeta(root);
  const store = new ContentStore({ root, modules, figureCacheKeys });
  if (!present) {
    store.warnings.push(
      `no module catalogue at ${path}; GET /api/modules reports title: null for every module until content authors one`,
    );
  }
  return store;
}
