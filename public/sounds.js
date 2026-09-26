// Weapon sound effects, synthesized with the Web Audio API so the page needs no audio files.
// effects.js calls these; nothing plays until the viewer has clicked (browsers require it).
'use strict';

(function () {
  const STORAGE_KEY = 'weapon-sound';
  const rand = (min, max) => min + Math.random() * (max - min);

  let ac = null;
  let master = null;
  let noise = null;
  let enabled = true;
  try {
    enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Storage can be unavailable (private windows, sandboxed previews); default to on.
  }

  function audio() {
    if (!enabled) return null;
    if (!ac) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return null;
      ac = new AudioContext();
      // A limiter keeps overlapping sounds (rapid gunfire) from distorting.
      const limiter = ac.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.1;
      master = ac.createGain();
      master.gain.value = 0.6;
      master.connect(limiter).connect(ac.destination);
      noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  function envelope(param, t, attack, peak, decay) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // A burst of filtered noise: thuds, splats, cracks and blasts are all built from these.
  function noiseBurst({ at = 0, type = 'lowpass', freq = 1000, to, q = 1, peak = 0.5, attack = 0.002, decay = 0.1 }) {
    const t = ac.currentTime + at;
    const src = ac.createBufferSource();
    src.buffer = noise;
    const filter = ac.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t);
    if (to) filter.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    const gain = ac.createGain();
    envelope(gain.gain, t, attack, peak, decay);
    src.connect(filter).connect(gain).connect(master);
    src.start(t, rand(0, 1));
    src.stop(t + attack + decay + 0.05);
  }

  function tone({ at = 0, type = 'sine', from, to, peak = 0.5, attack = 0.003, decay = 0.2 }) {
    const t = ac.currentTime + at;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    const gain = ac.createGain();
    envelope(gain.gain, t, attack, peak, decay);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  function glassCrack(count, at = 0.01) {
    for (let i = 0; i < count; i++) {
      noiseBurst({ at: at + rand(0, 0.07), type: 'bandpass', freq: rand(2500, 7000), q: rand(2, 6), peak: rand(0.15, 0.35), decay: rand(0.015, 0.05) });
    }
  }

  const once = {
    // `hits` is how many times the picture has been hit; the sound escalates with it.
    hammer(hits, { shattering = false, bigSmash = false } = {}) {
      if (!audio()) return;
      tone({ from: bigSmash ? 140 : 170, to: 40, peak: bigSmash ? 1 : 0.9, decay: bigSmash ? 0.3 : 0.18 });
      noiseBurst({ type: 'lowpass', freq: 1400, to: 300, peak: 0.6, decay: 0.09 });
      noiseBurst({ type: 'highpass', freq: 3000, peak: 0.25, decay: 0.02 }); // Metal on glass.
      glassCrack(2 + Math.min(hits, 5) * 2);
      if (shattering) {
        // Glass breaking away, then pieces tinkling down.
        noiseBurst({ type: 'highpass', freq: 2500, to: 6000, peak: bigSmash ? 0.5 : 0.3, decay: bigSmash ? 0.35 : 0.18 });
        const tinkles = bigSmash ? 14 : 3 + Math.min(hits - 5, 8);
        for (let i = 0; i < tinkles; i++) {
          tone({ at: rand(0.05, bigSmash ? 0.7 : 0.4), type: 'triangle', from: rand(2500, 6000), peak: rand(0.03, 0.08), attack: 0.001, decay: rand(0.04, 0.12) });
        }
      }
    },

    whoosh(duration) {
      if (!audio()) return;
      noiseBurst({ type: 'bandpass', freq: 350, to: 1800, q: 1.2, peak: 0.22, attack: duration * 0.75, decay: duration * 0.3 });
    },

    shoe() {
      if (!audio()) return;
      tone({ from: 130, to: 55, peak: 0.8, decay: 0.12 });
      noiseBurst({ type: 'lowpass', freq: 900, to: 200, peak: 0.55, attack: 0.001, decay: 0.09 }); // Slap.
      noiseBurst({ at: 0.02, type: 'bandpass', freq: 600, q: 0.8, peak: 0.2, decay: 0.12 }); // Dirt.
    },

    egg() {
      if (!audio()) return;
      noiseBurst({ type: 'highpass', freq: 3500, peak: 0.3, attack: 0.001, decay: 0.03 }); // Shell.
      noiseBurst({ type: 'bandpass', freq: 1600, to: 250, q: 2.5, peak: 0.7, decay: 0.2 }); // Splat.
      noiseBurst({ at: 0.06, type: 'lowpass', freq: 900, to: 300, peak: 0.3, decay: 0.14 }); // Drip.
    },

    gun() {
      if (!audio()) return;
      noiseBurst({ type: 'lowpass', freq: 6000, to: 350, peak: 0.8, attack: 0.001, decay: 0.42 });
      tone({ from: 110, to: 32, peak: 0.8, attack: 0.001, decay: 0.3 });
      noiseBurst({ at: 0.03, type: 'lowpass', freq: 900, to: 200, peak: 0.25, decay: 0.7 }); // Echo.
    },
  };

  // Sounds that run while the viewer drags: start(), then speed() on each move, then stop().
  function continuous(build) {
    let voice = null;
    return {
      start() {
        if (voice || !audio()) return;
        voice = build();
      },
      speed(v) {
        if (voice) voice.speed(Math.min(1, v));
      },
      stop() {
        if (!voice) return;
        voice.stop();
        voice = null;
      },
    };
  }

  function voiceOutput(peak) {
    const t = ac.currentTime;
    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(peak, t + 0.06);
    out.connect(master);
    return out;
  }

  function stopVoice(out, sources) {
    const t = ac.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setTargetAtTime(0.0001, t, 0.05);
    for (const s of sources) s.stop(t + 0.3);
  }

  const saw = continuous(() => {
    const out = voiceOutput(0.3);
    const t = ac.currentTime;

    // Two-stroke engine: a buzzy oscillator chopped by a fast LFO.
    const engine = ac.createOscillator();
    engine.type = 'sawtooth';
    engine.frequency.value = 75;
    const engine2 = ac.createOscillator();
    engine2.type = 'square';
    engine2.frequency.value = 151;
    const engineGain = ac.createGain();
    engineGain.gain.value = 0.5;
    const chop = ac.createOscillator();
    chop.frequency.value = 28;
    const chopDepth = ac.createGain();
    chopDepth.gain.value = 0.3;
    chop.connect(chopDepth).connect(engineGain.gain);
    const muffle = ac.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 1400;
    engine.connect(engineGain);
    engine2.connect(engineGain);
    engineGain.connect(muffle).connect(out);

    // Chain rasp, louder while cutting.
    const rasp = ac.createBufferSource();
    rasp.buffer = noise;
    rasp.loop = true;
    const raspFilter = ac.createBiquadFilter();
    raspFilter.type = 'bandpass';
    raspFilter.frequency.value = 2600;
    raspFilter.Q.value = 0.9;
    const raspGain = ac.createGain();
    raspGain.gain.value = 0.15;
    rasp.connect(raspFilter).connect(raspGain).connect(out);

    const sources = [engine, engine2, chop, rasp];
    for (const s of sources) s.start(t);
    return {
      speed(v) {
        const now = ac.currentTime;
        for (const [param, idle, revved] of [
          [engine.frequency, 75, 150],
          [engine2.frequency, 151, 302],
          [chop.frequency, 28, 50],
          [raspGain.gain, 0.15, 0.6],
        ]) {
          param.cancelScheduledValues(now);
          param.setTargetAtTime(idle + (revved - idle) * v, now, 0.04);
          param.setTargetAtTime(idle, now + 0.12, 0.2); // Settles back to idle when the drag pauses.
        }
      },
      stop: () => stopVoice(out, sources),
    };
  });

  const pen = continuous(() => {
    const out = voiceOutput(1);
    const scratch = ac.createBufferSource();
    scratch.buffer = noise;
    scratch.loop = true;
    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 3800;
    filter.Q.value = 1.4;
    const gain = ac.createGain();
    gain.gain.value = 0.0001;
    scratch.connect(filter).connect(gain).connect(out);
    scratch.start(ac.currentTime);
    return {
      speed(v) {
        const now = ac.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0.03 + 0.45 * v, now, 0.02);
        gain.gain.setTargetAtTime(0.0001, now + 0.06, 0.05); // Silent while the pen rests.
        filter.frequency.setTargetAtTime(3000 + 2000 * v, now, 0.03);
      },
      stop: () => stopVoice(out, [scratch]),
    };
  });

  function setEnabled(on) {
    enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      // Not remembered; the choice still applies for this visit.
    }
    if (!on) {
      saw.stop();
      pen.stop();
    }
  }

  window.WeaponSounds = { ...once, saw, pen, setEnabled, isEnabled: () => enabled };
})();
