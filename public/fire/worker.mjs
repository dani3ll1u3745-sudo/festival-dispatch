// Runs the fire model off the main thread. Uses the laptop's GPU through WebGPU when the browser has
// it (several times faster, so more frames are checked each second), and falls back to the CPU.
import * as ort from './onnx/ort.webgpu.min.mjs';
import { decode } from './detection.mjs';
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('./onnx/', import.meta.url).href;
let session, model;

async function createSession() {
  model = await fetch(new URL('./models/model.json', import.meta.url)).then(r => r.json());
  const url = new URL(`./models/${model.file}`, import.meta.url).href;
  const backends = [...(self.navigator?.gpu ? ['webgpu'] : []), 'wasm'];
  let lastError;
  for (const backend of backends) {
    try {
      session = await ort.InferenceSession.create(url, { executionProviders: [backend], graphOptimizationLevel: 'all' });
      return backend;
    } catch (error) { lastError = error; } // e.g. no usable GPU adapter: try the CPU
  }
  throw lastError;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const backend = await createSession();
      const shape = session.inputMetadata[0].shape;
      if (shape.join(',') !== `1,3,${model.size},${model.size}`) throw new Error('Unexpected model input shape. Check models/model.json.');
      self.postMessage({ type: 'ready', size: model.size, backend });
    } else if (data.type === 'frame' && session) {
      const started = performance.now();
      const tensor = new ort.Tensor('float32', data.pixels, [1, 3, model.size, model.size]);
      const outputs = await session.run({ [session.inputNames[0]]: tensor });
      const output = outputs[session.outputNames[0]];
      const boxes = decode(output.data, output.dims, data.transform, data.threshold, model.labels);
      tensor.dispose();
      Object.values(outputs).forEach(value => value.dispose());
      const ms = performance.now() - started;
      // MaydAI: pace here rather than with a page timer. Worker timers keep running when the
      // camera tab is in the background, so detection does not stall while someone checks another tab.
      if (data.minIntervalMs > ms) await new Promise(resolve => setTimeout(resolve, data.minIntervalMs - ms));
      self.postMessage({ type: 'result', boxes, ms, frame: data.frame });
    }
  } catch (error) { self.postMessage({ type: 'error', message: error.message || String(error) }); }
};
