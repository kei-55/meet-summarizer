// meet.js
console.log("Meet logger loaded (auto captions ON)");

function getMeetingKey() {
  // https://meet.google.com/xxx-xxxx-xxx
  const m = location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return m?.[1] || location.pathname.replace(/\W+/g, "_") || "unknown";
}

let observer = null;
let ended = false;

// 現在の発言者と発言テキストを追跡
let currentSpeaker = "";
let currentText = "";
let lastRawText = ""; // 変化検知用（改行保持）

// -----------------------------
// 1) 字幕ONを自動化（ベータ）
// -----------------------------
let captionsTried = false;

function isButtonPressed(btn) {
  const ap = btn.getAttribute("aria-pressed");
  if (ap === "true") return true;
  if (ap === "false") return false;
  return false;
}

function findCaptionsButton() {
  const candidates = Array.from(
    document.querySelectorAll('button[aria-label], div[role="button"][aria-label]')
  );

  const keywords = [
    "字幕",
    "キャプション",
    "captions",
    "caption",
    "subtitles",
    "subtitle"
  ];

  for (const el of candidates) {
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    if (!label) continue;
    const hit = keywords.some(k => label.includes(k.toLowerCase()));
    if (!hit) continue;
    return el;
  }
  return null;
}

function tryEnableCaptionsOnce() {
  if (captionsTried) return false;

  const btn = findCaptionsButton();
  if (!btn) return false;

  const pressed = isButtonPressed(btn);
  if (pressed === true) {
    captionsTried = true;
    console.log("🟩 captions already ON");
    return true;
  }

  if (pressed === false) {
    captionsTried = true;
    btn.click();
    console.log("🟨 captions button clicked (try ON)");
    return true;
  }

  captionsTried = true;
  btn.click();
  console.log("🟧 captions button clicked (no aria-pressed, best-effort)");
  return true;
}

function startCaptionsAutoOn() {
  const maxTries = 12;
  let tries = 0;

  const timer = setInterval(() => {
    tries++;
    const ok = tryEnableCaptionsOnce();
    if (ok || tries >= maxTries) {
      clearInterval(timer);
      if (!ok) console.log("⚠ captions auto-on: button not found (UI changed?)");
    }
  }, 2500);
}

// -----------------------------
// 2) 字幕領域からログ収集
// -----------------------------
function findCaptionRegion() {
  const ja = document.querySelector('div[role="region"][aria-label="字幕"]');
  if (ja) return ja;
  const en = document.querySelector('div[role="region"][aria-label="Captions"]');
  if (en) return en;
  return null;
}

// 改行付きのテキストからスピーカーと発言を分離
function parseSpeakerAndText(rawText) {
  const lines = rawText.split("\n").map(l => l.trim()).filter(Boolean);

  if (lines.length >= 2) {
    const speaker = lines[0];
    const text = lines.slice(1).join(" ");
    return { speaker, text };
  }

  const m = rawText.match(/^(.{1,40})[:：]\s*(.+)$/s);
  if (m) {
    return { speaker: m[1].trim(), text: m[2].trim() };
  }

  return { speaker: "", text: rawText.trim() };
}

// 直前のスピーカーの発言をログ送信
function flushUtterance() {
  if (!currentText) return;
  console.log("🗣 flush:", currentSpeaker || "-", currentText);
  chrome.runtime.sendMessage({
    type: "LOG",
    meetingKey: getMeetingKey(),
    text: currentText,
    speaker: currentSpeaker
  });
  currentText = "";
}

function startObserver() {
  if (observer) observer.disconnect();

  observer = new MutationObserver(() => {
    try {
      const region = findCaptionRegion();
      if (!region) return;

      // 改行を保持したまま取得（スピーカー解析に使う）
      const rawText = region.innerText.trim();

      if (!rawText) {
        // 字幕がクリアされた → 発言完了として保存
        if (currentText) flushUtterance();
        lastRawText = "";
        return;
      }

      if (rawText === lastRawText) return;
      lastRawText = rawText;

      const { speaker, text } = parseSpeakerAndText(rawText);
      if (!text) return;

      if (speaker !== currentSpeaker) {
        // スピーカーが変わった → 前の発言を保存
        flushUtterance();
        currentSpeaker = speaker;
      }

      // 現在のスピーカーの最新テキストを更新（Meetは発言中も全文を表示する）
      currentText = text;
    } catch (e) {
      console.warn("Observer error:", e.message);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// -----------------------------
// 3) 会議終了検知 → 自動要約
// -----------------------------
function detectEnded() {
  const inCall = !!document.querySelector(
    '[aria-label*="通話を終了"],[aria-label*="退出"],[data-tooltip-id*="hangup"],[aria-label*="Leave call"],[aria-label*="End call"]'
  );

  if (!inCall && !ended) {
    ended = true;

    // 残っている発言を保存してから終了通知
    flushUtterance();

    const meetingKey = getMeetingKey();
    console.log("📞 meeting ended detected:", meetingKey);

    chrome.runtime.sendMessage({ type: "MEETING_ENDED", meetingKey }, (res) => {
      console.log("✅ finalize result:", res);
    });
  }
}

function startEndWatcher() {
  setInterval(detectEnded, 3000);
}

// -----------------------------
// 起動
// -----------------------------
setTimeout(() => {
  startCaptionsAutoOn();
  startObserver();
  startEndWatcher();
}, 2000);

// ページ離脱でも終了扱い（保険）
window.addEventListener("beforeunload", () => {
  if (ended) return;
  ended = true;
  flushUtterance();
  chrome.runtime.sendMessage({ type: "MEETING_ENDED", meetingKey: getMeetingKey() });
});
