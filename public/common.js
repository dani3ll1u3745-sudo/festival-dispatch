// Shared helpers for all pages.
window.FD = (() => {
  let audioCtx = null;

  // Phones only allow sound after a tap: call this from a button handler.
  function unlockAudio() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback'; // iOS 17+: play sound even when the silent switch is on
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      beep(1, 0.01); // near-silent blip to finish unlocking on iOS
    } catch (e) { console.warn('Audio unavailable', e); }
  }

  function beep(times = 3, volume = 0.4) {
    if (!audioCtx) return;
    for (let i = 0; i < times; i++) {
      const t = audioCtx.currentTime + i * 0.35;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(i % 2 ? 660 : 880, t);
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    }
    if (navigator.vibrate) navigator.vibrate([300, 120, 300, 120, 300]); // Android only
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const timeAgo = ts => {
    const s = Math.round((Date.now() - ts) / 1000);
    return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
  };

  return { unlockAudio, beep, esc, timeAgo };
})();
