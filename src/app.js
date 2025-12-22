const express = require("express");

const { NODE_ENV, PUBLIC_DIR } = require("./config");
const { createStatsCollector } = require("./stats");

function createApp() {
  const app = express();
  const statsCollector = createStatsCollector();

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

  return app;
}

module.exports = {
  createApp,
};
