/** 按住錄音。放開後回傳 audio Blob（webm/ogg，依瀏覽器支援）。
 *
 * 注意：getUserMedia 只在安全情境可用（https 或 localhost）。
 * 手機經 LAN IP 開啟時必須走 https 隧道，否則麥克風會被瀏覽器封鎖
 * ——這種情況請改用文字輸入（呼叫端要提供文字備援）。
 */

export class PressToTalkRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  get isSupported(): boolean {
    return typeof navigator !== "undefined"
      && !!navigator.mediaDevices?.getUserMedia
      && typeof MediaRecorder !== "undefined"
      && window.isSecureContext;
  }

  async start(): Promise<void> {
    if (!this.isSupported) {
      throw new Error("此環境無法錄音（需要 https 或 localhost），請改用文字輸入");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);
    this.mediaRecorder.ondataavailable = (e) => this.chunks.push(e.data);
    this.mediaRecorder.start();
  }

  async stop(): Promise<Blob> {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state !== "recording") {
      throw new Error("沒有進行中的錄音");
    }
    const done = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.mediaRecorder = null;
    return new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
  }

  /** 把「按住說話」手勢綁到按鈕上；放開時把 Blob 交給 onAudio。 */
  bindButton(button: HTMLElement, callbacks: {
    onStart?: () => void;
    onAudio: (audio: Blob) => void;
    onError: (err: Error) => void;
  }): void {
    const start = async (e: Event) => {
      e.preventDefault();
      try {
        await this.start();
        callbacks.onStart?.();
      } catch (err) {
        callbacks.onError(err as Error);
      }
    };
    const stop = async (e: Event) => {
      e.preventDefault();
      if (!this.mediaRecorder) return;
      try {
        callbacks.onAudio(await this.stop());
      } catch (err) {
        callbacks.onError(err as Error);
      }
    };
    button.addEventListener("mousedown", start);
    button.addEventListener("touchstart", start, { passive: false });
    button.addEventListener("mouseup", stop);
    button.addEventListener("mouseleave", stop);
    button.addEventListener("touchend", stop);
  }
}
