/** 點一下開始說話，說完自動送出（VAD 靜音偵測）。
 *
 * 使用者唯一要做的動作就是點一次；之後：
 * 偵測到 ~1.4 秒靜音（或達 8 秒上限）→ 自動停止並回傳音檔。
 */

export interface TapToTalkOptions {
  /** 判定為靜音的 RMS 門檻（0～1），預設 0.015 */
  silenceThreshold?: number;
  /** 連續靜音多久視為說完（毫秒），預設 1400 */
  silenceMs?: number;
  /** 最短錄音（毫秒），避免手滑立刻結束，預設 800 */
  minMs?: number;
  /** 最長錄音（毫秒），預設 8000 */
  maxMs?: number;
}

export class TapToTalkRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private stopTimer: number | null = null;

  constructor(private options: TapToTalkOptions = {}) {}

  get isSupported(): boolean {
    return typeof navigator !== "undefined"
      && !!navigator.mediaDevices?.getUserMedia
      && typeof MediaRecorder !== "undefined"
      && window.isSecureContext;
  }

  get isRecording(): boolean {
    return this.mediaRecorder?.state === "recording";
  }

  /** 點一下 → 開始錄音；說完（靜音）自動 resolve 音檔。 */
  async record(onLevel?: (rms: number) => void): Promise<Blob> {
    if (!this.isSupported) {
      throw new Error("此環境無法錄音（需要 https 或 localhost），請改用文字輸入");
    }
    const { silenceThreshold = 0.015, silenceMs = 1400, minMs = 800, maxMs = 8000 } = this.options;

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    const recorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);
    this.mediaRecorder = recorder;
    recorder.ondataavailable = (e) => this.chunks.push(e.data);

    // VAD：AnalyserNode 每 100ms 量一次 RMS
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const startedAt = Date.now();
    let lastVoiceAt = Date.now();

    const done = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }));
    });

    const tick = () => {
      if (recorder.state !== "recording") return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      onLevel?.(rms);
      const elapsed = Date.now() - startedAt;
      if (rms > silenceThreshold) lastVoiceAt = Date.now();
      const silentFor = Date.now() - lastVoiceAt;
      if ((elapsed >= minMs && silentFor >= silenceMs) || elapsed >= maxMs) {
        this.stop();
        return;
      }
      this.stopTimer = window.setTimeout(tick, 100);
    };

    recorder.start();
    tick();
    return done;
  }

  stop(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.mediaRecorder?.state === "recording") this.mediaRecorder.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioContext?.close().catch(() => undefined);
    this.stream = null;
    this.audioContext = null;
  }
}
