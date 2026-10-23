'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('research queue limits concurrent crawls and spaces starts', async () => {
  let active = 0;
  let maximum = 0;
  const started = [];
  const completed = [];
  const workflowPath = require.resolve('../researchWorkflow');
  require.cache[workflowPath] = {
    id: workflowPath,
    filename: workflowPath,
    loaded: true,
    exports: {
      executeResearchRun: async (run) => {
        active += 1;
        maximum = Math.max(maximum, active);
        started.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 1400));
        active -= 1;
        completed.push(run.id);
      },
    },
  };
  const { enqueueResearch } = require('../researchQueue');
  [1, 2, 3].forEach((id) => enqueueResearch({ id }));
  const deadline = Date.now() + 6000;
  while (completed.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(completed.sort(), [1, 2, 3]);
  assert.ok(maximum <= 2);
  assert.ok(started[1] - started[0] >= 950);
  assert.ok(started[2] - started[1] >= 950);
});
