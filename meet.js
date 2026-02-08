console.log("Meet logger loaded (auto captions ON, summarize on end)");

let lastText = "";
let observer = null;
let captionsEnabled = false;

// 会議キー抽出（/xxx-xxxx-xxx）
function getMeetingKey(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

let currentMeetingKey = getMeetingKey(location.href);

function safeSend(type, payload = {}) {
  try {
    chrome.runtime.sendMessage({ type, meetingKey: currentMeetingKey, ...payload });
  } catch {
    // context invalidatedなどは無視
  }
}

// 字幕ONを自動クリック（UI言語差を吸収）
function tryEnableCaptions() {
  if (captionsEnabled) return;

  const buttons = Array.from(document.querySelectorAll("button"));
  const captionBtn = buttons.find((btn) => {
    const label = ((btn.getAttribute("aria-label") || "") + " " + (btn.innerText || "")).toLowerCase();
    return label.includes("字幕") || label.includes("caption");
  });

  if (captionBtn) {
    captionBtn.click();
    captionsEnabled = true;
    console.log("✅ Captions enabled automatically");
  }
}

function startObserver() {
  if (observer) observer.disconnect();

  observer = new MutationObserver(() => {
    try {
      // 字幕ボタンが出現するまで繰り返しONを試す
      tryEnableCaptions();

      // 字幕領域（日本語/英語どちらも）
      const region = document.querySelector(
        'div[role="region"][aria-label="字幕"], div[role="region"][aria-label="Captions"]'
      );
      if (!region) return;

      const current = region.innerText.replace(/\n+/g, " ").trim();
      if (!current || current === lastText) return;

      let diff = current;
      if (current.startsWith(lastText)) diff = current.slice(lastText.length).trim();

      if (diff) {
        safeSend("LOG", { text: diff });
        console.log("🗣 発言:", diff);
      }

      lastText = current;
    } catch (e) {
      console.warn("Observer error:", e.message);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// 会議終了を通知
function endMeeting(reason) {
  safeSend("END_MEETING", { reason: reason || "unknown" });
}

// タブ閉じ/リロード/遷移
window.addEventListener("beforeunload", () => endMeeting("beforeunload"));

// 「退出/通話終了」クリック検知（UI文言差を吸収）
document.addEventListener(
  "click",
  (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

    const label = ((btn.getAttribute("aria-label") || "") + " " + (btn.innerText || "")).trim();
    const patterns = [
      "通話を終了",
      "退出",
      "退出する",
      "Leave call",
      "Leave",
      "End call",
      "Hang up"
    ];

    if (patterns.some((p) => label.includes(p))) {
      endMeeting("hangup_click");
    }
  },
  true
);

// SPA遷移で会議IDが変わるケース
setInterval(() => {
  const mk = getMeetingKey(location.href);
  if (mk !== currentMeetingKey) {
    if (currentMeetingKey) endMeeting("meetingKey_changed");
    currentMeetingKey = mk;
    lastText = "";
    captionsEnabled = false;
  }
}, 1000);

// MeetはDOM生成が遅い
setTimeout(startObserver, 2000);
