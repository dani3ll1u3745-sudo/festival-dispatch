# Model provenance

`models/model.json` names the model the camera page loads (file, square input size, class order).

## Current: FASDD YOLO26n at 416 px

- Publisher: weslleyskah. Model card: https://huggingface.co/weslleyskah/fire_smoke_box
- Weights: `weights/best.pt` (YOLO26n, 2.4 M parameters, fine-tuned from `yolo26n.pt` at 640 px for 100 epochs).
  SHA-256 of the `.pt`: `d2b0be214f45fa01d2044b960c3cb4da4bf65c06a89cf0a1967b0d40e8db4b98`.
- Training data: FASDD_CV (Flame and Smoke Detection Dataset, computer-vision subset), a large and varied fire/smoke set.
- Local file: `models/fire-smoke-fasdd-416.onnx`, exported by `scripts/export-fire-model.py` (Ultralytics 8.4, opset 17, 416 × 416, simplified).
  SHA-256: `b3002ad219f228fdb872f88c8d38242fb42dd2c102f80387bb285571740f19de`.
- Input: float32 `[1, 3, 416, 416]`, RGB 0–1, letterboxed with pixel value 114.
- Output: `[1, 6, 3549]`: centre x/y, width/height, fire score, smoke score. Decoded with class-aware NMS at IoU 0.45.
- Classes: `{0: 'fire', 1: 'smoke'}` (read from the ONNX metadata).
- The `.pt` was checked before loading: its pickle imports only torch, ultralytics and Python built-ins.

## Why it replaced the previous model

Measured on a hand-labelled set of 44 Wikimedia Commons photos with visible flames and 95 without (stage lighting, haze, fireworks, orange tents, sunsets, neon, food trucks, fire stations), none from either model's training data. Fire counts as found when any fire box reaches the threshold.

| Model | Threshold | Fires found | False alarms | CPU, one thread |
|---|---|---|---|---|
| Previous: CCTV-AI YOLOv8n, 320 px | 0.50 (old default) | 61% | 2 / 95 | 50 ms |
| Previous: CCTV-AI YOLOv8n, 320 px | 0.25 | 95% | 18 / 95 | 50 ms |
| **FASDD YOLO26n, 416 px** | **0.30 (new default)** | **95%** | **1 / 95** | 63 ms |
| FASDD YOLO26n, 640 px | 0.30 | 93% | 1 / 95 | 144 ms |
| e1250 home-fire YOLO26n, 640 px | 0.30 | 27% | 11 / 95 | 145 ms |

416 px matches 640 px here at well under half the cost. The one remaining false alarm is a red-lit stage; over time the camera page's confirmation rule (fire must persist for 0.8 s) filters single-frame errors like this.

Previous model: fiacecson20/cctv-ai-fire-smoke (YOLOv8n, 320 px), https://huggingface.co/fiacecson20/cctv-ai-fire-smoke. It is still used by the separate `webcam-fire-detector` project.

## Runtime

ONNX Runtime Web 1.22 (`onnx/ort.webgpu.min.mjs` plus the JSEP WASM files). The worker uses the laptop's GPU through WebGPU when available and falls back to one-thread WASM on the CPU.

## Licences

The model card licenses the weights CC-BY-4.0. They are fine-tuned from Ultralytics YOLO26, which is AGPL-3.0; review both before redistribution or commercial deployment. ONNX Runtime is MIT.

The model is a third-party experimental detector, not a certified fire detector. The benchmark above is small; rehearse with your own camera, lighting and footage.
