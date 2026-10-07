import * as ort from './onnx/ort.wasm.min.mjs';
import { SIZE, decode } from './detection.mjs';
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('./onnx/', import.meta.url).href;
let session;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      session = await ort.InferenceSession.create(new URL('./models/fire-smoke.onnx', import.meta.url).href, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      const shape = session.inputMetadata[0].shape;
      if (shape.join(',') !== '1,3,320,320') throw new Error('Unexpected model input shape. Run npm run setup.');
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame' && session) {
      const started = performance.now();
      const tensor = new ort.Tensor('float32', data.pixels, [1, 3, SIZE, SIZE]);
      const outputs = await session.run({ [session.inputNames[0]]: tensor });
      const output = outputs[session.outputNames[0]];
      const boxes = decode(output.data, output.dims, data.transform, data.threshold);
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
