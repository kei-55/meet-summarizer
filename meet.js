console.log("Meet Caption Logger loaded");

let lastText = "";
let observer = null;

function startObserver() {
  if (observer) observer.disconnect();

  observer = new MutationObserver(() => {
    try {
      const region = document.querySelector(
        'div[role="region"][aria-label="字幕"]'
      );
      if (!region) return;

      const current = region.innerText
        .replace(/\n+/g, " ")
        .trim();

      if (!current || current === lastText) return;

      let diff = current;
      if (current.startsWith(lastText)) {
        diff = current.slice(lastText.length).trim();
      }

      if (diff) {
        chrome.runtime.sendMessage({
          type: "LOG",
          text: diff
        });
        console.log("🗣 発言:", diff);
      }

      lastText = current;
    } catch (e) {
      // コンテキスト破棄時の保険
      console.warn("Observer stopped:", e.message);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// MeetはDOM再構築が頻繁なので少し待つ
setTimeout(startObserver, 2000);
