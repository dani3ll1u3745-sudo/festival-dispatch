# Model provenance

- Publisher: fiacecson20 / CCTV-AI.
- Source: https://huggingface.co/fiacecson20/cctv-ai-fire-smoke
- Upstream source and training details: https://github.com/fiacecson20/CCTV-AI
- Revision: `343990e42d99a5d27e9f35fc7c80880dc5f43f45`.
- Original filename: `best.onnx`; local name: `public/models/fire-smoke.onnx`.
- SHA-256: `f2699b753e78be8d392bfa63e64bf102ea3ceb8b6086a59dfd8192b61a0c6fad`.
- Input: float32 `[1, 3, 320, 320]`, normalized RGB, letterboxed with pixel value 114.
- Output: `[1, 6, 2100]`, centre x/y, width/height, fire confidence, smoke confidence. No objectness channel and no built-in NMS.
- Verified ONNX names: `{0: 'fire', 1: 'smoke'}`.
- Decoder: class-aware NMS at IoU 0.45; default minimum confidence 0.50.

## Upstream notices

The model card labels the published weights MIT and the training dataset CC-BY 4.0, and also notes the Ultralytics base model's AGPL-3.0 license. The downloaded ONNX metadata identifies its license as AGPL-3.0. Preserve these notices and review the upstream licensing before redistribution or commercial deployment; this project does not relabel the model as permissively licensed.

- Model card: https://huggingface.co/fiacecson20/cctv-ai-fire-smoke/blob/343990e42d99a5d27e9f35fc7c80880dc5f43f45/README.md
- Ultralytics license: https://github.com/ultralytics/ultralytics/blob/main/LICENSE
- ONNX Runtime (MIT): https://github.com/microsoft/onnxruntime/blob/main/LICENSE

The model is a third-party experimental baseline, not a certified fire detector. Its card reports only 29 smoke validation instances. No validation metrics from the publisher should be interpreted as this application's measured performance on your webcam.
