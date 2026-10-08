"""Rebuild public/fire/models/fire-smoke-fasdd-416.onnx from the published weights (see public/fire/MODEL.md).

Needs Python with: pip install ultralytics onnx onnxslim  (CPU PyTorch is enough)
Run from festival-dispatch:  python scripts/export-fire-model.py
"""
import hashlib, pathlib, shutil, tempfile, urllib.request
from ultralytics import YOLO

URL = 'https://huggingface.co/weslleyskah/fire_smoke_box/resolve/main/weights/best.pt'
PT_SHA256 = 'd2b0be214f45fa01d2044b960c3cb4da4bf65c06a89cf0a1967b0d40e8db4b98'
SIZE = 416
OUT = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'fire' / 'models' / f'fire-smoke-fasdd-{SIZE}.onnx'

with tempfile.TemporaryDirectory() as tmp:
    pt = pathlib.Path(tmp) / 'fasdd.pt'
    urllib.request.urlretrieve(URL, pt)
    digest = hashlib.sha256(pt.read_bytes()).hexdigest()
    # The checksum matters: a .pt file is a pickle, and loading one runs code.
    if digest != PT_SHA256:
        raise SystemExit(f'Checksum mismatch ({digest}); not loading the weights.')
    onnx = YOLO(str(pt)).export(format='onnx', imgsz=SIZE, opset=17, simplify=True, dynamic=False)
    shutil.copy(onnx, OUT)
print('wrote', OUT)
