"""Where models run: the GPU through DirectML (any DirectX 12 GPU on Windows, including AMD) when
available, otherwise the CPU. Set KENGINE_CPU=1 to force the CPU."""
from __future__ import annotations

import os
from pathlib import Path


def gpu_available() -> bool:
    if os.environ.get('KENGINE_CPU') == '1':
        return False
    try:
        import onnxruntime as ort
        return 'DmlExecutionProvider' in ort.get_available_providers()
    except ImportError:
        return False


def onnx_session(model: Path, gpu: bool = True):
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    providers = (['DmlExecutionProvider'] if gpu and gpu_available() else []) + ['CPUExecutionProvider']
    if 'DmlExecutionProvider' in providers:  # DirectML wants these
        opts.enable_mem_pattern = False
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return ort.InferenceSession(str(model), sess_options=opts, providers=providers)


def torch_device(gpu: bool = True):
    """A torch device: DirectML GPU when available."""
    if gpu and os.environ.get('KENGINE_CPU') != '1':
        try:
            import torch_directml
            return torch_directml.device()
        except ImportError:
            pass
    import torch
    return torch.device('cpu')
