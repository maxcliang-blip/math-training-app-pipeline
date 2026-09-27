import express from "express";

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Lesson + exercise routes land with the backend implementation task.
app.use("/api/lessons", (_req, res, next) => next());

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`api listening on :${port}`));
