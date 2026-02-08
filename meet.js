// meet.js
console.log("Meet logger loaded (auto captions ON)");

function getMeetingKey() {
  // https://meet.google.com/xxx-xxxx-xxx
  const m = location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return m?.[1] || location.pathname.replace(/\W+/g, "_") || "unknown";
}

let lastText = "";
let observer = null;
let ended = false;

// -----------------------------
// 1) 字幕ONを自動化（ベータ）
// -----------------------------
let captionsTried = false;

function isButtonPressed(btn) {
  // Meetは aria-pressed を使うことが多い
  const ap = btn.getAttribute("aria-pressed");
  if (ap === "true") return true;
  if (ap === "false") return false;

  // たまに data-is-muted 的な属性や class で表すケースもあるが、
  // ここでは雑に「押されてそう」判定はしない（誤爆防止）
  return false;
}

function findCaptionsButton() {
  // Meetの字幕ボタン候補を幅広く拾う（日本語/英語混在対策）
  // 例: aria-label="字幕" / "字幕をオンにする" / "Turn on captions" など
  const candidates = Array.from(
    document.querySelectorAll('button[aria-label], div[role="button"][aria-label]')
  );

  const keywords = [
    "字幕",          // ja
    "キャプション",  // ja
    "captions",      // en
    "caption",       // en
    "subtitles",     // en
    "subtitle"       // en
  ];

  for (const el of candidates) {
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    if (!label) continue;

    const hit = keywords.some(k => label.includes(k.toLowerCase()));
    if (!hit) continue;

    // 「字幕」っぽいものを見つけた。Meetのボタンは button か role=button が多い
    return el;
  }
  return null;
}

function tryEnableCaptionsOnce() {
  if (captionsTried) return false;

  const btn = findCaptionsButton();
  if (!btn) return false;

  // 既にONなら触らない
  const pressed = isButtonPressed(btn);
  if (pressed === true) {
    captionsTried = true;
    console.log("🟩 captions already ON");
    return true;
  }

  // OFFが明確ならクリックしてONを試す
  if (pressed === false) {
    captionsTried = true;
    btn.click();
    console.log("🟨 captions button clicked (try ON)");
    return true;
  }

  // aria-pressed が無い場合は誤爆を避けたいが、個人用途なら押してみる選択肢もある
  // ただし「字幕設定」など別ボタンを押す可能性があるので、ここでは 1回だけ試す
  captionsTried = true;
  btn.click();
  console.log("🟧 captions button clicked (no aria-pressed, best-effort)");
  return true;
}

function startCaptionsAutoOn() {
  // 会議画面のDOMが落ち着くまで何回か試す
  const maxTries = 12;       // 約30秒
  let tries = 0;

  const timer = setInterval(() => {
    tries++;

    // 会議に入る前の画面だとボタンが無いことが多いので、入室後に出てくるまで待つ
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
  // 日本語UI: aria-label="字幕"
  // UI言語差分があるので複数候補で拾う
  const ja = document.querySelector('div[role="region"][aria-label="字幕"]');
  if (ja) return ja;

  // 英語UIなど：aria-label="Captions"
  const en = document.querySelector('div[role="region"][aria-label="Captions"]');
  if (en) return en;

  // 最後の手段：regionでテキストが頻繁に変わる領域（誤検知しやすいので弱め）
  return null;
}

function parseSpeakerAndText(fullText, diffText) {
  const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);

  if (lines.length >= 2) {
    const speaker = lines[0];
    const spoken = lines.slice(1).join(" ");
    const text = (diffText === fullText) ? spoken : diffText;
    return { speaker, text };
  }

  const m = (fullText || "").match(/^(.{1,40})[:：]\s*(.+)$/);
  if (m) {
    const speaker = m[1].trim();
    const text = (diffText === fullText) ? m[2].trim() : diffText;
    return { speaker, text };
  }

  return { speaker: "", text: diffText };
}

function sendLog(diff, fullText) {
  const parsed = parseSpeakerAndText(fullText, diff);
  chrome.runtime.sendMessage({
    type: "LOG",
    meetingKey: getMeetingKey(),
    text: parsed.text,
    speaker: parsed.speaker
  });
}

function startObserver() {
  if (observer) observer.disconnect();

  observer = new MutationObserver(() => {
    try {
      const region = findCaptionRegion();
      if (!region) return;

      const current = region.innerText.replace(/\n+/g, " ").trim();
      if (!current || current === lastText) return;

      let diff = current;
      if (current.startsWith(lastText)) diff = current.slice(lastText.length).trim();

      if (diff) {
        console.log("🗣", diff);
        sendLog(diff, current);
      }
      lastText = current;
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
  // 退出/通話終了ボタンが消えたら終了扱い（雑だが実用）
  const inCall = !!document.querySelector(
    '[aria-label*="通話を終了"],[aria-label*="退出"],[data-tooltip-id*="hangup"],[aria-label*="Leave call"],[aria-label*="End call"]'
  );

  if (!inCall && !ended) {
    ended = true;
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
  startCaptionsAutoOn(); // ★字幕自動ON
  startObserver();
  startEndWatcher();
}, 2000);

// ページ離脱でも終了扱い（保険）
window.addEventListener("beforeunload", () => {
  if (ended) return;
  ended = true;
  chrome.runtime.sendMessage({ type: "MEETING_ENDED", meetingKey: getMeetingKey() });
});
