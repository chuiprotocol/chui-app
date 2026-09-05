/** 點一下開始說話，說完自動送出（VAD 靜音偵測）。
 *
 * v2（修「句首／句尾漏聽」與「不即時」）：
 * - 麥克風「常駐」：getUserMedia 與 AudioContext 只開一次，之後每輪
 *   錄音零啟動延遲——舊版每輪重開麥要幾百 ms，用戶先開口的字全漏。
 * - 錄音上限 8s→20s：長句（一次點多樣）不再被硬切掉尾巴。
 * - 靜音門檻 0.015→0.012、判定 1400→1200ms：小聲的字尾不被誤判成
 *   靜音提前切斷，說完到送出也快 200ms。
 * - 開麥帶 echoCancellation：Agent 的聲音先消掉一層（配合上層回音過濾）。
 */

export interface TapToTalkOptions {
  /** 判定為靜音的 RMS 門檻（0～1），預設 0.012 */
  silenceThreshold?: number;
  /** 連續靜音多久視為說完（毫秒），預設 1200 */
  silenceMs?: number;
  /** 最短錄音（毫秒），避免手滑立刻結束，預設 500 */
  minMs?: number;
  /** 最長錄音（毫秒），預設 20000 */
  maxMs?: number;
}

export class TapToTalkRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stopTimer: number | null = null;
  private hadVoice = false;

  constructor(private options: TapToTalkOptions = {}) {}

  /** 上一段錄音期間是否真的有人聲（超過靜音門檻）——沒有就別送辨識。 */
  get voiceDetected(): boolean {
    return this.hadVoice;
  }

  get isSupported(): boolean {
    return typeof navigator !== "undefined"
      && !!navigator.mediaDevices?.getUserMedia
      && typeof MediaRecorder !== "undefined"
      && window.isSecureContext;
  }

  get isRecording(): boolean {
    return this.mediaRecorder?.state === "recording";
  }

  /** 常駐中的麥克風串流（barge-in 監聽可共用，避免 iOS 重複開麥衝突）。 */
  get liveStream(): MediaStream | null {
    return this.stream?.getTracks().some((t) => t.readyState === "live") ? this.stream : null;
  }

  /** 開（或沿用）常駐麥克風＋分析器——每輪錄音零啟動延遲的關鍵。 */
  private async ensureStream(): Promise<{ stream: MediaStream; analyser: AnalyserNode }> {
    if (this.liveStream && this.audioContext && this.analyser) {
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume().catch(() => undefined);
      }
      return { stream: this.stream!, analyser: this.analyser };
    }
    this.releaseMic(); // 清掉半死的舊資源再重開
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.audioContext = new AudioContext();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.audioContext.createMediaStreamSource(this.stream).connect(this.analyser);
    return { stream: this.stream, analyser: this.analyser };
  }

  /** 點一下 → 開始錄音；說完（靜音）自動 resolve 音檔。 */
  async record(onLevel?: (rms: number) => void): Promise<Blob> {
    if (!this.isSupported) {
      throw new Error("此環境無法錄音（需要 https 或 localhost），請改用文字輸入");
    }
    const { silenceThreshold = 0.012, silenceMs = 1200, minMs = 500, maxMs = 20000 } = this.options;

    const { stream, analyser } = await this.ensureStream();
    this.chunks = [];
    this.hadVoice = false;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    this.mediaRecorder = recorder;
    recorder.ondataavailable = (e) => this.chunks.push(e.data);

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
      if (rms > silenceThreshold) {
        lastVoiceAt = Date.now();
        this.hadVoice = true;
      }
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

  /** 停止本輪錄音（麥克風保持常駐，下一輪零延遲）。 */
  stop(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.mediaRecorder?.state === "recording") this.mediaRecorder.stop();
    this.mediaRecorder = null;
  }

  private releaseMic(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioContext?.close().catch(() => undefined);
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
  }

  /** 真正關閉麥克風（關面板／結束對話時呼叫——瀏覽器的錄音指示燈熄滅）。 */
  release(): void {
    this.stop();
    this.releaseMic();
  }
}
