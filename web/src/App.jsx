// App — the thinnest thing that proves the rendering layer is wired to the real API.
//
// This is deliberately a reader, not the finished product. Routes, a practice runner and progress
// are their own work; what needed proving here is that a stored LaTeX string and a figure
// reference arriving from the API end up as rendered math and a rendered figure, with a broken
// expression or a missing figure degrading instead of blanking the page.

import React, { useEffect, useState } from "react";
import MathBlock from "./components/MathBlock.jsx";
import Figure, { FigureRef } from "./components/Figure.jsx";
import "./styles.css";

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

function useApi(path) {
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ status: "loading", data: null, error: null });
    getJson(path)
      .then((data) => live && setState({ status: "ready", data, error: null }))
      .catch((error) => live && setState({ status: "error", data: null, error: String(error) }));
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}

function Section({ name, section }) {
  if (!section || typeof section !== "object") return null;
  const body = [];

  // conceptLatex is the section's own body: the paragraphs that teach it. It leads, because in every
  // section that carries it the rest is reference material for what this says. Split on blank
  // lines and render each as a block, so a paragraph that is one display equation gets display
  // spacing and a prose paragraph still gets its inline math.
  if (section.conceptLatex) {
    body.push(
      <div key="concept">
        {String(section.conceptLatex)
          .split(/\n{2,}/)
          .map((paragraph, index) => (
            <MathBlock key={index} source={paragraph} block />
          ))}
      </div>
    );
  }
  if (section.objectiveLatex) {
    body.push(<MathBlock key="objective" source={section.objectiveLatex} />);
  }
  if (section.noteLatex) {
    body.push(<MathBlock key="note" source={section.noteLatex} />);
  }
  if (Array.isArray(section.items) && section.items.length) {
    body.push(
      <ul key="items">
        {section.items.map((item, index) => (
          <li key={item.slug || item.id || index}>
            {item.titleLatex ? (
              <strong>
                <MathBlock source={item.titleLatex} />
              </strong>
            ) : item.name ? (
              // `name` is the fallback title and, like every other title field, may carry LaTeX —
              // several corpus records hold expressions in it. Rendering it as a bare string is what
              // leaves a learner looking at literal "$\binom{n}{k}$"; MathBlock renders plain prose
              // as text, so nothing is lost when a name has no math in it.
              <strong>
                <MathBlock source={item.name} />
              </strong>
            ) : null}
            {item.summaryLatex ? <MathBlock source={item.summaryLatex} /> : null}
            {item.bodyLatex ? <MathBlock source={item.bodyLatex} /> : null}
            {item.wrongLatex ? (
              <>
                <span className="wrong">Wrong: </span>
                <MathBlock source={item.wrongLatex} />
              </>
            ) : null}
            {item.whyLatex ? <MathBlock source={item.whyLatex} /> : null}
            {item.fixLatex ? <MathBlock source={item.fixLatex} /> : null}
          </li>
        ))}
      </ul>
    );
  }
  if (Array.isArray(section.examples) && section.examples.length) {
    body.push(
      <div key="examples" className="examples">
        {section.examples.map((example, index) => (
          <article key={example.id || index} className="example">
            {example.titleLatex ? <h4><MathBlock source={example.titleLatex} /></h4> : null}
            {example.figureKey ? (
              <Figure
                figureKey={example.figureKey}
                figureCacheKey={example.figureCacheKey}
                alt={example.asymptoteAlt}
              />
            ) : null}
            {example.bodyLatex ? <MathBlock source={example.bodyLatex} /> : null}
            {example.answerLatex ? (
              <details>
                <summary>Answer</summary>
                <MathBlock source={example.answerLatex} />
              </details>
            ) : null}
          </article>
        ))}
      </div>
    );
  }
  if (Array.isArray(section.figures) && section.figures.length) {
    body.push(
      <div key="figures" className="figures">
        {section.figures.map((reference, index) => (
          <FigureRef key={reference.figureKey || index} reference={reference} />
        ))}
      </div>
    );
  }

  if (!body.length) return null;
  return (
    <section className="lesson-section">
      <h3>{name}</h3>
      {body}
    </section>
  );
}

