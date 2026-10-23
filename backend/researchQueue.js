'use strict';

const { executeResearchRun } = require('./researchWorkflow');

// Keep site requests polite and prevent a bulk selection from spawning many
// crawlers at once. Runs are durable in MySQL; this queue only schedules work.
const MAX_CONCURRENT_RUNS = 2;
const START_DELAY_MS = 1000;
const pending = [];
let active = 0;
let lastStart = 0;
let timer = null;

function pump() {
  timer = null;
  if (active >= MAX_CONCURRENT_RUNS || pending.length === 0) return;
  const delay = Math.max(0, START_DELAY_MS - (Date.now() - lastStart));
  if (delay) {
    timer = setTimeout(pump, delay);
    return;
  }
  const run = pending.shift();
  active += 1;
  lastStart = Date.now();
  Promise.resolve(executeResearchRun(run))
    .catch((error) => console.error(`Research run ${run.id} failed: ${error.message}`))
    .finally(() => {
      active -= 1;
      if (pending.length && !timer) timer = setTimeout(pump, START_DELAY_MS);
    });
  if (pending.length && active < MAX_CONCURRENT_RUNS && !timer) {
    timer = setTimeout(pump, START_DELAY_MS);
  }
}

function enqueueResearch(run) {
  pending.push(run);
  if (!timer) timer = setTimeout(pump, 0);
}

module.exports = { enqueueResearch };
