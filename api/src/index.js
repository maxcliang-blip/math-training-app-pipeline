import { createApp } from "./app.js";

const app = createApp();

const port = process.env.PORT || 4000;
app.listen(port, () => {
  const { content, figures } = app.locals;
  console.log(`api listening on :${port}`);
  console.log(`  corpus: ${content.stats().lessons} lessons, ${content.stats().exercises} exercises, ${content.stats().modules} modules`);
  if (content.stats().warnings) console.warn(`  ${content.stats().warnings} content warnings; see GET /api/content/warnings`);
  console.log(
    figures
      ? `  figures: ${figures.usable ? `${figures.keys().length} compiled` : `unusable (${figures.manifest.status})`}`
      : "  figures: manifest unreadable",
  );
});