function ExerciseCard({ exercise }) {
  // A solution is behind a details element rather than rendered inline. It is in this payload
  // because the route serves it to an unlocked session; hiding it in the DOM would be security
  // theatre, and a learner who peeks is the learner's business, not a server guarantee.
  return (
    <article className="exercise">
      <p className="exercise__tier">Tier {exercise.tier} · difficulty {exercise.difficulty}</p>
      <MathBlock source={exercise.promptLatex} />
      {exercise.figureKey ? (
        <Figure
          figureKey={exercise.figureKey}
          figureCacheKey={exercise.figureCacheKey}
          alt={exercise.asymptoteAlt}
        />
      ) : null}
      {Array.isArray(exercise.choices) && exercise.choices.length ? (
        <ol className="exercise__choices">
          {exercise.choices.map((choice, index) => (
            <li key={index}>
              <MathBlock source={choice} />
            </li>
          ))}
        </ol>
      ) : null}
      {Array.isArray(exercise.hintLatex) && exercise.hintLatex.length ? (
        <details>
          <summary>Hint</summary>
          {exercise.hintLatex.map((hint, index) => (
            <MathBlock key={index} source={hint} />
          ))}
        </details>
      ) : null}
      {exercise.solutionLatex ? (
        <details>
          <summary>Solution</summary>
          {/* split on blank lines so a multi-paragraph solution does not render as one block */}
          {String(exercise.solutionLatex)
            .split(/\n{2,}/)
            .map((paragraph, index) => (
              <MathBlock key={index} source={paragraph} />
            ))}
        </details>
      ) : null}
    </article>
  );
}

function Lesson({ lessonId }) {
  const lesson = useApi(`/api/lessons/${encodeURIComponent(lessonId)}`);
  const practiceIds = lesson.data?.sections?.practice?.exerciseIds;
  const exercises = useApi(
    practiceIds && practiceIds.length
      ? `/api/exercises?ids=${encodeURIComponent(practiceIds.join(","))}`
      : null
  );

  if (lesson.status === "loading") return <p className="status">Loading {lessonId}…</p>;
  if (lesson.status === "error") {
    return <p className="status status--error">Could not load {lessonId}: {lesson.error}</p>;
  }

  const { id, title, moduleId, lock } = lesson.data;

  return (
    <article className="lesson">
      <header>
        <p className="lesson__crumbs">{moduleId}</p>
        <h2>
          <MathBlock source={title} />
        </h2>
        {lock?.blocked ? (
          <p className="status status--warn">
            Locked until {lock.unmetPrerequisites.join(", ")} is passed.
          </p>
        ) : null}
      </header>

      {Object.entries(lesson.data.sections || {}).map(([name, section]) => (
        <Section key={name} name={name} section={section} />
      ))}

      <section className="lesson-section">
        <h3>Practice</h3>
        {exercises.status === "loading" ? <p className="status">Loading exercises…</p> : null}
        {exercises.status === "error" ? (
          <p className="status status--error">Could not load exercises: {exercises.error}</p>
        ) : null}
        {exercises.status === "ready" && exercises.data.length === 0 ? (
          <p className="status">No exercises for {id} yet.</p>
        ) : null}
        {exercises.status === "ready" ? exercises.data.map((e) => <ExerciseCard key={e.id} exercise={e} />) : null}
      </section>
    </article>
  );
}

function ModuleList({ onPick }) {
  const modules = useApi("/api/modules");
  if (modules.status === "loading") return <p className="status">Loading modules…</p>;
  if (modules.status === "error") {
    return <p className="status status--error">Could not load modules: {modules.error}</p>;
  }
  return (
    <ul className="modules">
      {modules.data.map((module) => (
        <li key={module.id}>
          <button type="button" onClick={() => onPick(module.id)}>
            <MathBlock source={module.title || module.id} />
          </button>
          {module.title === null ? (
            <span className="status status--warn" title="No content/modules.json entry">
              untitled
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ModuleView({ moduleId, onPickLesson }) {
  const module = useApi(`/api/modules/${encodeURIComponent(moduleId)}`);
  if (module.status === "loading") return <p className="status">Loading {moduleId}…</p>;
  if (module.status === "error") {
    return <p className="status status--error">Could not load {moduleId}: {module.error}</p>;
  }
  return (
    <article className="module">
      <h2>
        <MathBlock source={module.data.module?.title || moduleId} />
      </h2>
      {module.data.lessons.length === 0 ? (
        <p className="status">No lessons in {moduleId} yet.</p>
      ) : (
        <ol className="lessons">
          {module.data.lessons.map((lesson) => (
            <li key={lesson.id}>
              <button type="button" onClick={() => onPickLesson(lesson.id)}>
                <MathBlock source={lesson.title} />
              </button>
              <span className="status">{lesson.exerciseCount} exercises</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

export default function App() {
  const [lessonId, setLessonId] = useState(null);
  const [moduleId, setModuleId] = useState(null);

  return (
    <main>
      <h1>Math Training App</h1>
      {lessonId ? (
        <>
          <button type="button" onClick={() => setLessonId(null)}>
            ← Modules
          </button>
          <Lesson lessonId={lessonId} />
        </>
      ) : moduleId ? (
        <>
          <button type="button" onClick={() => setModuleId(null)}>
            ← All modules
          </button>
          <ModuleView moduleId={moduleId} onPickLesson={setLessonId} />
        </>
      ) : (
        <ModuleList onPick={setModuleId} />
      )}
    </main>
  );
}
