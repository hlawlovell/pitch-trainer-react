"""Sung pitch with RMVPE (robust vocal pitch estimation, trained for singing in a mix).

Runs the ONNX model on the GPU through DirectML when available. Preprocessing follows the reference
implementation used by RVC: 16 kHz mono, 128-band log-mel (n_fft 1024, hop 160 = 10 ms, 30–8000 Hz,
HTK mel scale), output = 360 bins of 20 cents each; the pitch is a weighted average around the
strongest bin.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .devices import onnx_session

SR = 16000
HOP = 160
N_FFT = 1024
CENTS = 20 * np.arange(360) + 1997.3794084376191  # bin -> cents above 10 Hz


@dataclass
class PitchTrack:
    times: np.ndarray       # seconds
    hz: np.ndarray          # 0 where nothing is sung
    confidence: np.ndarray  # 0..1 (salience of the chosen bin)

    def to_json(self) -> dict:
        return {'times': self.times.round(4).tolist(), 'frequencies': self.hz.round(2).tolist(),
                'confidence': self.confidence.round(3).tolist()}


_mel = None


def _mel_basis():
    global _mel
    if _mel is None:
        import librosa
        _mel = librosa.filters.mel(sr=SR, n_fft=N_FFT, n_mels=128, fmin=30, fmax=8000, htk=True).astype(np.float32)
    return _mel


def log_mel(audio: np.ndarray) -> np.ndarray:
    """(128, frames) log-mel of 16 kHz mono audio."""
    import librosa
    spec = np.abs(librosa.stft(audio, n_fft=N_FFT, hop_length=HOP, win_length=N_FFT, window='hann',
                               center=True, pad_mode='reflect'))
    return np.log(np.clip(_mel_basis() @ spec, 1e-5, None)).astype(np.float32)


def decode(salience: np.ndarray, threshold: float = 0.03) -> tuple[np.ndarray, np.ndarray]:
    """Salience (frames, 360) -> (Hz, confidence): weighted average of the 9 bins around the peak."""
    peak = salience.argmax(axis=1)
    conf = salience[np.arange(len(peak)), peak]
    pad = np.pad(salience, ((0, 0), (4, 4)))
    idx = peak[:, None] + np.arange(9)[None, :]               # window in padded coordinates
    w = np.take_along_axis(pad, idx, axis=1)
    c = np.take_along_axis(np.pad(CENTS, (4, 4)), idx.ravel(), axis=0).reshape(idx.shape)
    cents = (w * c).sum(1) / np.maximum(w.sum(1), 1e-9)
    hz = 10 * 2 ** (cents / 1200)
    hz[conf < threshold] = 0
    return hz.astype(np.float32), conf.astype(np.float32)


_session = None


def track(audio: np.ndarray, sr: int, model: Path, gpu: bool = True, chunk_s: float = 30.0) -> PitchTrack:
    """Pitch of a (vocals) recording. Long audio is processed in overlapping chunks to bound GPU memory."""
    global _session
    import librosa
    if audio.ndim > 1:
        audio = audio.mean(axis=0 if audio.shape[0] < audio.shape[1] else 1)
    if sr != SR:
        audio = librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=SR)
    if _session is None:
        _session = onnx_session(model, gpu)
    mel = log_mel(audio)
    n = mel.shape[1]
    step = int(chunk_s * SR / HOP)
    ctx = 64  # frames of context on each side of a chunk (the model looks around each frame)
    out = np.zeros((n, 360), np.float32)
    for a in range(0, n, step):
        lo, hi = max(0, a - ctx), min(n, a + step + ctx)
        m = mel[:, lo:hi]
        pad = (-m.shape[1]) % 32                              # the model needs a multiple of 32 frames
        m = np.pad(m, ((0, 0), (0, pad)), mode='constant', constant_values=np.log(1e-5))
        sal = _session.run(None, {'input': m[None]})[0][0][: hi - lo]
        out[a:min(n, a + step)] = sal[a - lo: a - lo + min(step, n - a)]
    hz, conf = decode(out)
    return PitchTrack(np.arange(n) * HOP / SR, hz, conf)
