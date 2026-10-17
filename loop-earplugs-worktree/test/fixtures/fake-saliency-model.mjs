// Test double standing in for the AE_SALIENCY_COMMAND model: prints a fixed
// node_id -> {share, quartile} JSON map, mirroring the contract documented
// in src/saliency-worker.js. Exits 1 when the screenshot path contains
// 'missing' so tests can exercise the model-failure path.
const [screenshot] = process.argv.slice(2);
if (screenshot.includes('missing')) process.exit(1);
console.log(
  JSON.stringify({
    s1: { share: 0.6, quartile: 3 },
    'el:0': { share: 0.4, quartile: 2 },
  }),
);
