const express = require("express");
const { NODE_ENV, PUBLIC_DIR } = require("./config");
const { createStatsCollector } = require("./stats");
const { initDatabase, getHistory } = require("./db/sqlite");
const { createMetricsRecorder } = require("./metrics/recorder");

function createApp() {
  const app = express();
  const statsCollector = createStatsCollector();
  initDatabase();
  const recorder = createMetricsRecorder(statsCollector, { intervalMs: 10_000 });
  recorder.start();

  app.use(express.static(PUBLIC_DIR));

  app.get("/api/stats", async (req, res) => {
    try {
      const stats = await statsCollector.getStats();
      res.json(stats);
    } catch (error) {
      console.error(error);
      const details = NODE_ENV === "production" ? undefined : error?.message;
      res.status(500).json({ error: "Error leyendo sistema", details });
    }
  });

  app.get("/api/history", async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 360;
      const rangeSeconds = Number(req.query.rangeSeconds) || null;
      const fromMs = Number.isFinite(rangeSeconds) && rangeSeconds > 0 ? Date.now() - rangeSeconds * 1000 : null;
      const rows = await getHistory({ limit, fromMs });
      res.json({ samples: rows });
    } catch (error) {
      console.error(error);
      const details = NODE_ENV === "production" ? undefined : error?.message;
      res.status(500).json({ error: "Error leyendo histórico", details });
    }
  });

  return app;
}

module.exports = {
  createApp,
};
