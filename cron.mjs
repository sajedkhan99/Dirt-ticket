// Runs the scrape every hour. Scheduled functions get 30 seconds, so runScrape
// budgets 22s and shards its work across runs.
import { runScrape } from "./api.mjs";

export default async () => {
  try { await runScrape({ budgetMs: 22000 }); }
  catch (e) { console.error("scrape failed:", e); }
};

export const config = { schedule: "@hourly" };
