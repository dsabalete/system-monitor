const path = require("path");

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PORT = numberFromEnv("PORT", 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const COMMAND_TIMEOUT_MS = numberFromEnv("COMMAND_TIMEOUT_MS", 2000);
const PUBLIC_IP_TIMEOUT_MS = numberFromEnv("PUBLIC_IP_TIMEOUT_MS", 3000);
const TRANSMISSION_URL = process.env.TRANSMISSION_URL || "";
const TRANSMISSION_USERNAME = process.env.TRANSMISSION_USERNAME || "";
const TRANSMISSION_PASSWORD = process.env.TRANSMISSION_PASSWORD || "";
const TRANSMISSION_TIMEOUT_MS = numberFromEnv("TRANSMISSION_TIMEOUT_MS", 3000);

module.exports = {
  COMMAND_TIMEOUT_MS,
  NODE_ENV,
  PORT,
  PUBLIC_DIR,
  PUBLIC_IP_TIMEOUT_MS,
  TRANSMISSION_URL,
  TRANSMISSION_USERNAME,
  TRANSMISSION_PASSWORD,
  TRANSMISSION_TIMEOUT_MS,
};
